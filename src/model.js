'use strict';

const path = require('path');
const { readConfig, scanProject } = require('./project');
const { generateModelSql, insertDependency } = require('./sqlgen');
const { layeredLayout, placeNew } = require('./layout');

const STATE_FILE = '.dbtflow.json';
const NAME_RE = /^[a-z_][a-z0-9_]*$/;
const MAX_HISTORY = 200;
const REAL_KINDS = new Set(['model', 'seed', 'snapshot', 'source']);

const clone = (o) => JSON.parse(JSON.stringify(o));

// Usual dbt layer folder names, in the order data flows through them.
const LAYER_FOLDERS = [
  [1, /^(stag|stg|base|src|source|raw|landing|bronze)/],
  [2, /^(int|intermediate|prep|transform|silver|clean)/],
  [3, /^(mart|report|fact|dim|core|gold|presentation|analytics|serving)/],
];
const emptyState = () => ({ version: 1, direction: 'LR', positions: {}, planned: {}, plannedEdges: [], hidden: {} });
const DIRECTIONS = { LR: 'left to right', TB: 'top to bottom' };

/**
 * Everything the canvas shows and every change it can make, independent of
 * VS Code so it can be tested on its own. All file access goes through `io`.
 *
 * io: { exists, isDir, readText (null if missing), listDir, writeText (creates
 *       parent folders), remove, isDirty (unsaved editor changes) }
 */
class FlowModel {
  constructor(io) {
    this.io = io;
    this.cfg = null;
    this.scan = null;
    this.state = emptyState();
    this.nodes = new Map();
    this.edges = [];
    this.undoStack = [];
    this.redoStack = [];
  }

  // ---------------------------------------------------------------- loading

  open(root) {
    this.cfg = readConfig(root, this.io);
    this.statePath = path.join(root, STATE_FILE);
    const raw = this.io.readText(this.statePath);
    this.lastSavedText = raw;
    this.loadError = null;
    this.state = emptyState();
    if (raw) {
      try {
        this.state = Object.assign(emptyState(), JSON.parse(raw));
      } catch (e) {
        this.loadError = `${STATE_FILE} could not be read (${e.message}). Starting with a fresh layout.`;
      }
    }
    // Files from 0.2 may carry "home" spots from the old lock mode; boxes now move freely.
    for (const p of Object.values(this.state.positions)) delete p.home;
    this.undoStack = [];
    this.redoStack = [];
    this.refresh();
  }

  refresh() {
    if (!this.cfg) return;
    // dbt_project.yml may have changed model-paths, or a models folder may have appeared.
    this.cfg = readConfig(this.cfg.root, this.io);
    this.scan = scanProject(this.cfg, this.io);
    this.rebuild();
  }

  rebuild() {
    const nodes = new Map();
    const { models, seeds, snapshots } = this.scan;
    for (const m of models.values()) nodes.set(m.name, { ...m, id: m.name });
    for (const s of snapshots.values()) if (!nodes.has(s.name)) nodes.set(s.name, { ...s, id: s.name, group: '' });
    for (const s of seeds.values()) if (!nodes.has(s.name)) nodes.set(s.name, { ...s, id: s.name, group: '' });
    for (const [name, spec] of Object.entries(this.state.planned)) {
      if (nodes.has(name)) continue; // a file with this name exists now
      nodes.set(name, {
        id: name, name, kind: 'planned', modelDir: spec.modelDir, folder: spec.folder || '',
        group: spec.folder ? spec.folder.split('/')[0] : '',
      });
    }

    const edges = [];
    const seen = new Set();
    const addEdge = (from, to, planned) => {
      const key = from + '\u0000' + to;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ from, to, planned });
    };
    for (const n of [...nodes.values()]) {
      if (n.kind !== 'model' && n.kind !== 'snapshot') continue;
      for (const s of n.sources || []) {
        const id = 'source:' + s;
        if (!nodes.has(id)) {
          const [source, table] = s.split('.');
          nodes.set(id, { id, name: table, kind: 'source', source, table, folder: source, group: '' });
        }
        addEdge(id, n.id, false);
      }
      for (const r of n.refs || []) {
        if (!nodes.has(r)) nodes.set(r, { id: r, name: r, kind: 'missing', folder: '', group: '' });
        addEdge(r, n.id, false);
      }
    }
    for (const e of this.state.plannedEdges) {
      if (nodes.has(e.from) && nodes.has(e.to)) addEdge(e.from, e.to, true);
    }

    this.nodes = nodes;
    this.edges = edges;
    this.assignMissingPositions();
  }

  assignMissingPositions() {
    const pos = this.state.positions;
    const ids = [...this.nodes.keys()];
    const known = ids.filter((id) => pos[id]);
    if (!known.length && ids.length) {
      const laid = this.layout(ids);
      for (const id of ids) pos[id] = laid[id];
      return;
    }
    // Place newcomers upstream-first so each one lands next to its parents.
    const missing = new Set(ids.filter((id) => !pos[id]));
    let guard = missing.size + 1;
    while (missing.size && guard-- > 0) {
      for (const id of [...missing]) {
        const waiting = this.edges.some((e) => e.to === id && missing.has(e.from));
        if (waiting && guard > 0) continue;
        const flat = {};
        for (const [k, v] of Object.entries(pos)) if (this.nodes.has(k)) flat[k] = v;
        pos[id] = placeNew(id, this.edges, flat, this.direction());
        missing.delete(id);
      }
    }
  }

  /**
   * Column hint from the folder a model lives in (null when the folder is not
   * a known dbt layer). Sources, seeds and snapshots come first.
   */
  layerHint(id) {
    const n = this.nodes.get(id);
    if (!n) return null;
    if (n.kind === 'source' || n.kind === 'seed' || n.kind === 'snapshot') return 0;
    if (n.kind === 'missing') return 0; // placed next to whatever uses it
    const folder = (n.group || '').toLowerCase();
    const hit = folder && LAYER_FOLDERS.find(([, re]) => re.test(folder));
    return hit ? hit[0] : null;
  }

  layout(ids) {
    const hints = new Map(ids.map((id) => [id, this.layerHint(id)]));
    // Models outside a layer folder share the first model layer in use.
    const modelHints = ids
      .filter((id) => ['model', 'planned'].includes(this.nodes.get(id)?.kind) && hints.get(id) !== null)
      .map((id) => hints.get(id));
    const firstModelLayer = modelHints.length ? Math.min(...modelHints) : 0;
    return layeredLayout(
      ids,
      this.edges,
      (id) => this.sortKey(id),
      (id) => hints.get(id) ?? firstModelLayer,
      this.direction()
    );
  }

  /** 'LR' (left to right) or 'TB' (top to bottom, downstream below). */
  direction() {
    return this.state.direction === 'TB' ? 'TB' : 'LR';
  }

  /** Switches the flow direction and lays out the boxes on the canvas again. One undo step. */
  setDirection(direction) {
    if (!DIRECTIONS[direction]) return { ok: false, message: `Unknown direction ${direction}.` };
    if (direction === this.direction()) return { ok: true };
    return this.transact(`Flow ${DIRECTIONS[direction]}`, () => {
      this.state.direction = direction;
      const ids = [...this.nodes.values()].filter((n) => !this.isHidden(n)).map((n) => n.id);
      const laid = this.layout(ids);
      for (const id of ids) this.state.positions[id] = laid[id];
    });
  }

  sortKey(id) {
    const n = this.nodes.get(id);
    const kindRank = { source: 0, seed: 1, snapshot: 2 }[n.kind] ?? 3;
    return `${kindRank}|${n.group || ''}|${n.name}`;
  }

  saveState() {
    const out = {
      version: 1,
      direction: this.direction(),
      positions: {},
      planned: this.state.planned,
      plannedEdges: this.state.plannedEdges,
      hidden: {},
    };
    // Keep positions only for nodes that still exist, so the file stays tidy.
    for (const [id, p] of Object.entries(this.state.positions)) {
      if (this.nodes.has(id) || this.state.planned[id]) out.positions[id] = p;
    }
    for (const [id, kind] of Object.entries(this.state.hidden || {})) {
      if (this.nodes.has(id)) out.hidden[id] = kind;
    }
    this.lastSavedText = JSON.stringify(out, null, 2) + '\n';
    this.io.writeText(this.statePath, this.lastSavedText);
  }

  /** True when .dbtflow.json on disk differs from what we last wrote (e.g. after git pull). */
  stateChangedOnDisk() {
    const raw = this.io.readText(this.statePath);
    return raw !== null && raw !== this.lastSavedText;
  }

  // ---------------------------------------------------------------- view

  /**
   * A box removed from the canvas stays hidden only while it is the same kind
   * of thing: a hidden red box comes back if a model with that name is created,
   * and a hidden model comes back red if its file is deleted while still used.
   */
  isHidden(n) {
    return !!n && (this.state.hidden || {})[n.id] === n.kind;
  }

  getView() {
    const hiddenCount = [...this.nodes.values()].filter((n) => this.isHidden(n)).length;
    const nodes = [...this.nodes.values()].filter((n) => !this.isHidden(n)).map((n) => {
      const p = this.state.positions[n.id] || { x: 0, y: 0 };
      return {
        id: n.id,
        name: n.name,
        kind: n.kind,
        folder: n.folder || '',
        group: n.group || '',
        rel: n.rel || null,
        materialized: n.materialized || null,
        language: n.language || null,
        x: p.x,
        y: p.y,
        // For a missing model: the files that still ref() it.
        usedBy: n.kind === 'missing' ? this.referencesTo(n.id).map((m) => m.rel) : undefined,
      };
    });
    return {
      project: this.cfg && {
        name: this.cfg.projectName,
        hasProject: this.cfg.hasProject,
        modelDirs: this.cfg.modelDirs.map((d) => d.rel),
        modelDirExists: this.cfg.modelDirs.some((d) => d.exists),
      },
      nodes,
      edges: this.edges.filter((e) => !this.isHidden(this.nodes.get(e.from)) && !this.isHidden(this.nodes.get(e.to))),
      plannedCount: nodes.filter((n) => n.kind === 'planned').length,
      hiddenCount,
      direction: this.direction(),
      duplicates: this.scan ? this.scan.duplicates : [],
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : null,
      redoLabel: this.redoStack.length ? this.redoStack[this.redoStack.length - 1].label : null,
    };
  }

  // ---------------------------------------------------------------- history

  /**
   * Runs `fn` as one undoable step. `fn` gets `write(abs, text)` for file
   * changes (text null deletes the file); if it returns { ok: false } or
   * throws, everything is rolled back.
   */
  transact(label, fn) {
    const before = clone(this.state);
    const files = [];
    const write = (abs, text) => {
      files.push({ abs, before: this.io.readText(abs), after: text });
      if (text === null) this.io.remove(abs);
      else this.io.writeText(abs, text);
    };
    const rollback = () => {
      for (const f of [...files].reverse()) {
        if (f.before === null) this.io.remove(f.abs);
        else this.io.writeText(f.abs, f.before);
      }
      this.state = before;
    };
    let result;
    try {
      result = fn(write) || { ok: true };
    } catch (e) {
      rollback();
      this.refresh();
      return { ok: false, message: e.message };
    }
    if (result.ok === false) {
      rollback();
      this.refresh();
      return result;
    }
    // One entry per file: content before the first write, after the last.
    const collapsed = new Map();
    for (const f of files) {
      if (!collapsed.has(f.abs)) collapsed.set(f.abs, { abs: f.abs, before: f.before, after: f.after });
      else collapsed.get(f.abs).after = f.after;
    }
    const after = clone(this.state);
    if (JSON.stringify(before) === JSON.stringify(after) && !files.length) return result;
    this.undoStack.push({ label, before, after, files: [...collapsed.values()] });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.refresh();
    this.saveState();
    return result;
  }

  undo() {
    return this.step(this.undoStack, this.redoStack, 'before', 'after', 'Undo');
  }

  redo() {
    return this.step(this.redoStack, this.undoStack, 'after', 'before', 'Redo');
  }

  step(from, to, target, expected, verb) {
    const entry = from[from.length - 1];
    if (!entry) return { ok: false, quiet: true, message: `Nothing to ${verb.toLowerCase()}.` };
    for (const f of entry.files) {
      const rel = path.relative(this.cfg.root, f.abs);
      if (this.io.isDirty(f.abs)) {
        return { ok: false, message: `${verb} needs ${rel} saved first: it has unsaved changes in the editor.` };
      }
      if (this.io.readText(f.abs) !== f[expected]) {
        return {
          ok: false,
          message: `${rel} was edited after "${entry.label}", so ${verb.toLowerCase()} would overwrite your changes. Edit the file by hand instead.`,
        };
      }
    }
    from.pop();
    for (const f of entry.files) {
      if (f[target] === null) this.io.remove(f.abs);
      else this.io.writeText(f.abs, f[target]);
    }
    this.state = clone(entry[target]);
    to.push(entry);
    this.refresh();
    this.saveState();
    return { ok: true, message: `${verb}: ${entry.label}` };
  }

  // ---------------------------------------------------------------- names & folders

  validateName(name, ignore) {
    if (!name) return 'Give the box a name.';
    if (!NAME_RE.test(name)) return 'Use lowercase letters, numbers and underscores, e.g. stg_orders.';
    if (name !== ignore && this.nodes.has(name) && this.nodes.get(name).kind !== 'missing') {
      return `There is already a model called ${name}. dbt model names must be unique.`;
    }
    return null;
  }

  /** Every place a new box can go: the models folder itself and each subfolder. */
  folderChoices() {
    const dirs = this.cfg.modelDirs.filter((d) => d.exists);
    const roots = (dirs.length ? dirs : [this.cfg.modelDirs[0]]).map((d) => d.rel);
    const choices = roots.map((modelDir) => ({ modelDir, folder: '' }));
    for (const f of this.scan.folders) choices.push(f);
    for (const spec of Object.values(this.state.planned)) {
      if (spec.folder && !choices.some((c) => c.modelDir === spec.modelDir && c.folder === spec.folder)) {
        choices.push({ modelDir: spec.modelDir, folder: spec.folder });
      }
    }
    return choices;
  }

  /** Guesses a folder from dbt naming conventions (stg_, int_, fct_, dim_ ...). */
  suggestFolder(name, choices) {
    const rules = [
      [/^(stg|base|src)_/, /^(stag|base|src|source|raw)/],
      [/^int_/, /^(int|intermediate)/],
      [/^(fct|dim|rpt|mart|agg)_/, /^(mart|report|fact|dim|core|gold|presentation)/],
    ];
    for (const [prefix, folderRe] of rules) {
      if (!prefix.test(name)) continue;
      const hit = choices.findIndex((c) => c.folder && folderRe.test(c.folder.split('/')[0].toLowerCase()));
      if (hit >= 0) return hit;
    }
    return 0;
  }

  // ---------------------------------------------------------------- boxes

  createBox(name, place, x, y) {
    const err = this.validateName(name);
    if (err) return { ok: false, message: err };
    return this.transact(`Create box ${name}`, () => {
      this.state.planned[name] = { modelDir: place.modelDir, folder: place.folder || '' };
      this.state.positions[name] = { x: Math.round(x), y: Math.round(y) };
      return { ok: true, id: name };
    });
  }

  renameBox(id, newName) {
    const n = this.nodes.get(id);
    if (!n || n.kind !== 'planned') return { ok: false, message: 'Only boxes without a file can be renamed here.' };
    if (newName === id) return { ok: true };
    const err = this.validateName(newName, id);
    if (err) return { ok: false, message: err };
    return this.transact(`Rename ${id} to ${newName}`, () => {
      const s = this.state;
      s.planned[newName] = s.planned[id];
      delete s.planned[id];
      s.positions[newName] = s.positions[id];
      delete s.positions[id];
      for (const e of s.plannedEdges) {
        if (e.from === id) e.from = newName;
        if (e.to === id) e.to = newName;
      }
      return { ok: true, id: newName };
    });
  }

  setFolder(id, place) {
    const n = this.nodes.get(id);
    if (!n || n.kind !== 'planned') return { ok: false, message: 'Only boxes without a file can change folder here.' };
    const label = place.folder ? `${place.modelDir}/${place.folder}` : place.modelDir;
    return this.transact(`Move ${id} to ${label}`, () => {
      this.state.planned[id] = { modelDir: place.modelDir, folder: place.folder || '' };
    });
  }

  deleteBox(id) {
    const n = this.nodes.get(id);
    if (!n || n.kind !== 'planned') {
      return { ok: false, message: `${id} has a file. Delete the file to remove it from the canvas.` };
    }
    return this.transact(`Delete box ${id}`, () => {
      const s = this.state;
      delete s.planned[id];
      delete s.positions[id];
      s.plannedEdges = s.plannedEdges.filter((e) => e.from !== id && e.to !== id);
    });
  }

  /**
   * Removes a box from the canvas without touching any file. Boxes without a
   * file are deleted for real (see deleteBox); everything else is hidden.
   */
  removeFromCanvas(id) {
    const n = this.nodes.get(id);
    if (!n) return { ok: false, message: `${id} is not on the canvas.` };
    if (n.kind === 'planned') return this.deleteBox(id);
    return this.transact(`Remove ${n.name} from canvas`, () => {
      this.state.hidden = this.state.hidden || {};
      this.state.hidden[id] = n.kind;
      return { ok: true, kind: n.kind, usedBy: n.kind === 'missing' ? this.referencingFiles(id).map((f) => f.rel) : [] };
    });
  }

  showHidden() {
    const ids = [...this.nodes.values()].filter((n) => this.isHidden(n)).map((n) => n.id);
    if (!ids.length) return { ok: true };
    return this.transact(`Show ${ids.length} hidden box${ids.length > 1 ? 'es' : ''}`, () => {
      for (const id of ids) delete this.state.hidden[id];
    });
  }

  // ---------------------------------------------------------------- positions

  /** Every box moves freely; each move is one undo step. Moving never changes SQL. */
  moveNode(id, x, y) {
    const p = this.state.positions[id];
    if (!this.nodes.has(id) || !p) return { ok: false, message: `${id} is not on the canvas.` };
    return this.transact(`Move ${id}`, () => {
      p.x = Math.round(x);
      p.y = Math.round(y);
    });
  }

  /** Gives the position and planned connections of `oldId` to `newId`. */
  moveIdentity(oldId, newId) {
    const s = this.state;
    if (s.positions[oldId]) s.positions[newId] = s.positions[oldId];
    delete s.positions[oldId];
    if (s.hidden && s.hidden[oldId]) {
      s.hidden[newId] = s.hidden[oldId];
      delete s.hidden[oldId];
    }
    for (const e of s.plannedEdges) {
      if (e.from === oldId) e.from = newId;
      if (e.to === oldId) e.to = newId;
    }
  }

  // ---------------------------------------------------------------- renaming models with files

  /** Models and snapshots whose SQL has ref() to `name`. */
  referencesTo(name) {
    return [...this.nodes.values()].filter(
      (n) => (n.kind === 'model' || n.kind === 'snapshot') && n.refs && n.refs.includes(name)
    );
  }

  /** Files to rewrite when `name` changes, one entry per file. */
  referencingFiles(name, except) {
    const byAbs = new Map();
    for (const n of this.referencesTo(name)) if (n.abs !== except) byAbs.set(n.abs, n.rel);
    return [...byAbs.entries()].map(([abs, rel]) => ({ abs, rel }));
  }

  /**
   * Renames a model's file and updates every ref() to it, as one undo step.
   * The box keeps its place on the canvas.
   */
  renameModel(id, newName) {
    const n = this.nodes.get(id);
    if (!n || n.kind !== 'model') return { ok: false, message: `${id} is not a model with a file.` };
    if (newName === id) return { ok: true };
    const err = this.validateName(newName, id);
    if (err) return { ok: false, message: err };
    const ext = path.extname(n.abs);
    const newAbs = path.join(path.dirname(n.abs), newName + ext);
    if (this.io.exists(newAbs)) return { ok: false, message: `${path.relative(this.cfg.root, newAbs)} already exists.` };
    const files = this.referencingFiles(id, n.abs);
    for (const f of [{ abs: n.abs, rel: n.rel }, ...files]) {
      if (this.io.isDirty(f.abs)) return { ok: false, message: `Save ${f.rel} first: it has unsaved changes.` };
    }
    return this.transact(`Rename ${id} to ${newName}`, (write) => {
      write(newAbs, this.io.readText(n.abs));
      write(n.abs, null);
      for (const f of files) write(f.abs, replaceRefs(this.io.readText(f.abs), id, newName));
      this.moveIdentity(id, newName);
      return { ok: true, id: newName, oldAbs: n.abs, newAbs, updated: files.map((f) => f.rel) };
    });
  }

  /** Points every ref('oldName') at `newName` instead. One undo step. */
  retargetRefs(oldName, newName) {
    if (oldName === newName) return { ok: true };
    if (!this.nodes.has(newName) || this.nodes.get(newName).kind === 'missing') {
      return { ok: false, message: `There is no model called ${newName}.` };
    }
    const files = this.referencingFiles(oldName);
    if (!files.length) return { ok: false, quiet: true, message: `Nothing uses ref('${oldName}').` };
    for (const f of files) {
      if (this.io.isDirty(f.abs)) return { ok: false, message: `Save ${f.rel} first: it has unsaved changes.` };
    }
    return this.transact(`Point ref('${oldName}') to ${newName}`, (write) => {
      for (const f of files) write(f.abs, replaceRefs(this.io.readText(f.abs), oldName, newName));
      return { ok: true, updated: files.map((f) => f.rel) };
    });
  }

  /**
   * Called after a model file was renamed outside the canvas (e.g. in Explorer).
   * The new name takes over the old box's place. Returns the files that still
   * ref() the old name, so the caller can offer to update them.
   */
  fileRenamed(oldAbs, newAbs) {
    const nameOf = (abs) => {
      const ext = path.extname(abs).toLowerCase();
      if (ext !== '.sql' && ext !== '.py') return null;
      const inModels = this.cfg.modelDirs.some((d) => !path.relative(d.abs, abs).startsWith('..'));
      return inModels ? path.basename(abs, path.extname(abs)) : null;
    };
    const oldName = nameOf(oldAbs);
    const newName = nameOf(newAbs);
    if (!oldName || !newName || oldName === newName) return null;
    this.moveIdentity(oldName, newName);
    this.refresh();
    this.saveState();
    return { oldName, newName, usedBy: this.referencingFiles(oldName).map((f) => f.rel) };
  }

  /** Lays out the boxes on the canvas left to right. Removed boxes keep their old spot. */
  tidy() {
    const ids = [...this.nodes.values()].filter((n) => !this.isHidden(n)).map((n) => n.id);
    const laid = this.layout(ids);
    return this.transact('Tidy up layout', () => {
      for (const id of ids) this.state.positions[id] = laid[id];
    });
  }

  /**
   * Re-reads every file, puts every model, source, seed and snapshot on the
   * canvas (including boxes removed earlier) and lays them all out. One undo step.
   */
  syncFromFiles() {
    this.refresh();
    const ids = [...this.nodes.keys()];
    const laid = this.layout(ids);
    const nodes = [...this.nodes.values()];
    const summary = {
      models: nodes.filter((n) => n.kind === 'model').length,
      sources: nodes.filter((n) => n.kind === 'source').length,
      seeds: nodes.filter((n) => n.kind === 'seed').length,
      snapshots: nodes.filter((n) => n.kind === 'snapshot').length,
      missing: nodes.filter((n) => n.kind === 'missing').map((n) => n.id),
      connections: this.edges.filter((e) => !e.planned).length,
    };
    const result = this.transact('Sync with files', () => {
      this.state.hidden = {};
      for (const id of ids) this.state.positions[id] = laid[id];
      return { ok: true, summary };
    });
    // Nothing moved and nothing was hidden: still report what was found.
    return result.summary ? result : { ok: true, summary };
  }

  // ---------------------------------------------------------------- connections

  reaches(start, goal) {
    const stack = [start];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (id === goal) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of this.edges) if (e.from === id) stack.push(e.to);
    }
    return false;
  }

  /** Checks a connection without making it. Says whether a file would change. */
  planConnect(fromId, toId) {
    const from = this.nodes.get(fromId);
    const to = this.nodes.get(toId);
    if (!from || !to) return { ok: false, message: 'One of the boxes no longer exists.' };
    if (fromId === toId) return { ok: false, message: 'A box cannot depend on itself.' };
    if (this.edges.some((e) => e.from === fromId && e.to === toId)) {
      return { ok: false, quiet: true, message: `${to.name} already depends on ${from.name}.` };
    }
    if (to.kind === 'source' || to.kind === 'seed') {
      return { ok: false, message: `${to.name} is a ${to.kind}, so nothing can flow into it.` };
    }
    if (to.kind === 'missing' || from.kind === 'missing') {
      return { ok: false, message: 'Missing models (red) cannot be connected. Create the model first.' };
    }
    if (this.reaches(toId, fromId)) {
      return { ok: false, message: `That would create a loop: ${from.name} already depends on ${to.name}.` };
    }
    const fileEdit = REAL_KINDS.has(from.kind) && (to.kind === 'model' || to.kind === 'snapshot');
    if (fileEdit) {
      if (to.kind === 'snapshot') return { ok: false, message: 'Add dependencies to snapshots by hand for now.' };
      if (to.language === 'python') return { ok: false, message: `Add dbt.ref("${from.name}") to ${to.rel} by hand for now.` };
      if (this.io.isDirty(to.abs)) return { ok: false, message: `Save ${to.rel} first: it has unsaved changes.` };
    }
    return { ok: true, fileEdit, rel: fileEdit ? to.rel : null, from, to };
  }

  connect(fromId, toId) {
    const plan = this.planConnect(fromId, toId);
    if (!plan.ok) return plan;
    const { from, to } = plan;
    return this.transact(`Connect ${from.name} to ${to.name}`, (write) => {
      if (plan.fileEdit) {
        const sql = this.io.readText(to.abs) || '';
        const { sql: next, changed } = insertDependency(sql, depFor(from));
        if (changed) write(to.abs, next);
      } else {
        this.state.plannedEdges.push({ from: fromId, to: toId });
      }
    });
  }

  disconnect(fromId, toId) {
    const idx = this.state.plannedEdges.findIndex((e) => e.from === fromId && e.to === toId);
    if (idx < 0) {
      const to = this.nodes.get(toId);
      return {
        ok: false,
        fileEdge: true,
        rel: to && to.rel,
        message: `This connection is written in ${to && to.rel}. Remove the ref there to disconnect.`,
      };
    }
    return this.transact(`Disconnect ${fromId} from ${toId}`, () => {
      this.state.plannedEdges.splice(idx, 1);
    });
  }

  // ---------------------------------------------------------------- files

  targetPath(name) {
    const spec = this.state.planned[name];
    const dir = this.cfg.modelDirs.find((d) => d.rel === spec.modelDir) || this.cfg.modelDirs[0];
    return path.join(dir.abs, ...(spec.folder ? spec.folder.split('/') : []), name + '.sql');
  }

  createFiles(ids) {
    const names = ids.filter((id) => this.nodes.get(id) && this.nodes.get(id).kind === 'planned');
    if (!names.length) return { ok: false, message: 'There are no boxes without a file.' };
    for (const name of names) {
      const abs = this.targetPath(name);
      if (this.io.exists(abs)) {
        return { ok: false, message: `${path.relative(this.cfg.root, abs)} already exists.` };
      }
    }
    const label = names.length === 1 ? `Create file ${names[0]}.sql` : `Create ${names.length} files`;
    const created = [];
    return this.transact(label, (write) => {
      // Upstream first, so a model's refs point at files created earlier in the batch.
      const order = names.slice().sort((a, b) => this.depth(a) - this.depth(b));
      for (const name of order) {
        const deps = this.state.plannedEdges
          .filter((e) => e.to === name)
          .map((e) => this.nodes.get(e.from))
          .filter(Boolean)
          .sort((a, b) => (this.state.positions[a.id]?.y ?? 0) - (this.state.positions[b.id]?.y ?? 0))
          .map(depFor);
        const abs = this.targetPath(name);
        write(abs, generateModelSql(deps));
        created.push(abs);

        // Downstream models that already have files get the new ref added now.
        for (const e of this.state.plannedEdges.filter((x) => x.from === name)) {
          const down = this.nodes.get(e.to);
          if (down && down.kind === 'model' && down.language !== 'python') {
            if (this.io.isDirty(down.abs)) throw new Error(`Save ${down.rel} first: it has unsaved changes.`);
            const { sql, changed } = insertDependency(this.io.readText(down.abs) || '', { kind: 'ref', name });
            if (changed) write(down.abs, sql);
            e.done = true;
          }
        }
        this.state.plannedEdges = this.state.plannedEdges.filter((x) => x.to !== name && !x.done);
        delete this.state.planned[name];
      }
      return { ok: true, created };
    });
  }

  depth(id) {
    let d = 0;
    let frontier = [id];
    const seen = new Set();
    while (frontier.length && d < 1000) {
      const next = [];
      for (const n of frontier) {
        for (const e of this.edges) if (e.to === n && !seen.has(e.from)) { seen.add(e.from); next.push(e.from); }
      }
      if (next.length) d++;
      frontier = next;
    }
    return d;
  }

  absPath(id) {
    const n = this.nodes.get(id);
    return n && n.abs ? n.abs : null;
  }
}

/** Rewrites ref('old') and ref('pkg', 'old') to the new name, keeping the quote style. */
function replaceRefs(sql, oldName, newName) {
  const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(\\bref\\s*\\(\\s*(?:['"][^'"]+['"]\\s*,\\s*)?)(['"])${esc}\\2`, 'g');
  return sql.replace(re, (_, head, q) => `${head}${q}${newName}${q}`);
}

function depFor(node) {
  return node.kind === 'source'
    ? { kind: 'source', source: node.source, table: node.table }
    : { kind: 'ref', name: node.name };
}

module.exports = { FlowModel, STATE_FILE };
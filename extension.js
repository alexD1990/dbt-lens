'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FlowModel } = require('./src/model');
const { createNodeIO } = require('./src/nodeio');
const { findProjectRoots } = require('./src/project');
const { importAliases, boxIdOf } = require('./src/aliases');
const dbtrun = require('./src/dbtrun');

const COLUMN_AT_CURSOR = /[A-Za-z_][A-Za-z0-9_$]*/;

/** Integrations that have a canvas add-on in media/integrations/<id>.js (and maybe .css). */
function integrationUis(extensionPath) {
  try {
    const names = require('./src/integrations');
    return names
      .filter((n) => /^[a-z][a-z0-9-]*$/.test(n))
      .map((n) => ({
        id: n,
        js: fs.existsSync(path.join(extensionPath, 'media', 'integrations', `${n}.js`)),
        css: fs.existsSync(path.join(extensionPath, 'media', 'integrations', `${n}.css`)),
      }))
      .filter((u) => u.js);
  } catch {
    return [];
  }
}

const PANEL_TYPE = 'dbtFlow.panel';
const STARTUP_DELAY_MS = 500;
const FOLDER_RE = /^[\w-]+(\/[\w-]+)*$/;

class Controller {
  constructor(context) {
    this.context = context;
    this.surfaces = new Set(); // { webview, kind: 'view' | 'panel', panel? }
    this.panel = null;
    this.model = null;
    this.io = createNodeIO((abs) =>
      vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.fsPath === abs)
    );
    this.refreshTimer = null;
    this.integrations = null; // IntegrationHost, or null if it could not start
    this.integrationChannels = new Map(); // integration id -> output channel
    this.integrationResults = new Map(); // "<id>/result" -> last result, replayed to a canvas that opens later
    this.dbtTerminal = null; // the "dbt Lens" terminal dbt commands are typed into
    this.dbtTerminalRoot = null; // the folder that terminal is in
  }

  // ------------------------------------------------------------ project

  loadProject(forceRoot) {
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    if (!folders.length) {
      this.model = null;
      return;
    }
    let root = forceRoot;
    if (!root) {
      const configured = vscode.workspace.getConfiguration('dbtFlow').get('projectPath');
      if (configured) {
        root = path.isAbsolute(configured) ? configured : path.join(folders[0], configured);
      }
    }
    if (!root) {
      const roots = findProjectRoots(folders, this.io);
      const remembered = this.context.workspaceState.get('dbtFlow.root');
      root = roots.includes(remembered) ? remembered : roots[0] || folders[0];
      this.roots = roots;
    }
    this.model = new FlowModel(this.io);
    this.model.open(root);
    if (this.model.loadError) vscode.window.showWarningMessage(`dbt Lens: ${this.model.loadError}`);
  }

  async selectProject() {
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const roots = findProjectRoots(folders, this.io);
    if (!roots.length) {
      vscode.window.showInformationMessage('dbt Lens found no dbt_project.yml in this workspace.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      roots.map((r) => ({ label: path.basename(r), description: r, root: r })),
      { placeHolder: 'Which dbt project should dbt Lens show?' }
    );
    if (!pick) return;
    await this.context.workspaceState.update('dbtFlow.root', pick.root);
    this.loadProject(pick.root);
    this.broadcast();
  }

  scheduleRefresh(stateFile = false) {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      if (!this.model) return this.loadProject(), this.broadcast();
      if (stateFile && this.model.stateChangedOnDisk()) this.model.open(this.model.cfg.root);
      else this.model.refresh();
      this.broadcast();
    }, 200);
  }

  broadcast() {
    const view = this.model ? this.model.getView() : null;
    for (const s of this.surfaces) s.webview.postMessage({ type: 'graph', view });
    this.postActiveFile();
  }

  postActiveFile() {
    const ed = vscode.window.activeTextEditor;
    let id = null;
    if (ed && this.model) {
      const fsPath = ed.document.uri.fsPath;
      for (const n of this.model.nodes.values()) if (n.abs === fsPath && n.kind === 'model') id = n.id;
    }
    for (const s of this.surfaces) s.webview.postMessage({ type: 'activeFile', id });
  }

  // ------------------------------------------------------------ webviews

  attach(webview, kind, panel) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
    // Integration add-ons load before main.js, which starts them (see "integrations" in main.js).
    const uis = integrationUis(this.context.extensionUri.fsPath);
    const uiUri = (id, ext) => webview.asWebviewUri(vscode.Uri.joinPath(media, 'integrations', `${id}.${ext}`));
    const uiCss = uis.filter((u) => u.css).map((u) => `\n<link href="${uiUri(u.id, 'css')}" rel="stylesheet">`).join('');
    const uiJs = uis.map((u) => `<script nonce="${nonce}" src="${uiUri(u.id, 'js')}"></script>\n`).join('');
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">${uiCss}
<title>dbt Lens</title>
</head>
<body data-surface="${kind}">
<div id="app"></div>
${uiJs}<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    const surface = { webview, kind, panel };
    this.surfaces.add(surface);
    const sub = webview.onDidReceiveMessage((msg) =>
      this.handle(msg, surface).catch((e) => vscode.window.showErrorMessage(`dbt Lens: ${e.message}`))
    );
    return {
      dispose: () => {
        sub.dispose();
        this.surfaces.delete(surface);
      },
    };
  }

  /**
   * Opens the canvas as an editor tab in the group to the right of the code,
   * so Explorer, the file and the canvas are all visible at once.
   * On startup it opens without taking focus from the file.
   */
  openPanel({ preserveFocus = false } = {}) {
    if (this.panel) {
      this.panel.reveal(undefined, preserveFocus);
      return;
    }
    const ed = vscode.window.activeTextEditor;
    const column = ed && ed.viewColumn ? ed.viewColumn + 1 : vscode.ViewColumn.Two;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      PANEL_TYPE,
      'dbt Lens',
      { viewColumn: column, preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] }
    );
    panel.iconPath = {
      dark: vscode.Uri.joinPath(media, 'icon.svg'),
      light: vscode.Uri.joinPath(media, 'icon-light.svg'),
    };
    const handle = this.attach(panel.webview, 'panel', panel);
    this.panel = panel;
    panel.onDidDispose(() => {
      handle.dispose();
      this.panel = null;
    });
  }

  // ------------------------------------------------------------ integrations

  /**
   * Starts the optional integrations (DAGtracer, ...). See docs/ARCHITECTURE.md.
   * If anything here fails, integrations stay off and the canvas works as before.
   */
  startIntegrations() {
    try {
      const { IntegrationHost } = require('./src/host/integrationHost');
      const names = require('./src/integrations');
      this.integrations = new IntegrationHost({
        projectRoot: () => (this.model && this.model.cfg ? this.model.cfg.root : null),
        view: () => (this.model ? this.model.getView() : null),
        post: (msg) => {
          if (/^[a-z][a-z0-9-]*\/result$/.test(msg.type)) this.integrationResults.set(msg.type, msg);
          for (const s of this.surfaces) s.webview.postMessage(msg);
        },
        setting: (id, key) => vscode.workspace.getConfiguration('dbtFlow').get(`integrations.${id}.${key}`),
        ask: (o) =>
          vscode.window.showInputBox({ prompt: o.prompt, placeHolder: o.placeHolder, value: o.value, validateInput: o.validate }),
        pick: (o) => this.pickWithTyping(o),
        logger: (id, title) => {
          if (typeof vscode.window.createOutputChannel !== 'function') return () => {};
          let ch = this.integrationChannels.get(id);
          if (!ch) {
            ch = vscode.window.createOutputChannel(`dbt Lens: ${title}`);
            this.integrationChannels.set(id, ch);
            this.context.subscriptions.push(ch);
          }
          return (line) => ch.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
        },
      }).load(names);
      this.integrations.start().catch(() => {});
    } catch (e) {
      this.integrations = null;
      console.error(`dbt Lens: integrations are off (${e.message})`);
    }
  }

  /** Re-checks every integration and lists them; picking one opens its log. */
  async checkIntegrations() {
    if (!this.integrations) {
      vscode.window.showWarningMessage('dbt Lens: integrations could not be started. See Help → Toggle Developer Tools → Console.');
      return;
    }
    const list = await this.integrations.recheck();
    const icons = { ready: '$(pass)', missing: '$(circle-slash)', incompatible: '$(warning)', failed: '$(error)', disabled: '$(debug-pause)' };
    const items = list.map((s) => ({
      label: `${icons[s.state] || '$(question)'} ${s.title}`,
      description: s.state + (s.version ? ` · ${s.version}` : ''),
      detail: s.reason || undefined,
      id: s.id,
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'dbt Lens integrations. Pick one to open its log.' });
    const ch = pick && this.integrationChannels.get(pick.id);
    if (ch) ch.show(true);
  }

  /**
   * A quick pick that also accepts a typed value that is not in the list,
   * e.g. a column the catalog does not know yet. Resolves the label or undefined.
   */
  pickWithTyping({ title, placeHolder, items = [], allowTyped = false }) {
    return new Promise((resolve) => {
      const qp = vscode.window.createQuickPick();
      const base = items.map((i) => ({ label: i.label, description: i.description || '' }));
      qp.title = title;
      qp.placeholder = placeHolder;
      qp.items = base;
      if (allowTyped) {
        qp.onDidChangeValue((v) => {
          const typed = v.trim();
          const known = base.some((i) => i.label.toLowerCase() === typed.toLowerCase());
          qp.items = typed && !known && COLUMN_AT_CURSOR.test(typed) ? [{ label: typed, description: 'not in the catalog' }, ...base] : base;
        });
      }
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        qp.dispose();
        resolve(value);
      };
      qp.onDidAccept(() => finish(qp.selectedItems[0] ? qp.selectedItems[0].label : undefined));
      qp.onDidHide(() => finish(undefined));
      qp.show();
    });
  }

  /**
   * Right-click on a column in a model's SQL → Trace Column. For `prep1.order_id`
   * the trace starts at the model behind `prep1` (an import CTE or an alias of
   * ref()); otherwise at the model the file belongs to.
   */
  async traceColumnAtCursor() {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !this.model) return;
    if (!this.integrations || !this.integrations.isReady('dagtracer')) {
      vscode.window.showWarningMessage('dbt Lens: DAGtracer is not ready. Run "dbt Lens: Check Integrations" to see why.');
      return;
    }
    const doc = ed.document;
    const range = doc.getWordRangeAtPosition(ed.selection.active, COLUMN_AT_CURSOR);
    if (!range) {
      vscode.window.showInformationMessage('dbt Lens: put the cursor on a column name, then Trace Column.');
      return;
    }
    const line = doc.lineAt(range.start.line).text;
    let column = doc.getText(range);
    let qualifier = null;
    const after = /^\.([A-Za-z_][A-Za-z0-9_$]*)/.exec(line.slice(range.end.character));
    const before = /([A-Za-z_][A-Za-z0-9_$]*)\.$/.exec(line.slice(0, range.start.character));
    if (after) {
      // The cursor is on "prep1" in "prep1.order_id": trace order_id.
      qualifier = column;
      column = after[1];
    } else if (before) {
      qualifier = before[1];
    }
    const own = [...this.model.nodes.values()].find((n) => n.abs === doc.uri.fsPath && n.kind === 'model');
    if (!own) {
      vscode.window.showInformationMessage('dbt Lens: this file is not a model in the open dbt project.');
      return;
    }
    let start = own.id;
    if (qualifier) {
      const dep = importAliases(doc.getText()).get(qualifier.toLowerCase());
      if (dep && this.model.nodes.has(boxIdOf(dep))) start = boxIdOf(dep);
    }
    this.openPanel({ preserveFocus: true });
    await this.integrations.handle({ type: 'dagtracer/traceBox', id: start, column });
  }

  // ------------------------------------------------------------ messages

  report(result, successMessage) {
    if (!result) return;
    if (result.ok === false && result.message && !result.quiet) {
      vscode.window.showWarningMessage(result.message);
    } else if (result.ok !== false && successMessage) {
      vscode.window.setStatusBarMessage(`dbt Lens: ${successMessage}`, 4000);
    }
    this.broadcast();
  }

  async handle(msg, surface) {
    if (msg.type === 'ready') {
      if (!this.model) this.loadProject();
      this.broadcast();
      if (this.integrations) this.integrations.announce();
      surface.webview.postMessage({ type: 'dbtCommands', project: dbtrun.PROJECT_COMMANDS, box: dbtrun.BOX_COMMANDS });
      // A canvas that opens after a trace finished still shows it.
      for (const r of this.integrationResults.values()) surface.webview.postMessage(r);
      return;
    }
    if (msg.type === 'integrationForget') {
      this.integrationResults.delete(`${msg.id}/result`);
      return;
    }
    // "<integration>/<action>" goes to the integration host, which never throws.
    if (typeof msg.type === 'string' && msg.type.includes('/')) {
      if (this.integrations) await this.integrations.handle(msg);
      return;
    }
    const m = this.model;
    if (!m) return;

    switch (msg.type) {
      case 'createBoxAt': {
        const name = await this.askName('Name of the new model', '');
        if (!name) return;
        const place = await this.pickFolder(name);
        if (!place) return;
        return this.report(m.createBox(name, place, msg.x, msg.y));
      }
      case 'planMissing': {
        const place = await this.pickFolder(msg.id);
        if (!place) return;
        const n = m.getView().nodes.find((x) => x.id === msg.id);
        return this.report(m.createBox(msg.id, place, n ? n.x : 0, n ? n.y : 0));
      }
      case 'rename': {
        const node = m.nodes.get(msg.id);
        if (!node) return;
        const name = await this.askName(`Rename ${msg.id}`, msg.id, msg.id);
        if (!name || name === msg.id) return;
        if (node.kind === 'planned') return this.report(m.renameBox(msg.id, name));
        return this.renameModel(msg.id, name);
      }
      case 'retarget':
        return this.retarget(msg.id);
      case 'removeRefs':
        return this.removeRefs(msg.id);
      case 'changeFolder': {
        const place = await this.pickFolder(msg.id, true);
        if (!place) return;
        return this.report(m.setFolder(msg.id, place));
      }
      case 'deleteBox':
        return this.report(m.deleteBox(msg.id));
      case 'removeFromCanvas':
        return this.report(m.removeFromCanvas(msg.id));
      case 'showHidden':
        return this.report(m.showHidden(), 'Removed boxes are back on the canvas');
      case 'move':
        return this.report(m.moveNode(msg.id, msg.x, msg.y));
      case 'tidy':
        return this.report(m.tidy(), 'Layout tidied. Undo puts it back.');
      case 'setDirection': {
        const r = m.setDirection(msg.direction);
        this.report(r);
        for (const s of this.surfaces) s.webview.postMessage({ type: 'fit' });
        return;
      }
      case 'sync': {
        const r = m.syncFromFiles();
        this.report(r);
        for (const s of this.surfaces) s.webview.postMessage({ type: 'synced', summary: r.summary });
        return;
      }
      case 'undo': {
        const r = m.undo();
        return this.report(r, r.ok ? r.message : null);
      }
      case 'redo': {
        const r = m.redo();
        return this.report(r, r.ok ? r.message : null);
      }
      case 'refresh':
        m.refresh();
        return this.broadcast();
      case 'connect':
        return this.connect(msg.from, msg.to);
      case 'disconnect': {
        const r = m.disconnect(msg.from, msg.to);
        if (r.fileEdge) {
          const choice = await vscode.window.showInformationMessage(r.message, 'Open file');
          if (choice) this.openFile(msg.to, surface);
          return;
        }
        return this.report(r);
      }
      case 'open':
        return this.openFile(msg.id, surface);
      case 'openRel': {
        const abs = path.resolve(m.cfg.root, msg.rel);
        if (path.relative(m.cfg.root, abs).startsWith('..')) return;
        return this.openPath(abs, surface);
      }
      case 'createFile': {
        const r = m.createFiles([msg.id]);
        this.report(r, `Created ${msg.id}.sql`);
        if (r.ok && vscode.workspace.getConfiguration('dbtFlow').get('openCreatedFile')) {
          this.openFile(msg.id, surface);
        }
        return;
      }
      case 'createAll': {
        const ids = m.getView().nodes.filter((n) => n.kind === 'planned').map((n) => n.id);
        const r = m.createFiles(ids);
        return this.report(r, r.ok ? `Created ${ids.length} file${ids.length > 1 ? 's' : ''}` : null);
      }
      case 'selectProject':
        return this.selectProject();
      case 'dbt':
        return this.runDbt(msg.command, msg.id || null);
    }
  }

  // ------------------------------------------------------------ dbt

  /**
   * Types a dbt command into the "dbt Lens" terminal, the same line you would type
   * yourself. With a box id it runs that box and everything upstream of it
   * (`--select +mart`); without, the whole project. Unsaved files are saved first,
   * so dbt runs what the editor shows. See src/dbtrun.js.
   */
  async runDbt(command, id) {
    const m = this.model;
    if (!m || !m.cfg) return;
    const node = id ? m.nodes.get(id) : null;
    if (id && !node) return;
    const config = vscode.workspace.getConfiguration('dbtFlow');
    const plan = dbtrun.planDbt({
      command,
      node: node && { id: node.id, name: node.name, kind: node.kind },
      executable: config.get('dbt.executable'),
      target: config.get('dbt.target'),
    });
    if (!plan.ok) {
      vscode.window.showWarningMessage(`dbt Lens: ${plan.message}`);
      return;
    }
    if (vscode.workspace.saveAll) await vscode.workspace.saveAll(false);
    const term = this.dbtTerminalFor(m.cfg.root, config.get('dbt.envFile'));
    term.show(true);
    term.sendText(plan.line);
  }

  /** The "dbt Lens" terminal in the project folder, made (and given the env file) once. */
  dbtTerminalFor(root, envFile) {
    let term = this.dbtTerminal;
    if (term && term.exitStatus === undefined) {
      if (this.dbtTerminalRoot !== root) {
        term.sendText(`cd ${dbtrun.shellWord(root)}`);
        this.dbtTerminalRoot = root;
      }
      return term;
    }
    term = vscode.window.createTerminal({ name: 'dbt Lens', cwd: root });
    const env = dbtrun.envFileLine(envFile);
    if (env) term.sendText(env);
    this.dbtTerminal = term;
    this.dbtTerminalRoot = root;
    return term;
  }

  /** Command palette: pick a dbt command for the whole project. */
  async pickDbtCommand() {
    if (!this.model) return;
    const items = dbtrun.PROJECT_COMMANDS.filter((c) => c !== '-').map((c) => ({ label: `dbt ${c.command}`, description: c.hint, command: c.command }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Run a dbt command on the whole project' });
    if (pick) await this.runDbt(pick.command, null);
  }

  async connect(from, to) {
    const m = this.model;
    const plan = m.planConnect(from, to);
    if (!plan.ok) return this.report(plan);
    const config = vscode.workspace.getConfiguration('dbtFlow');
    if (plan.fileEdit && config.get('confirmFileEdits')) {
      const expr = plan.from.kind === 'source'
        ? `{{ source('${plan.from.source}', '${plan.from.table}') }}`
        : `{{ ref('${plan.from.name}') }}`;
      const always = 'Add, and stop asking';
      const choice = await vscode.window.showInformationMessage(
        `Add ${expr} to ${plan.rel}?`,
        { modal: true, detail: 'It goes in as an import CTE at the top of the file. Undo in dbt Lens takes it out again.' },
        'Add ref',
        always
      );
      if (!choice) return this.broadcast();
      if (choice === always) await config.update('confirmFileEdits', false, vscode.ConfigurationTarget.Global);
    }
    this.report(m.connect(from, to), `Connected ${plan.from.name} to ${plan.to.name}`);
  }

  /** Asks before rewriting other files when refs point at the renamed model. */
  async confirmRefEdits(question, files) {
    const config = vscode.workspace.getConfiguration('dbtFlow');
    if (!files.length || !config.get('confirmFileEdits')) return true;
    const list = files.slice(0, 8).join('\n') + (files.length > 8 ? `\n…and ${files.length - 8} more` : '');
    const choice = await vscode.window.showInformationMessage(
      question,
      { modal: true, detail: `${list}\n\nUndo in dbt Lens changes them back.` },
      'Update refs'
    );
    return !!choice;
  }

  async renameModel(id, newName) {
    const m = this.model;
    const files = m.referencingFiles(id, m.absPath(id)).map((f) => f.rel);
    const ok = await this.confirmRefEdits(
      `Rename ${id} to ${newName} and update ref('${id}') in ${files.length} file${files.length === 1 ? '' : 's'}?`,
      files
    );
    if (!ok) return this.broadcast();
    const wasOpen = vscode.workspace.textDocuments.some((d) => d.uri.fsPath === m.absPath(id));
    const r = m.renameModel(id, newName);
    this.report(r, `Renamed ${id} to ${newName}`);
    if (r.ok && wasOpen) await this.openPath(r.newAbs, this.panelSurface());
  }

  /** For a red box: point every ref() to it at an existing model instead. */
  async retarget(missingId) {
    const m = this.model;
    const models = [...m.nodes.values()].filter((n) => n.kind === 'model').map((n) => n.name).sort();
    const pick = await vscode.window.showQuickPick(models, {
      placeHolder: `Which model should ref('${missingId}') point to?`,
    });
    if (!pick) return;
    const files = m.referencingFiles(missingId).map((f) => f.rel);
    const ok = await this.confirmRefEdits(`Change ref('${missingId}') to ref('${pick}') in ${files.length} file${files.length === 1 ? '' : 's'}?`, files);
    if (!ok) return;
    this.report(m.retargetRefs(missingId, pick), `ref('${missingId}') now points to ${pick}`);
  }

  /**
   * Red box (a ref to a model with no file): remove the import CTEs that ref()
   * it, after asking. Files that use the model further than the import are
   * not touched; dbt Lens offers to open them instead.
   */
  async removeRefs(name, { confirmed = false } = {}) {
    const m = this.model;
    const { auto, manual } = m.planRemoveRefs(name);
    if (auto.length) {
      const files = auto.map((f) => f.rel);
      const where = files.length === 1 ? files[0] : `${files.length} files`;
      const ok = confirmed || (await this.confirmRefEdits(`Remove ref('${name}') from ${where}?`, files));
      if (ok) this.report(m.removeRefs(name), `Removed ref('${name}') from ${where}`);
    }
    if (manual.length) {
      const first = manual[0];
      const others = manual.length > 1 ? ` and ${manual.length - 1} more` : '';
      const choice = await vscode.window.showWarningMessage(
        `${first.rel}${others} uses ${name} beyond the import at the top, so remove ref('${name}') there by hand.`,
        'Open file'
      );
      if (choice) await this.openPath(first.abs, this.panelSurface());
    }
  }

  /**
   * A model file was deleted in VS Code (Explorer): if other models still ref()
   * it, ask once whether to remove those refs, so no red box is left behind.
   * Deleting with rm in a terminal does not reach here; the red box's
   * "Remove ref" menu item covers that case.
   */
  async onFilesDeleted(files) {
    const m = this.model;
    if (!m) return;
    m.refresh();
    this.broadcast();
    for (const uri of files) {
      const ext = path.extname(uri.fsPath).toLowerCase();
      if (ext !== '.sql' && ext !== '.py') continue;
      const name = path.basename(uri.fsPath, ext);
      const node = m.nodes.get(name);
      if (!node || node.kind !== 'missing') continue;
      const users = m.referencingFiles(name).map((f) => f.rel);
      if (!users.length) continue;
      const who = users.length === 1 ? users[0] : `${users.length} files`;
      const choice = await vscode.window.showInformationMessage(
        `${name} was deleted, but ${who} still ${users.length === 1 ? 'uses' : 'use'} ref('${name}'). Remove the ref?`,
        { modal: true, detail: `${users.slice(0, 8).join('\n')}\n\nOnly the import CTE at the top is removed. Undo in dbt Lens puts it back.` },
        'Remove ref'
      );
      if (choice) await this.removeRefs(name, { confirmed: true });
    }
  }

  /**
   * A model file was renamed in Explorer: keep its box in place and update the
   * refs to it, asking the same way as a rename on the canvas does (a dialog,
   * or no question at all when dbtFlow.confirmFileEdits is off).
   */
  async onFilesRenamed(files) {
    const m = this.model;
    if (!m) return;
    for (const { oldUri, newUri } of files) {
      const info = m.fileRenamed(oldUri.fsPath, newUri.fsPath);
      if (!info) continue;
      this.broadcast();
      if (!info.usedBy.length) continue;
      const n = info.usedBy.length;
      const ok = await this.confirmRefEdits(
        `You renamed ${info.oldName} to ${info.newName}. Update ref('${info.oldName}') to ref('${info.newName}') in ${n} file${n === 1 ? '' : 's'}?`,
        info.usedBy
      );
      if (ok) this.report(m.retargetRefs(info.oldName, info.newName), `Updated refs to ${info.newName}`);
    }
  }

  panelSurface() {
    return [...this.surfaces].find((s) => s.panel);
  }

  openFile(id, surface) {
    const abs = this.model.absPath(id);
    if (abs) return this.openPath(abs, surface);
  }

  /**
   * Opens a file to the left of the canvas, so dbt Lens always stays on the right.
   * If the canvas is the only editor group (all files closed), the file opens in a
   * new group that is then moved to the left of the canvas.
   */
  async openPath(abs, surface) {
    const uri = vscode.Uri.file(abs);
    const col = surface && surface.panel ? surface.panel.viewColumn : undefined;
    if (!col) {
      await vscode.window.showTextDocument(uri, { preview: false });
      return;
    }
    if (col > 1) {
      await vscode.window.showTextDocument(uri, { preview: false, viewColumn: col - 1 });
      return;
    }
    const groupsBefore = vscode.window.tabGroups.all.length;
    await vscode.window.showTextDocument(uri, { preview: false, viewColumn: vscode.ViewColumn.Two });
    if (groupsBefore === 1) await vscode.commands.executeCommand('workbench.action.moveActiveEditorGroupLeft');
  }

  askName(prompt, value, ignore) {
    return vscode.window
      .showInputBox({
        prompt,
        value,
        placeHolder: 'e.g. stg_orders, int_orders_joined, fct_orders',
        validateInput: (v) => this.model.validateName(v.trim(), ignore),
      })
      .then((v) => (v ? v.trim() : v));
  }

  /** Returns { modelDir, folder } or undefined if cancelled. */
  async pickFolder(name, alwaysAsk = false) {
    const m = this.model;
    const choices = m.folderChoices();
    if (choices.length === 1 && !alwaysAsk) return choices[0];
    const suggested = m.suggestFolder(name, choices);
    const items = choices.map((c, i) => ({
      label: c.folder ? `$(folder) ${c.folder}` : `$(root-folder) ${c.modelDir}`,
      description: i === suggested && suggested !== 0 ? 'suggested from the name' : c.folder ? `${c.modelDir}/${c.folder}` : 'top of the models folder',
      choice: c,
    }));
    const ordered = [items[suggested], ...items.filter((_, i) => i !== suggested)];
    ordered.push({ label: '$(new-folder) New folder…', description: 'created when the file is created', newFolder: true });
    const pick = await vscode.window.showQuickPick(ordered, { placeHolder: `Where should ${name}.sql go?` });
    if (!pick) return undefined;
    if (!pick.newFolder) return pick.choice;
    const folder = await vscode.window.showInputBox({
      prompt: `New folder inside ${choices[0].modelDir}/`,
      placeHolder: 'e.g. staging or marts/finance',
      validateInput: (v) => (FOLDER_RE.test(v.trim()) ? null : 'Use letters, numbers, - and _; separate subfolders with /.'),
    });
    if (!folder) return undefined;
    return { modelDir: choices[0].modelDir, folder: folder.trim() };
  }
}

function activate(context) {
  const ctl = new Controller(context);

  // A status bar button to bring the canvas back after it has been closed.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.text = '$(type-hierarchy-sub) dbt Lens';
  status.tooltip = 'Open the dbt Lens canvas';
  status.command = 'dbtFlow.openPanel';
  status.show();

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand('dbtFlow.openPanel', () => ctl.openPanel()),
    vscode.commands.registerCommand('dbtFlow.refresh', () => {
      ctl.loadProject(ctl.model ? ctl.model.cfg.root : undefined);
      ctl.broadcast();
    }),
    vscode.commands.registerCommand('dbtFlow.undo', () => ctl.handle({ type: 'undo' })),
    vscode.commands.registerCommand('dbtFlow.redo', () => ctl.handle({ type: 'redo' })),
    vscode.commands.registerCommand('dbtFlow.tidy', () => ctl.handle({ type: 'tidy' })),
    vscode.commands.registerCommand('dbtFlow.createAll', () => ctl.handle({ type: 'createAll' })),
    vscode.commands.registerCommand('dbtFlow.selectProject', () => ctl.selectProject()),
    vscode.commands.registerCommand('dbtFlow.checkIntegrations', () => ctl.checkIntegrations()),
    vscode.commands.registerCommand('dbtFlow.traceColumnAtCursor', () => ctl.traceColumnAtCursor()),
    vscode.commands.registerCommand('dbtFlow.runDbt', () => ctl.pickDbtCommand()),
    { dispose: () => ctl.integrations && ctl.integrations.dispose() },
    vscode.window.onDidCloseTerminal
      ? vscode.window.onDidCloseTerminal((t) => {
          if (t === ctl.dbtTerminal) ctl.dbtTerminal = null;
        })
      : { dispose() {} },
    vscode.window.onDidChangeActiveTextEditor(() => ctl.postActiveFile()),
    vscode.workspace.onDidRenameFiles((e) =>
      ctl.onFilesRenamed(e.files).catch((err) => vscode.window.showErrorMessage(`dbt Lens: ${err.message}`))
    ),
    vscode.workspace.onDidDeleteFiles
      ? vscode.workspace.onDidDeleteFiles((e) =>
          ctl.onFilesDeleted(e.files).catch((err) => vscode.window.showErrorMessage(`dbt Lens: ${err.message}`))
        )
      : { dispose() {} },
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      ctl.loadProject();
      ctl.broadcast();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dbtFlow.projectPath')) {
        ctl.loadProject();
        ctl.broadcast();
      }
    })
  );

  // Optional tools (DAGtracer, ...). Runs in the background; the canvas never waits for it.
  ctl.startIntegrations();
  if (vscode.workspace.onDidChangeConfiguration) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('dbtFlow.integrations') && ctl.integrations) ctl.integrations.recheck();
      })
    );
  }

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{sql,py,csv,yml,yaml}');
  const onChange = () => ctl.scheduleRefresh();
  watcher.onDidCreate(onChange);
  watcher.onDidChange(onChange);
  watcher.onDidDelete(onChange);
  const stateWatcher = vscode.workspace.createFileSystemWatcher('**/.dbtflow.json');
  const onState = () => ctl.scheduleRefresh(true);
  stateWatcher.onDidChange(onState);
  stateWatcher.onDidCreate(onState);
  context.subscriptions.push(watcher, stateWatcher);

  // Open next to the code when VS Code starts, after editors have been restored.
  if (vscode.workspace.getConfiguration('dbtFlow').get('openOnStartup')) {
    const timer = setTimeout(() => {
      if (!ctl.panel) ctl.openPanel({ preserveFocus: true });
    }, STARTUP_DELAY_MS);
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
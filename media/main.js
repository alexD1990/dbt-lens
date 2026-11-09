// dbt Flow canvas. Runs inside the VS Code webview; all changes go to the extension.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const W = 220;
  const H = 58;
  const GRID = 10;
  const MIN_K = 0.15;
  const MAX_K = 2.5;

  // Folder colours. Known dbt layer names get their conventional colour,
  // other folders take the next colour from the palette.
  const KNOWN = [
    [/^(stag|stg|base|src|sources?$|raw)/, '#4E8FD8'],
    [/^(int|intermediate)/, '#9B6BD6'],
    [/^(mart|report|fact|dim|core|gold|presentation)/, '#E0943A'],
  ];
  const PALETTE = ['#3BA7A0', '#D4597A', '#7FA845', '#5B7FD6', '#C77B3A', '#A178C9', '#4FA3C7'];
  const ROOT = '#8B95A5';
  const KIND_COLOR = { source: '#3FA37A', seed: '#B89B3E', snapshot: '#8B95A5', missing: 'var(--vscode-errorForeground)' };

  const I = {
    search: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 14 14"/></svg>',
    undo: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3.5 2 6l2.5 2.5"/><path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H6"/></svg>',
    redo: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.5 3.5 14 6l-2.5 2.5"/><path d="M13.5 6H6a3.5 3.5 0 0 0 0 7h4"/></svg>',
    tidy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="4" height="3" rx=".6"/><rect x="1.5" y="10.5" width="4" height="3" rx=".6"/><rect x="10.5" y="6.5" width="4" height="3" rx=".6"/><path d="M5.5 4h2.5v8H5.5M8 8h2.5"/></svg>',
    fit: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5"/><rect x="5" y="5.5" width="6" height="5" rx=".6"/></svg>',
    plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
    lockOpen: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7.5" width="10" height="6.5" rx="1.2"/><path d="M5.5 7.5V5a2.5 2.5 0 0 1 4.8-1"/></svg>',
    lock: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7.5" width="10" height="6.5" rx="1.2"/><path d="M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5"/></svg>',
  };

  // ------------------------------------------------------------------ DOM

  const app = document.getElementById('app');
  app.innerHTML = `
    <header class="bar">
      <div class="bar-left">
        <button class="project" id="project" title="Choose dbt project"></button>
        <label class="search">${I.search}<input id="search" type="search" placeholder="Find a model" spellcheck="false" aria-label="Find a model"></label>
      </div>
      <div class="bar-right">
        <button class="icon" id="btn-undo" aria-label="Undo">${I.undo}</button>
        <button class="icon" id="btn-redo" aria-label="Redo">${I.redo}</button>
        <span class="divider"></span>
        <button class="icon" id="btn-tidy" title="Tidy up layout" aria-label="Tidy up layout">${I.tidy}</button>
        <button class="icon" id="btn-fit" title="Fit to view (F)" aria-label="Fit to view">${I.fit}</button>
        <button class="primary" id="btn-create-all" hidden></button>
      </div>
    </header>
    <div class="banner" id="banner" hidden></div>
    <main class="viewport" id="viewport" tabindex="0" aria-label="Model canvas">
      <div class="world" id="world">
        <svg class="edges" id="edges" width="1" height="1" aria-hidden="true">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="arrow" d="M0,1 L9,5 L0,9 z"/></marker>
            <marker id="arrow-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="arrow-hl" d="M0,1 L9,5 L0,9 z"/></marker>
          </defs>
          <g id="ghost-links"></g>
          <g id="edge-layer"></g>
          <path id="temp-edge" class="temp-edge" d=""/>
        </svg>
        <div id="ghost-layer"></div>
        <div id="node-layer"></div>
      </div>
      <div class="empty" id="empty" hidden></div>
      <details class="legend" id="legend"><summary>Legend</summary><div id="legend-body"></div></details>
      <button class="zoom" id="zoom" title="Reset zoom to 100%"></button>
      <div class="toast" id="toast" role="status" aria-live="polite"></div>
    </main>
    <div class="menu" id="menu" role="menu" hidden></div>`;

  const $ = (id) => document.getElementById(id);
  const viewport = $('viewport');
  const world = $('world');
  const edgeLayer = $('edge-layer');
  const ghostLinks = $('ghost-links');
  const tempEdge = $('temp-edge');
  const nodeLayer = $('node-layer');
  const ghostLayer = $('ghost-layer');
  const menu = $('menu');
  const toastEl = $('toast');
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ------------------------------------------------------------------ state

  const saved = vscode.getState() || {};
  let view = null;
  let t = saved.t || null;
  const hadSavedView = !!saved.t;
  let selected = saved.selected || null;
  let activeId = null;
  let query = '';
  let colors = new Map();
  const pos = new Map(); // live positions, updated while dragging
  const nodeEls = new Map();
  const edgeEls = []; // { e, path, hit }
  let drag = null;

  const persist = () => vscode.setState({ t, selected });
  const post = (msg) => vscode.postMessage(msg);

  // ------------------------------------------------------------------ helpers

  function colorOf(n) {
    if (KIND_COLOR[n.kind]) return KIND_COLOR[n.kind];
    return colors.get(n.group) || ROOT;
  }

  function computeColors() {
    colors = new Map();
    const groups = [...new Set(view.nodes.filter((n) => n.kind === 'model' || n.kind === 'planned').map((n) => n.group))].sort();
    let next = 0;
    for (const g of groups) {
      if (!g) {
        colors.set('', ROOT);
        continue;
      }
      const known = KNOWN.find(([re]) => re.test(g.toLowerCase()));
      colors.set(g, known ? known[1] : PALETTE[next++ % PALETTE.length]);
    }
  }

  function toWorld(cx, cy) {
    const r = viewport.getBoundingClientRect();
    return { x: (cx - r.left - t.x) / t.k, y: (cy - r.top - t.y) / t.k };
  }

  const snap = (v, free) => (free ? Math.round(v) : Math.round(v / GRID) * GRID);

  function applyTransform() {
    world.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.k})`;
    const g = 20 * t.k;
    viewport.style.backgroundSize = `${g}px ${g}px`;
    viewport.style.backgroundPosition = `${t.x}px ${t.y}px`;
    $('zoom').textContent = Math.round(t.k * 100) + '%';
    persist();
  }

  // `readable` keeps text legible on first open in a narrow sidebar: if the whole
  // graph does not fit at that zoom, it starts at the sources and you pan from there.
  function fit(readable) {
    const r = viewport.getBoundingClientRect();
    if (!view || !view.nodes.length) {
      t = { x: r.width / 2, y: r.height / 2, k: 1 };
      return applyTransform();
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of view.nodes) {
      const p = pos.get(n.id);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + W);
      maxY = Math.max(maxY, p.y + H);
    }
    const pad = 48;
    const floor = readable === true ? 0.55 : MIN_K;
    const k = Math.max(floor, Math.min(1.1, (r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY)));
    const fitsX = (maxX - minX) * k <= r.width - pad;
    const fitsY = (maxY - minY) * k <= r.height - pad;
    t = {
      k,
      x: fitsX ? (r.width - (maxX - minX) * k) / 2 - minX * k : 24 - minX * k,
      y: fitsY ? (r.height - (maxY - minY) * k) / 2 - minY * k : r.height / 2 - ((minY + maxY) / 2) * k,
    };
    applyTransform();
  }

  function centerOn(id) {
    const p = pos.get(id);
    if (!p) return;
    const r = viewport.getBoundingClientRect();
    t.x = r.width / 2 - (p.x + W / 2) * t.k;
    t.y = r.height / 2 - (p.y + H / 2) * t.k;
    applyTransform();
  }

  let toastTimer = null;
  function toast(text, ms = 3600) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function svg(tag, cls) {
    const e = document.createElementNS(SVG_NS, tag);
    if (cls) e.setAttribute('class', cls);
    return e;
  }

  // ------------------------------------------------------------------ render

  function describe(n) {
    const modelRoot = (view.project && view.project.modelDirs[0]) || 'models';
    switch (n.kind) {
      case 'planned':
        return { meta: (n.folder ? n.folder : modelRoot) + '/', chip: 'no file yet' };
      case 'source':
        return { meta: n.folder, chip: 'source' };
      case 'seed':
        return { meta: 'seeds', chip: 'seed' };
      case 'snapshot':
        return { meta: 'snapshots', chip: 'snapshot' };
      case 'missing':
        return { meta: 'no model with this name', chip: 'not found' };
      default:
        return {
          meta: n.folder || modelRoot,
          chip: n.materialized || (n.language === 'python' ? 'python' : null),
        };
    }
  }

  function render() {
    pos.clear();
    for (const n of view.nodes) pos.set(n.id, { x: n.x, y: n.y });

    nodeLayer.textContent = '';
    ghostLayer.textContent = '';
    nodeEls.clear();

    for (const n of view.nodes) {
      const node = el('div', `node k-${n.kind}`);
      if (n.kind !== 'planned' && !n.locked) node.classList.add('unlocked');
      node.dataset.id = n.id;
      node.style.setProperty('--c', colorOf(n));
      node.style.transform = `translate(${n.x}px, ${n.y}px)`;
      node.title = n.rel ? n.rel : n.kind === 'planned' ? 'Box without a file. Right-click to create the file.' : n.name;

      const { meta, chip } = describe(n);
      // Only boxes that can depend on something get an input port.
      if (n.kind !== 'source' && n.kind !== 'seed' && n.kind !== 'missing') node.append(el('span', 'port in'));
      const title = el('div', 'title', n.name);
      node.append(title);
      const metaRow = el('div', 'meta');
      metaRow.append(el('span', 'path', meta));
      if (chip) metaRow.append(el('span', 'chip', chip));
      node.append(metaRow);
      if (n.kind !== 'planned' && n.kind !== 'missing') {
        const lock = el('span', 'lock');
        lock.innerHTML = n.locked ? I.lock : I.lockOpen;
        lock.title = n.locked ? 'Locked in place' : 'Moved. Right-click to put it back or lock it here.';
        node.append(lock);
      }
      if (n.kind !== 'missing') node.append(el('span', 'port out'));
      nodeLayer.append(node);
      nodeEls.set(n.id, node);

      if (n.home) {
        const ghost = el('div', 'ghost');
        ghost.dataset.id = n.id;
        ghost.style.setProperty('--c', colorOf(n));
        ghost.style.transform = `translate(${n.home.x}px, ${n.home.y}px)`;
        ghost.title = `${n.name} goes back here. Double-click to put it back.`;
        ghost.append(el('span', 'ghost-label', n.name));
        ghostLayer.append(ghost);
      }
    }

    edgeLayer.textContent = '';
    edgeEls.length = 0;
    for (const e of view.edges) {
      const g = svg('g', 'edge' + (e.planned ? ' planned' : ''));
      const path = svg('path', 'line');
      path.setAttribute('marker-end', 'url(#arrow)');
      const hit = svg('path', 'edge-hit');
      hit.dataset.from = e.from;
      hit.dataset.to = e.to;
      g.append(path, hit);
      edgeLayer.append(g);
      edgeEls.push({ e, g, path, hit });
    }
    updateEdges();
    renderChrome();
    applyHighlight();
  }

  function edgeD(a, b) {
    const x1 = a.x + W;
    const y1 = a.y + H / 2;
    const x2 = b.x - 2;
    const y2 = b.y + H / 2;
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }

  function updateEdges(onlyId) {
    for (const { e, path, hit } of edgeEls) {
      if (onlyId && e.from !== onlyId && e.to !== onlyId) continue;
      const d = edgeD(pos.get(e.from), pos.get(e.to));
      path.setAttribute('d', d);
      hit.setAttribute('d', d);
    }
    ghostLinks.textContent = '';
    for (const n of view.nodes) {
      if (!n.home) continue;
      const p = pos.get(n.id);
      const line = svg('path', 'ghost-link');
      line.setAttribute('d', `M${n.home.x + W / 2},${n.home.y + H / 2} L${p.x + W / 2},${p.y + H / 2}`);
      ghostLinks.append(line);
    }
  }

  function renderChrome() {
    const p = view.project;
    $('project').textContent = p ? p.name : 'dbt Flow';

    const undo = $('btn-undo');
    const redo = $('btn-redo');
    undo.disabled = !view.canUndo;
    redo.disabled = !view.canRedo;
    undo.title = view.canUndo ? `Undo: ${view.undoLabel} (Ctrl+Z)` : 'Nothing to undo';
    redo.title = view.canRedo ? `Redo: ${view.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo';

    const createAll = $('btn-create-all');
    createAll.hidden = !view.plannedCount;
    createAll.textContent = view.plannedCount === 1 ? 'Create 1 file' : `Create ${view.plannedCount} files`;

    const banner = $('banner');
    const notes = [];
    if (p && !p.hasProject) notes.push('No dbt_project.yml found here. New files go in models/.');
    if (view.duplicates.length) notes.push(`Duplicate model names are skipped: ${view.duplicates.join(', ')}`);
    banner.hidden = !notes.length;
    banner.textContent = notes.join('  ');

    const empty = $('empty');
    empty.hidden = view.nodes.length > 0;
    if (!view.nodes.length) {
      empty.innerHTML = '';
      empty.append(el('p', 'empty-title', 'No models yet'));
      empty.append(el('p', 'empty-text', 'Right-click anywhere to create a box. Connect boxes, then create the .sql files.'));
      const btn = el('button', 'primary');
      btn.innerHTML = I.plus;
      btn.append(document.createTextNode('Create new box'));
      btn.addEventListener('click', () => {
        const r = viewport.getBoundingClientRect();
        const w = toWorld(r.left + r.width / 2, r.top + r.height / 2);
        post({ type: 'createBoxAt', x: snap(w.x - W / 2), y: snap(w.y - H / 2) });
      });
      empty.append(btn);
    }

    renderLegend();
  }

  function renderLegend() {
    const body = $('legend-body');
    body.textContent = '';
    const legend = $('legend');
    const modelRoot = (view.project && view.project.modelDirs[0]) || 'models';
    const rows = [];
    // List folders in the order data flows through them (left to right).
    const avgX = (g) => {
      const xs = view.nodes.filter((n) => (n.kind === 'model' || n.kind === 'planned') && n.group === g).map((n) => n.x);
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    const ordered = [...colors.keys()].sort((a, b) => avgX(a) - avgX(b));
    for (const g of ordered) rows.push({ label: g || modelRoot, color: colors.get(g), cls: 'sw' });
    const kinds = new Set(view.nodes.map((n) => n.kind));
    if (kinds.has('source')) rows.push({ label: 'sources', color: KIND_COLOR.source, cls: 'sw pill' });
    if (kinds.has('seed')) rows.push({ label: 'seeds', color: KIND_COLOR.seed, cls: 'sw' });
    if (kinds.has('snapshot')) rows.push({ label: 'snapshots', color: KIND_COLOR.snapshot, cls: 'sw' });
    if (kinds.has('planned')) rows.push({ label: 'no file yet', color: 'var(--vscode-descriptionForeground)', cls: 'sw dashed' });
    if (view.unlockedCount) rows.push({ label: 'moved, can be put back', color: 'var(--vscode-descriptionForeground)', cls: 'sw ghosted' });
    if (kinds.has('missing')) rows.push({ label: 'ref to a model that does not exist', color: KIND_COLOR.missing, cls: 'sw dashed' });
    for (const r of rows) {
      const row = el('div', 'legend-row');
      const sw = el('span', r.cls);
      sw.style.setProperty('--c', r.color);
      row.append(sw, el('span', '', r.label));
      body.append(row);
    }
    legend.hidden = !rows.length;
    if (!legend.dataset.init && rows.length) {
      legend.dataset.init = '1';
      legend.open = viewport.clientWidth > 520;
    }
  }

  // ------------------------------------------------------------------ highlight

  function lineage(id) {
    const up = new Set();
    const down = new Set();
    const walk = (start, set, forward) => {
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop();
        for (const e of view.edges) {
          const [a, b] = forward ? [e.from, e.to] : [e.to, e.from];
          if (a === cur && !set.has(b)) {
            set.add(b);
            stack.push(b);
          }
        }
      }
    };
    walk(id, up, false);
    walk(id, down, true);
    return { up, down };
  }

  function applyHighlight() {
    if (!view) return;
    if (selected && !pos.has(selected)) selected = null;
    const q = query.trim().toLowerCase();
    let focus = null;
    let lin = null;
    if (selected) {
      lin = lineage(selected);
      focus = new Set([selected, ...lin.up, ...lin.down]);
    }
    for (const [id, node] of nodeEls) {
      const match = q && id.toLowerCase().includes(q);
      node.classList.toggle('selected', id === selected);
      node.classList.toggle('active', id === activeId);
      node.classList.toggle('match', !!match);
      node.classList.toggle('dim', (focus && !focus.has(id)) || (q && !match) || false);
    }
    for (const { e, g, path } of edgeEls) {
      let hl = false;
      if (lin) {
        const upSet = new Set([selected, ...lin.up]);
        const downSet = new Set([selected, ...lin.down]);
        hl = (upSet.has(e.from) && upSet.has(e.to)) || (downSet.has(e.from) && downSet.has(e.to));
      }
      g.classList.toggle('hl', hl);
      g.classList.toggle('dim', (lin && !hl) || !!q);
      path.setAttribute('marker-end', hl ? 'url(#arrow-hl)' : 'url(#arrow)');
    }
    persist();
  }

  // ------------------------------------------------------------------ menus

  function hideMenu() {
    menu.hidden = true;
  }

  function showMenu(items, cx, cy) {
    menu.textContent = '';
    for (const it of items) {
      if (!it) continue;
      if (it === '-') {
        menu.append(el('div', 'menu-sep'));
        continue;
      }
      const b = el('button', 'menu-item' + (it.danger ? ' danger' : ''));
      b.setAttribute('role', 'menuitem');
      b.append(el('span', 'menu-label', it.label));
      if (it.hint) b.append(el('span', 'menu-hint', it.hint));
      b.disabled = !!it.disabled;
      b.addEventListener('click', () => {
        hideMenu();
        it.run();
      });
      menu.append(b);
    }
    // Drop leading/trailing/double separators left by hidden items.
    const kids = [...menu.children];
    kids.forEach((k, i) => {
      if (k.classList.contains('menu-sep') && (i === 0 || i === kids.length - 1 || kids[i - 1].classList.contains('menu-sep'))) k.remove();
    });
    menu.hidden = false;
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    menu.style.left = Math.max(4, Math.min(cx, window.innerWidth - mw - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(cy, window.innerHeight - mh - 4)) + 'px';
    const first = menu.querySelector('.menu-item:not(:disabled)');
    if (first) first.focus();
  }

  const nodeById = (id) => view.nodes.find((n) => n.id === id);

  function nodeMenu(n) {
    const items = [];
    if (n.kind === 'planned') {
      items.push({ label: 'Create file', hint: `${n.name}.sql`, run: () => post({ type: 'createFile', id: n.id }) });
      items.push('-');
      items.push({ label: 'Rename…', run: () => post({ type: 'rename', id: n.id }) });
      items.push({ label: 'Change folder…', run: () => post({ type: 'changeFolder', id: n.id }) });
      items.push('-');
      items.push({ label: 'Delete box', hint: 'Del', danger: true, run: () => post({ type: 'deleteBox', id: n.id }) });
    } else if (n.kind === 'missing') {
      items.push({ label: 'Plan this model as a box', run: () => post({ type: 'planMissing', id: n.id }) });
    } else {
      if (n.rel) items.push({ label: 'Open file', hint: 'Double-click', run: () => post({ type: 'open', id: n.id }) });
      items.push('-');
      if (n.locked) {
        items.push({ label: 'Unlock to move', run: () => post({ type: 'unlock', id: n.id }) });
      } else {
        items.push({ label: 'Put back', hint: 'Ctrl+Z also works', run: () => post({ type: 'revert', id: n.id }) });
        items.push({ label: 'Lock in this spot', run: () => post({ type: 'lockHere', id: n.id }) });
      }
    }
    items.push('-');
    if (selected === n.id) items.push({ label: 'Clear lineage highlight', hint: 'Esc', run: () => select(null) });
    else items.push({ label: 'Highlight lineage', hint: 'Click', run: () => select(n.id) });
    return items;
  }

  function canvasMenu(cx, cy) {
    const w = toWorld(cx, cy);
    const n = view.plannedCount;
    return [
      { label: 'Create new box', run: () => post({ type: 'createBoxAt', x: snap(w.x - W / 2), y: snap(w.y - H / 2) }) },
      { label: n ? `Create all files (${n})` : 'Create all files', disabled: !n, run: () => post({ type: 'createAll' }) },
      '-',
      view.unlockedCount
        ? { label: `Put back moved boxes (${view.unlockedCount})`, run: () => post({ type: 'revertAll' }) }
        : null,
      { label: 'Tidy up layout', run: () => post({ type: 'tidy' }) },
      { label: 'Fit to view', hint: 'F', run: fit },
      '-',
      { label: view.canUndo ? `Undo ${view.undoLabel}` : 'Undo', hint: 'Ctrl+Z', disabled: !view.canUndo, run: () => post({ type: 'undo' }) },
      { label: view.canRedo ? `Redo ${view.redoLabel}` : 'Redo', hint: 'Ctrl+Shift+Z', disabled: !view.canRedo, run: () => post({ type: 'redo' }) },
    ];
  }

  function edgeMenu(from, to) {
    const e = view.edges.find((x) => x.from === from && x.to === to);
    const target = nodeById(to);
    if (!e) return [];
    if (e.planned) {
      return [{ label: 'Remove connection', danger: true, run: () => post({ type: 'disconnect', from, to }) }];
    }
    return [{ label: `Open ${target.rel ? target.rel.split('/').pop() : target.name} to edit this ref`, run: () => post({ type: 'open', id: to }) }];
  }

  function select(id) {
    selected = id;
    applyHighlight();
  }

  // ------------------------------------------------------------------ pointer

  viewport.addEventListener('pointerdown', (e) => {
    if (!view || e.button === 2) return;
    hideMenu();
    viewport.focus({ preventScroll: true });
    const port = e.target.closest('.port.out');
    const nodeEl = e.target.closest('.node');

    if (e.button === 0 && port && nodeEl) {
      drag = { mode: 'connect', from: nodeEl.dataset.id, target: null };
      viewport.classList.add('connecting');
      nodeEl.classList.add('source');
    } else if (e.button === 0 && nodeEl) {
      const n = nodeById(nodeEl.dataset.id);
      drag = {
        mode: 'node', id: n.id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y,
        movable: n.kind === 'planned' || !n.locked, moved: false, hinted: false,
      };
    } else if (e.button === 0 || e.button === 1) {
      drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y, moved: false };
      viewport.classList.add('panning');
    } else {
      return;
    }
    viewport.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  viewport.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.mode === 'pan') {
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      t.x = drag.ox + dx;
      t.y = drag.oy + dy;
      applyTransform();
    } else if (drag.mode === 'node') {
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.moved = true;
      if (!drag.movable) {
        if (!drag.hinted) {
          drag.hinted = true;
          toast(`${drag.id} is locked to its place. Right-click it and choose Unlock to move it.`);
        }
        return;
      }
      const x = snap(drag.ox + dx / t.k, e.altKey);
      const y = snap(drag.oy + dy / t.k, e.altKey);
      pos.set(drag.id, { x, y });
      nodeEls.get(drag.id).style.transform = `translate(${x}px, ${y}px)`;
      nodeEls.get(drag.id).classList.add('dragging');
      updateEdges(drag.id);
    } else if (drag.mode === 'connect') {
      const a = pos.get(drag.from);
      const w = toWorld(e.clientX, e.clientY);
      const x1 = a.x + W;
      const y1 = a.y + H / 2;
      const dx = Math.max(40, Math.abs(w.x - x1) * 0.5);
      tempEdge.setAttribute('d', `M${x1},${y1} C${x1 + dx},${y1} ${w.x - dx},${w.y} ${w.x},${w.y}`);
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const target = under && under.closest('.node');
      const id = target && target.dataset.id !== drag.from ? target.dataset.id : null;
      if (id !== drag.target) {
        if (drag.target && nodeEls.get(drag.target)) nodeEls.get(drag.target).classList.remove('drop');
        drag.target = id;
        if (id) nodeEls.get(id).classList.add('drop');
      }
    }
  });

  function endDrag(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    viewport.classList.remove('panning', 'connecting');
    if (d.mode === 'pan') {
      if (!d.moved) select(null);
    } else if (d.mode === 'node') {
      const node = nodeEls.get(d.id);
      if (node) node.classList.remove('dragging');
      if (!d.moved) {
        select(selected === d.id ? null : d.id);
      } else if (d.movable) {
        const p = pos.get(d.id);
        const n = nodeById(d.id);
        if (n && (p.x !== n.x || p.y !== n.y)) {
          n.x = p.x;
          n.y = p.y;
          post({ type: 'move', id: d.id, x: p.x, y: p.y });
        }
      }
    } else if (d.mode === 'connect') {
      tempEdge.setAttribute('d', '');
      const src = nodeEls.get(d.from);
      if (src) src.classList.remove('source');
      if (d.target) {
        nodeEls.get(d.target).classList.remove('drop');
        post({ type: 'connect', from: d.from, to: d.target });
      } else if (e && e.type === 'pointerup') {
        toast('Drop the line on another box to connect them.', 2400);
      }
    }
  }
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);

  viewport.addEventListener('dblclick', (e) => {
    const ghost = e.target.closest('.ghost');
    if (ghost) return post({ type: 'revert', id: ghost.dataset.id });
    const nodeEl = e.target.closest('.node');
    if (!nodeEl) return;
    const n = nodeById(nodeEl.dataset.id);
    if (n.kind === 'planned') post({ type: 'rename', id: n.id });
    else if (n.kind === 'missing') post({ type: 'planMissing', id: n.id });
    else if (n.rel) post({ type: 'open', id: n.id });
  });

  viewport.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!view || drag) return;
    const hit = e.target.closest('.edge-hit');
    const ghost = e.target.closest('.ghost');
    const nodeEl = e.target.closest('.node');
    let items;
    if (nodeEl) items = nodeMenu(nodeById(nodeEl.dataset.id));
    else if (ghost) items = [{ label: 'Put back here', run: () => post({ type: 'revert', id: ghost.dataset.id }) }];
    else if (hit) items = edgeMenu(hit.dataset.from, hit.dataset.to);
    else items = canvasMenu(e.clientX, e.clientY);
    if (items.length) showMenu(items, e.clientX, e.clientY);
  });

  // Hovering a box brightens its own connections.
  viewport.addEventListener('pointerover', (e) => {
    const nodeEl = e.target.closest('.node');
    const id = nodeEl ? nodeEl.dataset.id : null;
    for (const { e: edge, g } of edgeEls) g.classList.toggle('hover', !!id && (edge.from === id || edge.to === id));
  });

  viewport.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = viewport.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      const k = Math.min(MAX_K, Math.max(MIN_K, t.k * factor));
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      t.x = px - ((px - t.x) * k) / t.k;
      t.y = py - ((py - t.y) * k) / t.k;
      t.k = k;
      applyTransform();
    },
    { passive: false }
  );

  // ------------------------------------------------------------------ keyboard & toolbar

  document.addEventListener('keydown', (e) => {
    const inInput = e.target.tagName === 'INPUT';
    if (!menu.hidden) {
      const items = [...menu.querySelectorAll('.menu-item:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { hideMenu(); viewport.focus(); }
      else if (e.key === 'ArrowDown') { items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { items[(i - 1 + items.length) % items.length].focus(); }
      else return;
      e.preventDefault();
      return;
    }
    if (inInput) {
      if (e.key === 'Escape') { e.target.value = ''; query = ''; applyHighlight(); viewport.focus(); }
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z' && !e.shiftKey) post({ type: 'undo' });
    else if ((mod && key === 'z' && e.shiftKey) || (mod && key === 'y')) post({ type: 'redo' });
    else if (mod && key === 'f') $('search').focus();
    else if (!mod && key === 'f') fit();
    else if (key === 'escape') select(null);
    else if ((key === 'delete' || key === 'backspace') && selected) {
      const n = nodeById(selected);
      if (n && n.kind === 'planned') post({ type: 'deleteBox', id: n.id });
      else if (n) toast(`${n.name} has a file. Delete the file to remove it.`);
    } else if (key === 'enter' && selected) {
      const n = nodeById(selected);
      if (n && n.rel) post({ type: 'open', id: n.id });
    } else return;
    e.preventDefault();
  });

  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !e.target.closest('.menu')) hideMenu();
  });
  window.addEventListener('blur', hideMenu);

  $('btn-undo').addEventListener('click', () => post({ type: 'undo' }));
  $('btn-redo').addEventListener('click', () => post({ type: 'redo' }));
  $('btn-tidy').addEventListener('click', () => post({ type: 'tidy' }));
  $('btn-fit').addEventListener('click', fit);
  $('btn-create-all').addEventListener('click', () => post({ type: 'createAll' }));
  $('project').addEventListener('click', () => post({ type: 'selectProject' }));
  $('zoom').addEventListener('click', () => {
    const r = viewport.getBoundingClientRect();
    const cx = r.width / 2;
    const cy = r.height / 2;
    t.x = cx - ((cx - t.x) * 1) / t.k;
    t.y = cy - ((cy - t.y) * 1) / t.k;
    t.k = 1;
    applyTransform();
  });

  const search = $('search');
  search.addEventListener('input', () => {
    query = search.value;
    applyHighlight();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !view) return;
    const q = query.trim().toLowerCase();
    const hit = view.nodes.find((n) => n.id.toLowerCase() === q) || view.nodes.find((n) => n.id.toLowerCase().includes(q));
    if (hit) {
      centerOn(hit.id);
      search.value = '';
      query = '';
      select(hit.id);
      viewport.focus();
    }
  });

  // ------------------------------------------------------------------ messages

  let first = true;
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'graph') {
      if (drag && drag.mode === 'node') drag = null;
      view = msg.view || {
        project: null, nodes: [], edges: [], plannedCount: 0, unlockedCount: 0, duplicates: [],
        canUndo: false, canRedo: false,
      };
      if (!msg.view) {
        $('empty').hidden = false;
        $('empty').innerHTML = '';
        $('empty').append(el('p', 'empty-title', 'No folder open'));
        $('empty').append(el('p', 'empty-text', 'Open the folder that holds your dbt project to see its models.'));
        return;
      }
      computeColors();
      render();
      if (first) {
        first = false;
        if (hadSavedView) applyTransform();
        else fit(true);
      }
    } else if (msg.type === 'activeFile') {
      activeId = msg.id;
      applyHighlight();
    }
  });

  if (!t) t = { x: 0, y: 0, k: 1 };
  applyTransform();
  post({ type: 'ready' });
})();

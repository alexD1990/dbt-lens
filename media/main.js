// dbt Flow canvas. Runs inside the VS Code webview; every change is sent to the extension.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const W = 220;
  const H = 60;
  const GRID = 10;
  const MIN_K = 0.15;
  const MAX_K = 2.5;
  const MAX_GLOW_EDGES = 400; // above this, edges are drawn without the glow filter

  // Folder colours. Known dbt layer names get their usual colour,
  // other folders take the next colour from the palette.
  const KNOWN = [
    [/^(stag|stg|base|src|sources?$|raw)/, '#4F9BFF'],
    [/^(int|intermediate)/, '#A97BFF'],
    [/^(mart|report|fact|dim|core|gold|presentation)/, '#FF9F43'],
  ];
  const PALETTE = ['#2DD4BF', '#F472B6', '#A3E635', '#818CF8', '#FB923C', '#C084FC', '#38BDF8'];
  const ROOT = '#94A3B8';
  const KIND_COLOR = { source: '#34D399', seed: '#FACC15', snapshot: '#94A3B8', missing: '#F85149' };

  const ICON = {
    // canvas tools
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 14 14"/>',
    undo: '<path d="M4.5 3.5 2 6l2.5 2.5"/><path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H6"/>',
    redo: '<path d="M11.5 3.5 14 6l-2.5 2.5"/><path d="M13.5 6H6a3.5 3.5 0 0 0 0 7h4"/>',
    sync: '<path d="M13.5 6.5A5.5 5.5 0 0 0 3.4 4.6"/><path d="M3 2v3h3"/><path d="M2.5 9.5a5.5 5.5 0 0 0 10.1 1.9"/><path d="M13 14v-3h-3"/>',
    flowLR: '<rect x="1" y="5.5" width="5" height="5" rx="1.2"/><rect x="10" y="5.5" width="5" height="5" rx="1.2"/><path d="M6 8h3.5M8 6.5 9.5 8 8 9.5"/>',
    flowTB: '<rect x="5.5" y="1" width="5" height="5" rx="1.2"/><rect x="5.5" y="10" width="5" height="5" rx="1.2"/><path d="M8 6v3.5M6.5 8 8 9.5 9.5 8"/>',
    add: '<rect x="2" y="3.5" width="12" height="9" rx="2.5"/><path d="M8 6v4M6 8h4"/>',
    tidy: '<rect x="1.5" y="2.5" width="4" height="3" rx=".8"/><rect x="1.5" y="10.5" width="4" height="3" rx=".8"/><rect x="10.5" y="6.5" width="4" height="3" rx=".8"/><path d="M5.5 4h2.5v8H5.5M8 8h2.5"/>',
    fit: '<path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5"/><rect x="5" y="5.5" width="6" height="5" rx="1"/>',
    trash: '<path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    minus: '<path d="M3 8h10"/>',
    // box kinds
    model: '<path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5z"/><path d="M2.5 5 8 8.2 13.5 5M8 8.2v6"/>',
    table: '<rect x="2" y="3" width="12" height="10" rx="1.8"/><path d="M2 6.6h12M6.6 6.6V13"/>',
    view: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
    incremental: '<path d="M2 7.5 8 4.5l6 3-6 3z"/><path d="M2 10.5l6 3 6-3"/>',
    ephemeral: '<circle cx="8" cy="8" r="5.5" stroke-dasharray="2.2 2"/>',
    python: '<path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4"/>',
    source: '<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
    seed: '<path d="M4 1.8h5l3 3V14H4z"/><path d="M9 1.8v3h3M6 8.5h4M6 11h4"/>',
    snapshot: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',
    planned: '<path d="M8 4.5v7M4.5 8h7"/>',
    missing: '<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3M8 11.6v.1"/>',
  };
  const svgIcon = (name) => `<svg viewBox="0 0 16 16" aria-hidden="true">${ICON[name]}</svg>`;

  // ------------------------------------------------------------------ DOM

  const app = document.getElementById('app');
  app.innerHTML = `
    <header class="bar">
      <button class="project" id="project" title="Choose dbt project"></button>
      <label class="search">${svgIcon('search')}<input id="search" type="search" placeholder="Find a model" spellcheck="false" aria-label="Find a model"></label>
      <span class="spacer"></span>
      <button class="primary" id="btn-create-all" hidden></button>
    </header>
    <div class="banner" id="banner" hidden></div>
    <main class="viewport" id="viewport" tabindex="0" aria-label="Model canvas">
      <div class="world" id="world">
        <svg class="edges" id="edges" width="1" height="1" aria-hidden="true">
          <defs id="defs">
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2.4" result="blur"/>
              <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
          </defs>
          <g id="edge-layer"></g>
          <path id="temp-edge" class="temp-edge" d=""/>
        </svg>
        <div id="node-layer"></div>
      </div>
      <div class="empty" id="empty" hidden></div>
      <nav class="hud tools" aria-label="Canvas tools">
        <button class="icon" id="btn-sync" title="Sync with files: show every model and how they connect" aria-label="Sync with files">${svgIcon('sync')}</button>
        <span class="hud-sep"></span>
        <button class="icon" id="btn-undo" aria-label="Undo">${svgIcon('undo')}</button>
        <button class="icon" id="btn-redo" aria-label="Redo">${svgIcon('redo')}</button>
        <span class="hud-sep"></span>
        <button class="icon" id="btn-add" title="Create new box" aria-label="Create new box">${svgIcon('add')}</button>
        <button class="icon" id="btn-tidy" title="Tidy up layout" aria-label="Tidy up layout">${svgIcon('tidy')}</button>
        <button class="icon" id="btn-direction" aria-label="Flow direction"></button>
        <button class="icon" id="btn-fit" title="Fit to view (F)" aria-label="Fit to view">${svgIcon('fit')}</button>
        <button class="icon" id="btn-delete" aria-label="Delete selected box">${svgIcon('trash')}</button>
      </nav>
      <div class="hud minimap" id="minimap" title="Click or drag to move around"><canvas id="minimap-canvas"></canvas></div>
      <div class="hud zoombox">
        <button class="icon" id="btn-zoom-in" title="Zoom in" aria-label="Zoom in">${svgIcon('plus')}</button>
        <button class="zoom-level" id="zoom" title="Reset zoom to 100%"></button>
        <button class="icon" id="btn-zoom-out" title="Zoom out" aria-label="Zoom out">${svgIcon('minus')}</button>
      </div>
      <details class="legend" id="legend"><summary>Legend</summary><div id="legend-body"></div></details>
      <div class="toast" id="toast" role="status" aria-live="polite"></div>
    </main>
    <div class="menu" id="menu" role="menu" hidden></div>`;

  const $ = (id) => document.getElementById(id);
  const viewport = $('viewport');
  const world = $('world');
  const defs = $('defs');
  const edgeLayer = $('edge-layer');
  const tempEdge = $('temp-edge');
  const nodeLayer = $('node-layer');
  const menu = $('menu');
  const toastEl = $('toast');
  const minimap = $('minimap');
  const miniCanvas = $('minimap-canvas');
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ------------------------------------------------------------------ state

  const saved = vscode.getState() || {};
  let view = null;
  let t = saved.t || { x: 0, y: 0, k: 1 };
  const hadSavedView = !!saved.t;
  let selected = saved.selected || null;
  let activeId = null;
  let query = '';
  let colors = new Map();
  const pos = new Map(); // live positions, updated while dragging
  const nodeEls = new Map();
  const edgeEls = []; // { e, g, line, pulse, hit, grad }
  let drag = null;
  // Integration UIs (media/integrations/*.js) hook in here; see "integrations" below.
  const hooks = { message: [], nodeMenu: [], canvasMenu: [], decorate: [], edgesMoved: [], escape: [] };
  let overlayActive = false; // an integration draws on the canvas; lineage highlight steps aside

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

  function iconFor(n) {
    if (n.kind !== 'model') return n.kind;
    if (n.language === 'python') return 'python';
    return ICON[n.materialized] ? n.materialized : 'model';
  }

  function toWorld(cx, cy) {
    const r = viewport.getBoundingClientRect();
    return { x: (cx - r.left - t.x) / t.k, y: (cy - r.top - t.y) / t.k };
  }

  const snap = (v, free) => (free ? Math.round(v) : Math.round(v / GRID) * GRID);

  function applyTransform() {
    world.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.k})`;
    const g = 22 * t.k;
    viewport.style.backgroundSize = `${g}px ${g}px`;
    viewport.style.backgroundPosition = `${t.x}px ${t.y}px`;
    $('zoom').textContent = Math.round(t.k * 100) + '%';
    drawMinimap();
    persist();
  }

  function zoomAt(k, px, py) {
    k = Math.min(MAX_K, Math.max(MIN_K, k));
    t.x = px - ((px - t.x) * k) / t.k;
    t.y = py - ((py - t.y) * k) / t.k;
    t.k = k;
    applyTransform();
  }

  function zoomCenter(k) {
    const r = viewport.getBoundingClientRect();
    zoomAt(k, r.width / 2, r.height / 2);
  }

  function bounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pos.values()) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + W);
      maxY = Math.max(maxY, p.y + H);
    }
    return { minX, minY, maxX, maxY };
  }

  // `readable` keeps text legible on first open in a narrow area: if the whole
  // graph does not fit at that zoom, it starts at the sources and you pan from there.
  function fit(readable) {
    const r = viewport.getBoundingClientRect();
    if (!view || !view.nodes.length) {
      t = { x: r.width / 2, y: r.height / 2, k: 1 };
      return applyTransform();
    }
    const { minX, minY, maxX, maxY } = bounds();
    const padX = 64;
    const padY = 56;
    const floor = readable === true ? 0.55 : MIN_K;
    const k = Math.max(floor, Math.min(1.1, (r.width - padX * 2) / (maxX - minX), (r.height - padY * 2) / (maxY - minY)));
    const fitsX = (maxX - minX) * k <= r.width - padX;
    const fitsY = (maxY - minY) * k <= r.height - padY;
    t = {
      k,
      // When it does not fit, start where the flow starts: the left edge, or the top for top to bottom.
      x: fitsX ? (r.width - (maxX - minX) * k) / 2 - minX * k : isTB() ? r.width / 2 - ((minX + maxX) / 2) * k : 64 - minX * k,
      y: fitsY ? (r.height - (maxY - minY) * k) / 2 - minY * k : isTB() ? 56 - minY * k : r.height / 2 - ((minY + maxY) / 2) * k,
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
        return { meta: 'no .sql file with this name', chip: null };
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
    nodeEls.clear();

    for (const n of view.nodes) {
      const node = el('div', `node k-${n.kind}`);
      node.dataset.id = n.id;
      node.style.setProperty('--c', colorOf(n));
      node.style.transform = `translate(${n.x}px, ${n.y}px)`;
      node.title = n.rel ? n.rel : n.kind === 'planned' ? 'Box without a file. Right-click to create the file.' : n.name;

      // Only boxes that can depend on something get an input port.
      if (n.kind !== 'source' && n.kind !== 'seed' && n.kind !== 'missing') node.append(el('span', 'port in'));

      const tile = el('span', 'tile');
      tile.innerHTML = svgIcon(iconFor(n));
      node.append(tile);

      const { meta, chip } = describe(n);
      const text = el('span', 'text');
      text.append(el('div', 'title', n.name));
      const metaRow = el('div', 'meta');
      metaRow.append(el('span', 'path', meta));
      if (chip) metaRow.append(el('span', 'chip', chip));
      text.append(metaRow);
      node.append(text);

      if (n.kind !== 'missing') node.append(el('span', 'port out'));
      nodeLayer.append(node);
      nodeEls.set(n.id, node);
    }

    // Each connection fades from the colour of the box it leaves to the box it enters.
    edgeLayer.textContent = '';
    defs.querySelectorAll('linearGradient').forEach((g) => g.remove());
    edgeEls.length = 0;
    edgeLayer.setAttribute('filter', view.edges.length <= MAX_GLOW_EDGES ? 'url(#glow)' : '');
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    view.edges.forEach((e, i) => {
      const grad = svg('linearGradient');
      grad.id = 'eg' + i;
      grad.setAttribute('gradientUnits', 'userSpaceOnUse');
      const s1 = svg('stop');
      s1.setAttribute('offset', '0');
      s1.setAttribute('stop-color', colorOf(byId.get(e.from)));
      const s2 = svg('stop');
      s2.setAttribute('offset', '1');
      s2.setAttribute('stop-color', colorOf(byId.get(e.to)));
      grad.append(s1, s2);
      defs.append(grad);

      const g = svg('g', 'edge' + (e.planned ? ' planned' : ''));
      const line = svg('path', 'line');
      line.setAttribute('stroke', `url(#eg${i})`);
      const pulse = svg('path', 'pulse');
      const hit = svg('path', 'edge-hit');
      hit.dataset.from = e.from;
      hit.dataset.to = e.to;
      g.append(line, pulse, hit);
      edgeLayer.append(g);
      edgeEls.push({ e, g, line, pulse, hit, grad });
    });
    updateEdges();
    renderChrome();
    applyHighlight();
    drawMinimap();
    runHooks('decorate');
  }

  const isTB = () => !!view && view.direction === 'TB';

  /** Where a connection leaves a box: right edge (left to right) or bottom edge (top to bottom). */
  function outPoint(a) {
    return isTB() ? { x: a.x + W / 2, y: a.y + H + 4 } : { x: a.x + W + 4, y: a.y + H / 2 };
  }

  /** A curve that leaves and enters along the flow direction. */
  function curve(x1, y1, x2, y2) {
    if (isTB()) {
      const dy = Math.max(30, Math.abs(y2 - y1) * 0.5);
      return `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
    }
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }

  function edgeD(a, b) {
    const { x: x1, y: y1 } = outPoint(a);
    const x2 = isTB() ? b.x + W / 2 : b.x - 4;
    const y2 = isTB() ? b.y - 4 : b.y + H / 2;
    return { d: curve(x1, y1, x2, y2), x1, y1, x2, y2 };
  }

  function updateEdges(onlyId) {
    for (const { e, line, pulse, hit, grad } of edgeEls) {
      if (onlyId && e.from !== onlyId && e.to !== onlyId) continue;
      const { d, x1, y1, x2, y2 } = edgeD(pos.get(e.from), pos.get(e.to));
      line.setAttribute('d', d);
      pulse.setAttribute('d', d);
      hit.setAttribute('d', d);
      // A gradient across zero width is invisible, so give vertical links a nudge.
      grad.setAttribute('x1', x1);
      grad.setAttribute('y1', y1);
      grad.setAttribute('x2', Math.abs(x2 - x1) < 1 ? x2 + 1 : x2);
      grad.setAttribute('y2', y2);
    }
    runHooks('edgesMoved', onlyId);
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
    updateDeleteButton();

    const dir = $('btn-direction');
    dir.innerHTML = svgIcon(isTB() ? 'flowTB' : 'flowLR');
    dir.title = isTB() ? 'Flow: top to bottom. Click for left to right.' : 'Flow: left to right. Click for top to bottom.';

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
    minimap.hidden = view.nodes.length === 0;
    if (!view.nodes.length) {
      empty.innerHTML = '';
      const btn = el('button', 'primary');
      if (view.hiddenCount) {
        // The project has files; they were only removed from the canvas.
        empty.append(el('p', 'empty-title', 'The canvas is empty'));
        empty.append(el('p', 'empty-text', `Sync to show all ${view.hiddenCount} models from your files and how they connect, or right-click to sketch a new box.`));
        btn.innerHTML = svgIcon('sync');
        btn.append(document.createTextNode('Sync with files'));
        btn.addEventListener('click', () => post({ type: 'sync' }));
      } else {
        empty.append(el('p', 'empty-title', 'No models yet'));
        empty.append(el('p', 'empty-text', 'Right-click anywhere to create a box. Connect boxes, then create the .sql files.'));
        btn.innerHTML = svgIcon('plus');
        btn.append(document.createTextNode('Create new box'));
        btn.addEventListener('click', createBoxInCenter);
      }
      empty.append(btn);
    }

    renderLegend();
  }

  function updateDeleteButton() {
    const del = $('btn-delete');
    const n = selected && view ? view.nodes.find((x) => x.id === selected) : null;
    del.disabled = !n;
    del.title = !n
      ? 'Select a box to remove it'
      : n.kind === 'planned'
        ? `Delete ${n.name} (Del)`
        : `Remove ${n.name} from the canvas (Del). No file is deleted.`;
  }

  function renderLegend() {
    const body = $('legend-body');
    body.textContent = '';
    const legend = $('legend');
    const modelRoot = (view.project && view.project.modelDirs[0]) || 'models';
    const rows = [];
    // Folders in the order data flows through them (left to right).
    const avgAlong = (g) => {
      const xs = view.nodes
        .filter((n) => (n.kind === 'model' || n.kind === 'planned') && n.group === g)
        .map((n) => (isTB() ? n.y : n.x));
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    const ordered = [...colors.keys()].sort((a, b) => avgAlong(a) - avgAlong(b));
    for (const g of ordered) rows.push({ label: g || modelRoot, color: colors.get(g), cls: 'sw' });
    const kinds = new Set(view.nodes.map((n) => n.kind));
    if (kinds.has('source')) rows.push({ label: 'sources', color: KIND_COLOR.source, cls: 'sw pill' });
    if (kinds.has('seed')) rows.push({ label: 'seeds', color: KIND_COLOR.seed, cls: 'sw' });
    if (kinds.has('snapshot')) rows.push({ label: 'snapshots', color: KIND_COLOR.snapshot, cls: 'sw' });
    if (kinds.has('planned')) rows.push({ label: 'no file yet', color: 'var(--muted)', cls: 'sw dashed' });
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
      legend.open = viewport.clientWidth > 620;
    }
  }

  // ------------------------------------------------------------------ minimap

  let miniScale = null;

  function drawMinimap() {
    if (!view || !view.nodes.length || minimap.hidden || !minimap.offsetWidth) return;
    const cw = miniCanvas.clientWidth;
    const ch = miniCanvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (miniCanvas.width !== cw * dpr) {
      miniCanvas.width = cw * dpr;
      miniCanvas.height = ch * dpr;
    }
    const ctx = miniCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const r = viewport.getBoundingClientRect();
    const vis = { x: -t.x / t.k, y: -t.y / t.k, w: r.width / t.k, h: r.height / t.k };
    const b = bounds();
    const minX = Math.min(b.minX, vis.x);
    const minY = Math.min(b.minY, vis.y);
    const maxX = Math.max(b.maxX, vis.x + vis.w);
    const maxY = Math.max(b.maxY, vis.y + vis.h);
    const s = Math.min((cw - 8) / (maxX - minX), (ch - 8) / (maxY - minY));
    const ox = (cw - (maxX - minX) * s) / 2 - minX * s;
    const oy = (ch - (maxY - minY) * s) / 2 - minY * s;
    miniScale = { s, ox, oy };

    ctx.lineWidth = 1;
    for (const n of view.nodes) {
      const p = pos.get(n.id);
      const c = colorOf(n);
      const x = p.x * s + ox;
      const y = p.y * s + oy;
      const w = Math.max(3, W * s);
      const h = Math.max(2, H * s);
      ctx.globalAlpha = n.kind === 'planned' ? 0.35 : 0.85;
      ctx.fillStyle = c;
      roundRect(ctx, x, y, w, h, Math.min(3, h / 2));
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const focus = getComputedStyle(document.body).getPropertyValue('--vscode-focusBorder').trim() || '#4F9BFF';
    ctx.strokeStyle = focus;
    ctx.fillStyle = focus;
    ctx.globalAlpha = 0.12;
    ctx.fillRect(vis.x * s + ox, vis.y * s + oy, vis.w * s, vis.h * s);
    ctx.globalAlpha = 1;
    ctx.strokeRect(vis.x * s + ox + 0.5, vis.y * s + oy + 0.5, vis.w * s - 1, vis.h * s - 1);
  }

  function roundRect(ctx, x, y, w, h, rad) {
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  function minimapJump(e) {
    if (!miniScale) return;
    const rc = miniCanvas.getBoundingClientRect();
    const wx = (e.clientX - rc.left - miniScale.ox) / miniScale.s;
    const wy = (e.clientY - rc.top - miniScale.oy) / miniScale.s;
    const r = viewport.getBoundingClientRect();
    t.x = r.width / 2 - wx * t.k;
    t.y = r.height / 2 - wy * t.k;
    applyTransform();
  }

  minimap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    hideMenu();
    minimap.setPointerCapture(e.pointerId);
    minimap.dataset.drag = '1';
    minimapJump(e);
  });
  minimap.addEventListener('pointermove', (e) => {
    if (minimap.dataset.drag) minimapJump(e);
  });
  const endMini = () => delete minimap.dataset.drag;
  minimap.addEventListener('pointerup', endMini);
  minimap.addEventListener('pointercancel', endMini);

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
    if (selected && !overlayActive) {
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
    const upSet = lin ? new Set([selected, ...lin.up]) : null;
    const downSet = lin ? new Set([selected, ...lin.down]) : null;
    for (const { e, g } of edgeEls) {
      const hl = !!lin && ((upSet.has(e.from) && upSet.has(e.to)) || (downSet.has(e.from) && downSet.has(e.to)));
      g.classList.toggle('hl', hl);
      g.classList.toggle('dim', (lin && !hl) || !!q);
    }
    updateDeleteButton();
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
    // Drop leading, trailing and doubled separators left by hidden items.
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
      items.push({ label: 'Point refs to another model…', run: () => post({ type: 'retarget', id: n.id }) });
      items.push({ label: 'Plan this model as a box', run: () => post({ type: 'planMissing', id: n.id }) });
      for (const rel of (n.usedBy || []).slice(0, 5)) {
        items.push({ label: `Open ${rel.split('/').pop()}`, hint: 'uses this ref', run: () => post({ type: 'openRel', rel }) });
      }
      items.push('-');
      items.push({ label: 'Remove from canvas', hint: 'Del', danger: true, run: () => removeBox(n) });
    } else {
      if (n.rel) items.push({ label: 'Open file', hint: 'Double-click', run: () => post({ type: 'open', id: n.id }) });
      if (n.kind === 'model') items.push({ label: 'Rename…', hint: 'updates refs', run: () => post({ type: 'rename', id: n.id }) });
      items.push('-');
      items.push({ label: 'Remove from canvas', hint: n.rel ? 'file is kept' : 'Del', danger: true, run: () => removeBox(n) });
    }
    const extra = pluginItems('nodeMenu', n);
    if (extra.length) items.push('-', ...extra);
    items.push('-');
    if (selected === n.id) items.push({ label: 'Clear lineage highlight', hint: 'Esc', run: () => select(null) });
    else items.push({ label: 'Highlight lineage', hint: 'Click', run: () => select(n.id) });
    return items;
  }

  function canvasMenu(cx, cy) {
    const w = toWorld(cx, cy);
    const n = view.plannedCount;
    const extra = pluginItems('canvasMenu');
    return [
      ...extra,
      extra.length ? '-' : null,
      { label: 'Sync with files', hint: 'shows every model', run: () => post({ type: 'sync' }) },
      '-',
      { label: 'Create new box', run: () => post({ type: 'createBoxAt', x: snap(w.x - W / 2), y: snap(w.y - H / 2) }) },
      { label: n ? `Create all files (${n})` : 'Create all files', disabled: !n, run: () => post({ type: 'createAll' }) },
      '-',
      view.hiddenCount
        ? { label: `Show removed boxes (${view.hiddenCount})`, run: () => post({ type: 'showHidden' }) }
        : null,
      { label: 'Tidy up layout', run: () => post({ type: 'tidy' }) },
      isTB()
        ? { label: 'Flow left to right', run: () => post({ type: 'setDirection', direction: 'LR' }) }
        : { label: 'Flow top to bottom', hint: 'downstream below', run: () => post({ type: 'setDirection', direction: 'TB' }) },
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

  function createBoxInCenter() {
    const r = viewport.getBoundingClientRect();
    const w = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    // Nudge off any box already sitting in the middle.
    let x = snap(w.x - W / 2);
    let y = snap(w.y - H / 2);
    while ([...pos.values()].some((p) => Math.abs(p.x - x) < W && Math.abs(p.y - y) < H + 10)) y += H + 30;
    post({ type: 'createBoxAt', x, y });
  }

  function deleteSelected() {
    const n = selected && nodeById(selected);
    if (n) removeBox(n);
  }

  /** Boxes without a file are deleted; every other box only leaves the canvas. Files are never touched. */
  function removeBox(n) {
    if (n.kind === 'planned') return post({ type: 'deleteBox', id: n.id });
    post({ type: 'removeFromCanvas', id: n.id });
    if (n.kind === 'missing' && n.usedBy && n.usedBy.length) {
      const files = n.usedBy.map((r) => r.split('/').pop()).join(', ');
      toast(`${n.name} is off the canvas. ${files} still ${n.usedBy.length === 1 ? 'uses' : 'use'} ref('${n.name}').`, 5200);
    } else if (n.rel) {
      toast(`${n.name} is off the canvas. The file is kept; Ctrl+Z brings the box back.`, 4200);
    } else {
      toast(`${n.name} is off the canvas. Ctrl+Z brings it back.`, 3600);
    }
  }

  // ------------------------------------------------------------------ pointer

  viewport.addEventListener('pointerdown', (e) => {
    if (!view || e.button === 2 || e.target.closest('.hud, .legend, button')) return;
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
      drag = { mode: 'node', id: n.id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, moved: false };
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
      const x = snap(drag.ox + dx / t.k, e.altKey);
      const y = snap(drag.oy + dy / t.k, e.altKey);
      pos.set(drag.id, { x, y });
      nodeEls.get(drag.id).style.transform = `translate(${x}px, ${y}px)`;
      nodeEls.get(drag.id).classList.add('dragging');
      updateEdges(drag.id);
    } else if (drag.mode === 'connect') {
      const a = pos.get(drag.from);
      const w = toWorld(e.clientX, e.clientY);
      const o = outPoint(a);
      tempEdge.setAttribute('d', curve(o.x, o.y, w.x, w.y));
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
      } else {
        const p = pos.get(d.id);
        const n = nodeById(d.id);
        if (n && (p.x !== n.x || p.y !== n.y)) {
          n.x = p.x;
          n.y = p.y;
          post({ type: 'move', id: d.id, x: p.x, y: p.y });
        }
      }
      drawMinimap();
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
    if (e.target.closest('.hud, .legend')) return;
    const nodeEl = e.target.closest('.node');
    if (!nodeEl) return;
    const n = nodeById(nodeEl.dataset.id);
    if (n.kind === 'planned') post({ type: 'rename', id: n.id });
    else if (n.kind === 'missing') post({ type: 'planMissing', id: n.id });
    else if (n.rel) post({ type: 'open', id: n.id });
  });

  viewport.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!view || drag || e.target.closest('.hud, .legend')) return;
    const hit = e.target.closest('.edge-hit');
    const nodeEl = e.target.closest('.node');
    let items;
    if (nodeEl) items = nodeMenu(nodeById(nodeEl.dataset.id));
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
      zoomAt(t.k * factor, e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false }
  );

  // ------------------------------------------------------------------ keyboard & controls

  document.addEventListener('keydown', (e) => {
    const inInput = e.target.tagName === 'INPUT';
    if (!menu.hidden) {
      const items = [...menu.querySelectorAll('.menu-item:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        hideMenu();
        viewport.focus();
      } else if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
      else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
      else return;
      e.preventDefault();
      return;
    }
    if (inInput) {
      if (e.key === 'Escape') {
        e.target.value = '';
        query = '';
        applyHighlight();
        viewport.focus();
      }
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z' && !e.shiftKey) post({ type: 'undo' });
    else if ((mod && key === 'z' && e.shiftKey) || (mod && key === 'y')) post({ type: 'redo' });
    else if (mod && key === 'f') $('search').focus();
    else if (!mod && key === 'f') fit();
    else if (!mod && (key === '+' || key === '=')) zoomCenter(t.k * 1.2);
    else if (!mod && key === '-') zoomCenter(t.k / 1.2);
    else if (key === 'escape') {
      // An integration overlay (e.g. a column trace) is cleared first; then the lineage highlight.
      if (!runHooks('escape').some(Boolean)) select(null);
    }
    else if ((key === 'delete' || key === 'backspace') && selected) deleteSelected();
    else if (key === 'enter' && selected) {
      const n = nodeById(selected);
      if (n && n.rel) post({ type: 'open', id: n.id });
    } else return;
    e.preventDefault();
  });

  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !e.target.closest('.menu')) hideMenu();
  });
  window.addEventListener('blur', hideMenu);
  window.addEventListener('resize', drawMinimap);

  $('btn-sync').addEventListener('click', () => post({ type: 'sync' }));
  $('btn-undo').addEventListener('click', () => post({ type: 'undo' }));
  $('btn-redo').addEventListener('click', () => post({ type: 'redo' }));
  $('btn-add').addEventListener('click', createBoxInCenter);
  $('btn-tidy').addEventListener('click', () => post({ type: 'tidy' }));
  $('btn-direction').addEventListener('click', () => post({ type: 'setDirection', direction: isTB() ? 'LR' : 'TB' }));
  $('btn-fit').addEventListener('click', () => fit());
  $('btn-delete').addEventListener('click', deleteSelected);
  $('btn-zoom-in').addEventListener('click', () => zoomCenter(t.k * 1.2));
  $('btn-zoom-out').addEventListener('click', () => zoomCenter(t.k / 1.2));
  $('zoom').addEventListener('click', () => zoomCenter(1));
  $('btn-create-all').addEventListener('click', () => post({ type: 'createAll' }));
  $('project').addEventListener('click', () => post({ type: 'selectProject' }));

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

  function syncSummary(s) {
    if (!s) return 'Synced with files.';
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const parts = [plural(s.models, 'model')];
    if (s.sources) parts.push(plural(s.sources, 'source'));
    if (s.seeds) parts.push(plural(s.seeds, 'seed'));
    if (s.snapshots) parts.push(plural(s.snapshots, 'snapshot'));
    let text = `Synced ${parts.join(', ')} and ${plural(s.connections, 'connection')}.`;
    if (s.missing.length) {
      const names = s.missing.slice(0, 3).join(', ') + (s.missing.length > 3 ? ', …' : '');
      text += ` ${s.missing.length} ref${s.missing.length === 1 ? ' points' : 's point'} to a model with no file (red): ${names}.`;
    } else if (!s.connections && s.models > 1) {
      text += ' No model uses ref() or source() yet, so there are no lines.';
    }
    return text;
  }

  // ------------------------------------------------------------------ integrations
  // Integration UIs (media/integrations/<id>.js) are loaded before this file and
  // queue themselves in window.dbtFlowPlugins as { id, init(api) }. Each gets the
  // small API below. Every hook call is wrapped, so a broken integration UI is
  // logged to the console and the canvas carries on without it.

  function runHooks(name, ...args) {
    const out = [];
    for (const h of hooks[name]) {
      try {
        const r = h.fn(...args);
        if (r) out.push(r);
      } catch (err) {
        console.error(`dbt Flow: the ${h.id} ${name} hook failed`, err);
      }
    }
    return out;
  }

  const pluginItems = (name, ...args) => runHooks(name, ...args).flat().filter(Boolean);

  /** Zooms out (never in) and centres so that all the given boxes are visible. */
  function fitTo(ids) {
    const pts = ids.map((id) => pos.get(id)).filter(Boolean);
    if (!pts.length) return;
    const r = viewport.getBoundingClientRect();
    const minX = Math.min(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxX = Math.max(...pts.map((p) => p.x + W));
    const maxY = Math.max(...pts.map((p) => p.y + H));
    const k = Math.max(MIN_K, Math.min(t.k, 1.1, (r.width - 160) / (maxX - minX), (r.height - 140) / (maxY - minY)));
    t = { k, x: r.width / 2 - ((minX + maxX) / 2) * k, y: r.height / 2 - ((minY + maxY) / 2) * k };
    applyTransform();
  }

  function pluginApi(id) {
    return Object.freeze({
      on(name, fn) {
        if (hooks[name] && typeof fn === 'function') hooks[name].push({ id, fn });
      },
      /** Messages from an integration UI always carry its prefix: "<id>/<type>". */
      post: (type, payload = {}) => post({ ...payload, type: `${id}/${type}` }),
      /** Tells the extension not to replay this integration's last result. */
      forget: () => post({ type: 'integrationForget', id }),
      view: () => view,
      nodeEl: (nodeId) => nodeEls.get(nodeId) || null,
      edges: () => edgeEls.map(({ e, g, line }) => ({ from: e.from, to: e.to, g, line })),
      edgeLayer,
      viewport,
      isTB,
      toast,
      el,
      svg,
      centerOn,
      fitTo,
      select,
      setOverlay(active) {
        overlayActive = !!active;
        if (view) applyHighlight();
      },
    });
  }

  function loadPlugins() {
    for (const p of Array.isArray(window.dbtFlowPlugins) ? window.dbtFlowPlugins : []) {
      try {
        if (p && typeof p.id === 'string' && typeof p.init === 'function') p.init(pluginApi(p.id));
      } catch (err) {
        console.error(`dbt Flow: the ${p && p.id} canvas add-on could not start`, err);
      }
    }
  }

  // ------------------------------------------------------------------ messages

  let first = true;
  window.addEventListener('message', (e) => {
    const msg = e.data;
    runHooks('message', msg);
    if (msg.type === 'graph') {
      if (drag && drag.mode === 'node') drag = null;
      if (!msg.view) {
        view = null;
        const empty = $('empty');
        empty.hidden = false;
        empty.innerHTML = '';
        empty.append(el('p', 'empty-title', 'No folder open'));
        empty.append(el('p', 'empty-text', 'Open the folder that holds your dbt project to see its models.'));
        return;
      }
      view = msg.view;
      computeColors();
      viewport.classList.toggle('tb', isTB());
      render();
      if (first) {
        first = false;
        if (hadSavedView) applyTransform();
        else fit(true);
      }
    } else if (msg.type === 'fit') {
      fit();
    } else if (msg.type === 'synced') {
      fit();
      toast(syncSummary(msg.summary), 6000);
    } else if (msg.type === 'activeFile') {
      // The extension resends this after every change; only react when the file really changed.
      if (msg.id === activeId) return;
      activeId = msg.id;
      // A highlighted lineage follows the editor, so the box you switch to is never left dimmed.
      if (activeId && selected && selected !== activeId) selected = activeId;
      applyHighlight();
    }
  });

  loadPlugins();
  applyTransform();
  post({ type: 'ready' });
})();
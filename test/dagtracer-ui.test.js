'use strict';
// The DAGtracer canvas add-on (media/integrations/dagtracer.js) in a small fake DOM:
// menus, overlay classes, the ✕ on the cut connection, the panel, Esc and the
// "not in this box" case. The add-on only sees the API main.js gives it, so the
// fake API below is the whole contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

class ClassList { constructor() { this.s = new Set(); } add(...c) { c.forEach((x) => this.s.add(x)); } remove(...c) { c.forEach((x) => this.s.delete(x)); } contains(c) { return this.s.has(c); } toggle(c, on) { (on === undefined ? !this.s.has(c) : on) ? this.s.add(c) : this.s.delete(c); } }
class El {
  constructor(tag, cls) { this.tag = tag; this.classList = new ClassList(); if (cls) cls.split(' ').forEach((c) => c && this.classList.add(c)); this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } }; this._text = ''; this.hidden = false; this.title = ''; this.parent = null; this.offsetWidth = 10; }
  set textContent(v) { this._text = v; this.children = []; } get textContent() { return this._text + this.children.map((c) => c.textContent || '').join(''); }
  set className(v) { this.classList = new ClassList(); v.split(' ').forEach((c) => c && this.classList.add(c)); }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  querySelectorAll(sel) { const cls = sel.replace('.', ''); const out = []; const walk = (e) => { for (const c of e.children || []) { if (c.classList && c.classList.contains(cls)) out.push(c); walk(c); } }; walk(this); return out; }
  addEventListener(t, fn) { this.listeners[t] = fn; } setAttribute(k, v) { this.attrs[k] = v; }
  getTotalLength() { return 100; } getPointAtLength(l) { return { x: l, y: 5 }; }
}

function loadAddon() {
  global.window = {};
  global.document = { createTextNode: (t) => ({ textContent: t }) };
  const file = path.join(__dirname, '..', 'media', 'integrations', 'dagtracer.js');
  delete require.cache[require.resolve(file)];
  require(file);
  return window.dbtFlowPlugins[0];
}

test('dagtracer add-on: menu, overlay, panel, Esc and the absent case', () => {
  const plugin = loadAddon();
  assert.equal(plugin.id, 'dagtracer');
  const ids = ['raw_stores', 'source3', 'source4', 'prep1', 'prep2', 'mart'];
  const view = { nodes: ids.map((id) => ({ id, name: id, kind: id.startsWith('raw') ? 'seed' : 'model' })), edges: [{ from: 'raw_stores', to: 'source3' }, { from: 'source3', to: 'prep2' }, { from: 'source4', to: 'prep2' }, { from: 'prep1', to: 'mart' }, { from: 'prep2', to: 'mart' }] };
  const nodeEls = new Map(ids.map((id) => [id, Object.assign(new El('div', 'node'), { title: id })]));
  const edgeEls = view.edges.map((e) => ({ ...e, g: new El('g', 'edge'), line: new El('path', 'line') }));
  const viewport = new El('main', 'viewport');
  const edgeLayer = new El('g');
  const hooks = {}; const posted = []; const toasts = []; let overlay = null; let fitted = null;
  plugin.init({
    on: (n, fn) => (hooks[n] = hooks[n] || []).push(fn),
    post: (type, p = {}) => posted.push({ ...p, type: `dagtracer/${type}` }),
    forget: () => posted.push({ type: 'integrationForget', id: 'dagtracer' }),
    view: () => view, nodeEl: (id) => nodeEls.get(id), edges: () => edgeEls, edgeLayer, viewport,
    toast: (t) => toasts.push(t), el: (t, c, txt) => { const e = new El(t, c); if (txt != null) e.textContent = txt; return e; }, svg: (t, c) => new El(t, c),
    centerOn: () => {}, fitTo: (x) => (fitted = x), select: () => {}, setOverlay: (a) => (overlay = a),
  });
  const fire = (name, ...a) => (hooks[name] || []).map((fn) => fn(...a));
  const panel = viewport.children[0];

  // Not ready: no menu items.
  assert.deepEqual(fire('nodeMenu', view.nodes[1]), [null]);
  fire('message', { type: 'integrations', list: [{ id: 'dagtracer', state: 'ready' }] });
  const items = fire('nodeMenu', view.nodes[4])[0];
  assert.equal(items[0].label, 'Trace column…');
  items[0].run();
  assert.deepEqual(posted.at(-1), { id: 'prep2', type: 'dagtracer/traceBox' });

  // Started → spinner panel.
  fire('message', { type: 'dagtracer/started', column: 'region', direction: 'both', starts: ['prep2'] });
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /From prep2, up and down\. Running dgt/);

  // Real result shape from the integration (prep2 region both).
  const trace = {
    column: 'region', columnType: 'VARCHAR', values: [], direction: 'both', starts: ['prep2'], partial: false, warnings: [],
    nodes: { prep2: { status: 'present', level: 0, start: true, columnType: 'VARCHAR' }, raw_stores: { status: 'present', level: -2 }, source3: { status: 'present', level: -1 }, source4: { status: 'absent', level: -1 }, mart: { status: 'absent', level: 1 } },
    crossings: [{ from: 'prep2', to: 'mart', path: ['prep2', 'mart'], cause: 'column_dropped', values: [], uncertain: false, edge: { from: 'prep2', to: 'mart' }, onCanvas: true }],
    markers: [{ id: 'raw_stores', cause: 'present_at_source', direction: 'up', uncertain: false, values: {} }],
    findings: [], unmapped: [],
  };
  fire('message', { type: 'dagtracer/result', request: { column: 'region', direction: 'both', starts: ['prep2'] }, trace, absent: null, skipped: [], errors: [] });
  assert.equal(overlay, true);
  assert.deepEqual(fitted.sort(), Object.keys(trace.nodes).sort());
  const cls = (id) => [...nodeEls.get(id).classList.s].filter((c) => c.startsWith('dgt')).sort().join(' ');
  assert.equal(cls('prep2'), 'dgt-has dgt-start');
  assert.equal(cls('raw_stores'), 'dgt-has');
  assert.equal(cls('source4'), 'dgt-lacks');
  assert.equal(cls('mart'), 'dgt-lost');
  assert.equal(cls('prep1'), 'dgt-off');
  const ecls = (f, t) => [...edgeEls.find((e) => e.from === f && e.to === t).g.classList.s].filter((c) => c.startsWith('dgt')).join(' ');
  assert.equal(ecls('source3', 'prep2'), 'dgt-flow');
  assert.equal(ecls('prep2', 'mart'), 'dgt-cut');
  assert.equal(ecls('prep1', 'mart'), 'dgt-off');
  assert.equal(edgeLayer.children.length, 1, 'one ✕');
  assert.equal(edgeLayer.children[0].attrs.transform, 'translate(50,5)');
  assert.match(nodeEls.get('mart').textContent, /lost here/);
  assert.match(nodeEls.get('raw_stores').textContent, /starts here/);
  assert.match(nodeEls.get('prep2').title, /region: has it \(VARCHAR\)/);
  assert.match(panel.textContent, /Comes from.*raw_stores/s);
  assert.match(panel.textContent, /Stops at.*prep2 → mart/s);
  assert.ok(viewport.classList.contains('dgt-anim'));

  // Re-render (canvas rebuilds boxes) keeps the overlay and does not duplicate badges or marks.
  fire('decorate'); fire('decorate');
  assert.equal(edgeLayer.children.length, 1);
  assert.equal(nodeEls.get('mart').querySelectorAll('.dgt-badges').length, 1);

  // Menu on another box offers the same column.
  const more = fire('nodeMenu', view.nodes[3])[0].map((i) => i.label);
  assert.deepEqual(more, ['Trace column…', 'Trace region from here', 'Clear column trace']);

  // Esc clears everything.
  assert.deepEqual(fire('escape'), [true]);
  assert.equal(overlay, false);
  assert.equal(cls('mart'), '');
  assert.equal(nodeEls.get('prep2').title, 'prep2');
  assert.equal(edgeLayer.children.length, 0);
  assert.equal(panel.hidden, true);
  assert.deepEqual(posted.at(-1), { type: 'integrationForget', id: 'dagtracer' });
  assert.deepEqual(fire('escape'), [false]);

  // Absent: panel offers the upstream trace.
  fire('message', { type: 'dagtracer/result', request: { column: 'region', direction: 'both', starts: ['mart'] }, trace: null, absent: { id: 'mart', column: 'region' }, skipped: [], errors: [] });
  assert.match(panel.textContent, /mart has no column called region/);
  const btn = panel.children.find((c) => c.classList.contains('dgt-btn'));
  btn.listeners.click();
  assert.deepEqual(posted.at(-1), { starts: ['mart'], column: 'region', direction: 'up', type: 'dagtracer/trace' });

  // Errors become a toast.
  fire('message', { type: 'dagtracer/error', message: 'nope' });
  assert.deepEqual(toasts, ['nope']);
});

test('dagtracer add-on: never adds menu items before DAGtracer is ready', () => {
  const plugin = loadAddon();
  const hooks = {};
  const viewport = new El('main');
  plugin.init({
    on: (n, fn) => (hooks[n] = hooks[n] || []).push(fn), post() {}, forget() {}, view: () => null, nodeEl: () => null,
    edges: () => [], edgeLayer: new El('g'), viewport, toast() {}, el: (t, c, txt) => { const e = new El(t, c); if (txt != null) e.textContent = txt; return e; }, svg: (t, c) => new El(t, c),
    centerOn() {}, fitTo() {}, select() {}, setOverlay() {},
  });
  assert.equal(hooks.nodeMenu[0]({ id: 'a', kind: 'model' }), null);
  hooks.message[0]({ type: 'integrations', list: [{ id: 'dagtracer', state: 'missing' }] });
  assert.equal(hooks.nodeMenu[0]({ id: 'a', kind: 'model' }), null);
  hooks.message[0]({ type: 'integrations', list: [{ id: 'dagtracer', state: 'ready' }] });
  assert.equal(hooks.nodeMenu[0]({ id: 'x', kind: 'planned' }), null, 'boxes without a file cannot be traced');
  // A result with no view (no project) must not throw.
  hooks.message[0]({ type: 'dagtracer/result', request: { column: 'c', direction: 'both', starts: ['a'] }, trace: null, absent: null, skipped: [], errors: [{ id: 'a', message: 'boom' }] });
  assert.match(viewport.children[0].textContent, /a: boom/);
});

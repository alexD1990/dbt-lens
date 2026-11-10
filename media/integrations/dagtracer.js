// DAGtracer on the canvas: trace a column and see where it comes from and where it stops.
// Loaded before main.js. It only talks to the canvas through the API main.js hands it
// (see "integrations" in main.js), so if anything here breaks, the canvas still works.
(function () {
  'use strict';

  const TRACEABLE = new Set(['model', 'seed', 'snapshot', 'source']);
  const STEP_MS = 280; // delay per level of the wave that spreads out from the start box
  const NODE_CLASSES = ['dgt-has', 'dgt-lacks', 'dgt-lost', 'dgt-unknown', 'dgt-off', 'dgt-start', 'dgt-flash'];
  const EDGE_CLASSES = ['dgt-flow', 'dgt-cut', 'dgt-maybe', 'dgt-off'];
  const STATUS_TEXT = { present: 'has it', absent: 'does not have it', unknown: 'unknown (not in the catalog, or ephemeral)' };
  const BADGE = {
    present_at_source: ['starts here', 'ok'],
    column_appears: ['appears here', 'ok'],
    present_at_leaf: ['reaches here', 'ok'],
    column_absent_at_source: ['never had it', 'muted'],
    column_absent_at_leaf: ['never had it', 'muted'],
    value_present_at_source: ['starts here', 'ok'],
    value_appears: ['appears here', 'ok'],
    value_present_at_leaf: ['reaches here', 'ok'],
  };
  const ORIGIN = new Set(['present_at_source', 'column_appears', 'value_present_at_source', 'value_appears']);
  const ENDS = new Set(['present_at_leaf', 'value_present_at_leaf']);

  (window.dbtFlowPlugins = window.dbtFlowPlugins || []).push({ id: 'dagtracer', init });

  function init(api) {
    let ready = false;
    let busy = null; // the request while dgt runs
    let result = null; // the last dagtracer/result
    let animate = false;
    let animTimer = null;
    const marks = []; // { outer, line }

    const panel = api.el('div', 'hud dgt-panel');
    panel.hidden = true;
    panel.addEventListener('wheel', (e) => e.stopPropagation());
    api.viewport.append(panel);

    // ---------------------------------------------------------------- hooks

    api.on('message', (msg) => {
      if (msg.type === 'integrations') {
        const me = (msg.list || []).find((s) => s.id === 'dagtracer');
        ready = !!me && me.state === 'ready';
      } else if (msg.type === 'dagtracer/started') {
        busy = msg;
        renderPanel();
      } else if (msg.type === 'dagtracer/result') {
        busy = null;
        result = msg;
        animate = !!msg.trace;
        api.setOverlay(!!msg.trace);
        if (msg.trace) api.select(null);
        decorate();
        renderPanel();
        if (msg.trace) api.fitTo(Object.keys(msg.trace.nodes));
      } else if (msg.type === 'dagtracer/error') {
        busy = null;
        renderPanel();
        api.toast(msg.message, 5200);
      }
    });

    api.on('nodeMenu', (n) => {
      if (!ready || !TRACEABLE.has(n.kind)) return null;
      const items = [{ label: 'Trace column…', hint: 'DAGtracer', disabled: !!busy, run: () => api.post('traceBox', { id: n.id }) }];
      const col = result && result.request && result.request.column;
      const sameBox = result && result.request && result.request.starts.length === 1 && result.request.starts[0] === n.id;
      if (col && !sameBox) {
        items.push({ label: `Trace ${col} from here`, disabled: !!busy, run: () => api.post('traceBox', { id: n.id, column: col }) });
      }
      if (result) items.push({ label: 'Clear column trace', hint: 'Esc', run: clear });
      return items;
    });

    api.on('canvasMenu', () => (result ? [{ label: 'Clear column trace', hint: 'Esc', run: clear }] : null));
    api.on('decorate', decorate);
    api.on('edgesMoved', placeMarks);
    api.on('escape', () => {
      if (!result) return false;
      clear();
      return true;
    });

    // ---------------------------------------------------------------- overlay

    function clear() {
      result = null;
      busy = null;
      animate = false;
      api.setOverlay(false);
      undecorate();
      renderPanel();
      api.forget();
    }

    function undecorate() {
      for (const { outer } of marks) outer.remove();
      marks.length = 0;
      api.viewport.classList.remove('dgt-on', 'dgt-anim');
      const view = api.view();
      if (!view) return;
      for (const n of view.nodes) {
        const node = api.nodeEl(n.id);
        if (!node) continue;
        node.classList.remove(...NODE_CLASSES);
        node.querySelectorAll('.dgt-badges').forEach((b) => b.remove());
        if (node.dataset.dgtTitle !== undefined) {
          node.title = node.dataset.dgtTitle;
          delete node.dataset.dgtTitle;
        }
      }
      for (const { g } of api.edges()) g.classList.remove(...EDGE_CLASSES);
    }

    /** Runs after every render (the canvas rebuilds its boxes) and when a result arrives. */
    function decorate() {
      undecorate();
      const tr = result && result.trace;
      const view = api.view();
      if (!tr || !view) return;
      api.viewport.classList.add('dgt-on');

      const key = (a, b) => `${a}\u0000${b}`;
      const lost = new Set(tr.crossings.map((c) => c.edge.to));
      const cut = new Map(tr.crossings.map((c) => [key(c.edge.from, c.edge.to), c]));
      const rank = (id) => (tr.nodes[id] ? Math.abs(tr.nodes[id].level) : 0);
      const badges = new Map();
      const badge = (id, text, cls) => {
        if (!badges.has(id)) badges.set(id, []);
        if (!badges.get(id).some((b) => b.text === text)) badges.get(id).push({ text, cls });
      };
      for (const id of tr.starts) badge(id, 'traced from', 'start');
      for (const m of tr.markers) if (BADGE[m.cause]) badge(m.id, BADGE[m.cause][0] + (m.uncertain ? '?' : ''), BADGE[m.cause][1]);
      for (const c of tr.crossings) badge(c.edge.to, c.uncertain ? 'lost here?' : 'lost here', c.uncertain ? 'warn' : 'bad');

      let maxRank = 0;
      for (const n of view.nodes) {
        const node = api.nodeEl(n.id);
        if (!node) continue;
        const st = tr.nodes[n.id];
        let cls = 'dgt-off';
        if (st && st.status === 'present') cls = 'dgt-has';
        else if (st && st.status === 'unknown') cls = 'dgt-unknown';
        else if (st) cls = lost.has(n.id) ? 'dgt-lost' : 'dgt-lacks';
        node.classList.add(cls);
        if (st && st.start) node.classList.add('dgt-start');
        node.style.setProperty('--dgt-d', `${rank(n.id) * STEP_MS}ms`);
        if (st) {
          maxRank = Math.max(maxRank, rank(n.id));
          node.dataset.dgtTitle = node.title;
          node.title = `${node.title}\n${tr.column}: ${STATUS_TEXT[st.status] || st.status}${st.columnType ? ` (${st.columnType})` : ''}`;
        }
        const list = badges.get(n.id);
        if (list) {
          const wrap = api.el('span', 'dgt-badges');
          for (const b of list) wrap.append(api.el('span', `dgt-badge ${b.cls}`, b.text));
          node.append(wrap);
        }
      }

      for (const { from, to, g, line } of api.edges()) {
        const c = cut.get(key(from, to));
        const a = tr.nodes[from];
        const b = tr.nodes[to];
        if (c) {
          g.classList.add('dgt-cut');
          if (c.uncertain) g.classList.add('dgt-maybe');
          addMark(c, line, rank(to));
        } else if (a && b && a.status === 'present' && b.status === 'present') {
          g.classList.add('dgt-flow');
        } else {
          g.classList.add('dgt-off');
        }
        g.style.setProperty('--dgt-d', `${Math.max(rank(from), rank(to)) * STEP_MS}ms`);
      }
      placeMarks();

      if (animate) {
        animate = false;
        api.viewport.classList.add('dgt-anim');
        clearTimeout(animTimer);
        animTimer = setTimeout(() => api.viewport.classList.remove('dgt-anim'), (maxRank + 1) * STEP_MS + 900);
      }
    }

    /** A ✕ in the middle of a connection. The outer group is moved; the inner one animates. */
    function addMark(c, line, r) {
      const outer = api.svg('g', 'dgt-mark' + (c.uncertain ? ' dgt-maybe' : ''));
      const inner = api.svg('g', 'dgt-mark-in');
      inner.style.setProperty('--dgt-d', `${r * STEP_MS}ms`);
      const title = api.svg('title');
      title.textContent = `${result.trace.column} stops between ${c.from} and ${c.to}${c.uncertain ? ' (uncertain: it passes a model dgt cannot see)' : ''}`;
      const circle = api.svg('circle');
      circle.setAttribute('r', '10');
      const cross = api.svg('path');
      cross.setAttribute('d', 'M-4,-4L4,4M4,-4L-4,4');
      inner.append(circle, cross);
      outer.append(title, inner);
      api.edgeLayer.append(outer);
      marks.push({ outer, line });
    }

    function placeMarks() {
      for (const { outer, line } of marks) {
        try {
          const p = line.getPointAtLength(line.getTotalLength() / 2);
          outer.setAttribute('transform', `translate(${p.x},${p.y})`);
        } catch {
          /* the path is not laid out yet */
        }
      }
    }

    // ---------------------------------------------------------------- panel

    function renderPanel() {
      panel.textContent = '';
      if (busy) {
        panel.hidden = false;
        head(busy.column, null, true);
        sub(`${describe(busy)}. Running dgt…`);
        return;
      }
      if (!result) {
        panel.hidden = true;
        return;
      }
      panel.hidden = false;
      const { request, trace, absent, skipped = [], errors = [] } = result;

      if (absent) {
        head(absent.column);
        sub(`Not in ${absent.id}`);
        note(`${absent.id} has no column called ${absent.column}.`);
        const btn = api.el('button', 'dgt-btn', 'Show where it stops upstream');
        btn.addEventListener('click', () => api.post('trace', { starts: [absent.id], column: absent.column, direction: 'up' }));
        panel.append(btn);
      } else if (trace) {
        head(trace.column, trace.columnType);
        sub(describe(request));
        const origins = trace.markers.filter((m) => ORIGIN.has(m.cause));
        const ends = trace.markers.filter((m) => ENDS.has(m.cause));
        section('Comes from', origins.map((m) => ({ text: m.id + (m.uncertain ? ' ?' : ''), id: m.id, cls: 'ok' })));
        section('Stops at', trace.crossings.map((c) => ({ text: `${c.from} → ${c.to}${c.uncertain ? ' ?' : ''}`, id: c.to, cls: c.uncertain ? 'warn' : 'bad' })));
        section('Reaches', ends.map((m) => ({ text: m.id, id: m.id, cls: 'ok' })));
        if (!trace.crossings.length) note(`${trace.column} does not stop anywhere along this path.`);
        if (trace.crossings.some((c) => c.uncertain)) note('? = it passes a model dgt cannot see (e.g. ephemeral), so the exact place is uncertain.');
        if (trace.unmapped.length) note(`Not on the canvas: ${trace.unmapped.join(', ')}`);
        for (const w of trace.warnings) note(w, 'warn');
        legend();
      } else {
        head(request.column);
        sub(describe(request));
        if (!errors.length) note('Nothing to show.');
      }
      for (const s of skipped) note(`Skipped ${s.id}: ${s.reason}`);
      for (const e of errors) note(`${e.id}: ${e.message}`, 'warn');
    }

    function describe(req) {
      const starts = req.starts.join(', ');
      if (req.direction === 'both') return `From ${starts}, up and down`;
      if (req.direction === 'up') return `Why it is not in ${starts}`;
      return `Downstream from ${starts}`;
    }

    function head(column, type, spinning) {
      const h = api.el('div', 'dgt-head');
      const title = api.el('div', 'dgt-title');
      if (spinning) title.append(api.el('span', 'dgt-spin'));
      title.append(api.el('span', 'dgt-col', column));
      if (type) title.append(api.el('span', 'dgt-type', type));
      const close = api.el('button', 'dgt-close', '×');
      close.title = 'Clear the trace (Esc)';
      close.setAttribute('aria-label', 'Clear the trace');
      close.addEventListener('click', clear);
      h.append(title, close);
      panel.append(h);
    }

    function sub(text) {
      panel.append(api.el('div', 'dgt-sub', text));
    }

    function note(text, cls) {
      panel.append(api.el('p', 'dgt-note' + (cls ? ` ${cls}` : ''), text));
    }

    function section(title, rows) {
      if (!rows.length) return;
      const sec = api.el('div', 'dgt-sec');
      sec.append(api.el('div', 'dgt-sec-title', title));
      for (const r of rows) {
        const row = api.el('button', `dgt-row ${r.cls}`);
        row.append(api.el('span', 'dgt-dot'), api.el('span', 'dgt-row-text', r.text));
        row.title = `Show ${r.id}`;
        row.addEventListener('click', () => flash(r.id));
        sec.append(row);
      }
      panel.append(sec);
    }

    function legend() {
      const l = api.el('div', 'dgt-legend');
      for (const [cls, text] of [['ok', 'has the column'], ['bad', 'stops here'], ['muted', 'does not have it']]) {
        const k = api.el('span', `dgt-key ${cls}`);
        k.append(api.el('i'), document.createTextNode(text));
        l.append(k);
      }
      panel.append(l);
    }

    function flash(id) {
      api.centerOn(id);
      const node = api.nodeEl(id);
      if (!node) return;
      node.classList.remove('dgt-flash');
      void node.offsetWidth; // restart the animation
      node.classList.add('dgt-flash');
    }
  }
})();

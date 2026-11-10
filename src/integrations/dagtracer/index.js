'use strict';

/**
 * DAGtracer (dgt) integration: traces where a column stops in the DAG.
 *
 * dgt runs as its own process with `-o json`; contract.js reads its output and
 * idmap.js turns it into box ids. Nothing here touches the model or files.
 *
 * Canvas → extension:  dagtracer/trace { starts: [boxId], column, direction: 'up'|'down' }
 * Extension → canvas:  dagtracer/started { column, direction, starts }
 *                      dagtracer/result  { trace, skipped, errors }
 *                      dagtracer/error   { action, message }   (sent by the host or here)
 */

const { fromRun, mergeTraces } = require('./contract');
const { startArgFor, toCanvasTrace } = require('./idmap');

const MAX_STARTS = 50;
const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const VERSION_RE = /\bdgt\s+(\d+)\.(\d+)\.(\d+)/;

module.exports = {
  id: 'dagtracer',
  title: 'DAGtracer',

  async detect(api) {
    const exe = executable(api);
    const r = await api.run(exe, ['--version'], { timeoutMs: 15_000 });
    if (r.error === 'not_found') {
      return {
        ok: false,
        state: 'missing',
        reason: `"${exe}" was not found. Install dgt, or set dbtFlow.integrations.dagtracer.executable to its full path.`,
      };
    }
    if (!r.ok) return { ok: false, state: 'failed', reason: firstLine(r.stderr) || `"${exe} --version" failed (${r.error || `exit ${r.code}`}).` };
    const m = VERSION_RE.exec(`${r.stdout}\n${r.stderr}`);
    if (!m) return { ok: false, state: 'incompatible', reason: `"${exe} --version" did not print a dgt version.` };
    return { ok: true, version: `${m[1]}.${m[2]}.${m[3]}` };
  },

  activate(api) {
    let controller = null;
    return {
      handlers: {
        trace: async (msg) => {
          controller = new AbortController();
          try {
            await trace(api, msg, controller.signal);
          } finally {
            controller = null;
          }
        },
      },
      dispose() {
        if (controller) controller.abort();
      },
    };
  },
};

async function trace(api, msg, signal) {
  const column = String(msg.column || '').trim();
  const direction = msg.direction === 'down' ? 'down' : msg.direction === 'up' ? 'up' : null;
  const starts = Array.isArray(msg.starts) ? [...new Set(msg.starts.map(String))] : [];
  const refuse = (message) => {
    api.log(`trace refused: ${message}`);
    api.post('error', { action: 'trace', message });
  };

  if (!COLUMN_RE.test(column)) return refuse('Give a column name (letters, numbers and _).');
  if (!direction) return refuse('Direction must be up or down.');
  if (!starts.length) return refuse('Choose at least one box to start from.');
  if (starts.length > MAX_STARTS) return refuse(`Choose at most ${MAX_STARTS} boxes to start from.`);
  const root = api.projectRoot();
  if (!root) return refuse('No dbt project is open.');
  const view = api.view();

  api.post('started', { column, direction, starts });
  const exe = executable(api);
  const timeoutMs = Number(api.setting('timeoutSeconds', 120)) * 1000;
  const traces = [];
  const skipped = [];
  const errors = [];

  for (const id of starts) {
    if (signal.aborted) break;
    const arg = startArgFor(id, view);
    if (!arg) {
      skipped.push({ id, reason: 'This box has no model, seed, snapshot or source behind it.' });
      continue;
    }
    const run = await api.run(
      exe,
      [arg, '-c', column, '-d', direction, '-o', 'json', '--project-dir', root],
      { cwd: root, timeoutMs, signal }
    );
    const r = fromRun(run);
    if (!r.ok) {
      errors.push({ id, kind: r.kind, message: r.message });
      continue;
    }
    // Starting downstream from several boxes: only those that have the column take part.
    if (starts.length > 1 && direction === 'down' && r.trace.start.status !== 'present') {
      skipped.push({ id, reason: `${column} is not in ${id}.` });
      continue;
    }
    traces.push(r.trace);
  }

  const merged = mergeTraces(traces);
  const result = { trace: merged ? toCanvasTrace(merged, view) : null, skipped, errors };
  logSummary(api, { column, direction, starts }, result);
  api.post('result', result);
}

/** A readable summary in the output channel, so a trace can be checked without the canvas. */
function logSummary(api, { column, direction, starts }, { trace, skipped, errors }) {
  const lines = [`Trace "${column}" ${direction === 'up' ? 'upstream' : 'downstream'} from ${starts.join(', ')}:`];
  if (trace) {
    for (const c of trace.crossings) {
      const via = c.path.length > 2 ? ` (via ${c.path.slice(1, -1).join(', ')})` : '';
      lines.push(`  ✕ ${c.from} → ${c.to}${via}: ${column} stops here${c.uncertain ? ' (uncertain)' : ''}`);
    }
    if (!trace.crossings.length) lines.push(`  No connection where ${column} stops.`);
    for (const m of trace.markers) lines.push(`  · ${m.id}: ${m.cause}${m.uncertain ? ' (uncertain)' : ''}`);
    const has = Object.entries(trace.nodes).filter(([, n]) => n.status === 'present').map(([id]) => id);
    const lacks = Object.entries(trace.nodes).filter(([, n]) => n.status === 'absent').map(([id]) => id);
    const unknown = Object.entries(trace.nodes).filter(([, n]) => n.status === 'unknown').map(([id]) => id);
    if (has.length) lines.push(`  Has ${column}: ${has.join(', ')}`);
    if (lacks.length) lines.push(`  Lacks ${column}: ${lacks.join(', ')}`);
    if (unknown.length) lines.push(`  Unknown: ${unknown.join(', ')}`);
    if (trace.unmapped.length) lines.push(`  Not on the canvas: ${trace.unmapped.join(', ')}`);
    for (const w of trace.warnings) lines.push(`  Warning from dgt: ${w}`);
  }
  for (const s of skipped) lines.push(`  Skipped ${s.id}: ${s.reason}`);
  for (const e of errors) lines.push(`  Error for ${e.id} (${e.kind}): ${e.message}`);
  for (const line of lines) api.log(line);
}

function executable(api) {
  return String(api.setting('executable', 'dgt'));
}

function firstLine(text) {
  return String(text || '').trim().split('\n').find(Boolean) || '';
}

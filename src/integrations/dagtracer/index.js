'use strict';

/**
 * DAGtracer (dgt) integration: shows where a column comes from and where it stops.
 *
 * dgt runs as its own process with `-o json`; contract.js reads its output and
 * idmap.js turns it into box ids. Nothing here touches the model or files.
 *
 * Canvas → extension:
 *   dagtracer/traceBox { id, column? }   trace one box up and down; asks for the
 *                                        column (picked from catalog.json) when missing
 *   dagtracer/trace    { starts: [boxId], column, direction: 'up'|'down'|'both' }
 * Extension → canvas:
 *   dagtracer/started  { column, direction, starts }
 *   dagtracer/result   { trace, absent, skipped, errors, request }
 *                      absent: { id, column } when the column is not in the start box
 *   dagtracer/error    { action, message }   (sent by the host or here)
 */

const { fromRun, mergeTraces } = require('./contract');
const { startArgFor, toCanvasTrace } = require('./idmap');
const { columnsFor } = require('./catalog');

const MAX_STARTS = 50;
const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const VERSION_RE = /\bdgt\s+(\d+)\.(\d+)\.(\d+)/;
const DIRECTIONS = new Set(['up', 'down', 'both']);
const ARTIFACT_HINT = 'Run dbt build and dbt docs generate in the project first.';

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
    const guarded = (fn) => async (msg) => {
      controller = new AbortController();
      try {
        await fn(api, msg, controller.signal);
      } finally {
        controller = null;
      }
    };
    return {
      handlers: { trace: guarded(trace), traceBox: guarded(traceBox) },
      dispose() {
        if (controller) controller.abort();
      },
    };
  },
};

/** Trace one box in both directions. Asks for the column when the message has none. */
async function traceBox(api, msg, signal) {
  const id = String(msg.id || '');
  const view = api.view();
  if (!startArgFor(id, view)) return refuse(api, 'traceBox', `${id || 'This box'} has no model, seed, snapshot or source behind it.`);
  const root = api.projectRoot();
  if (!root) return refuse(api, 'traceBox', 'No dbt project is open.');

  let column = String(msg.column || '').trim();
  if (!column) {
    const columns = columnsFor(root, id);
    column = columns && columns.length
      ? await api.pick({
          title: `Trace a column from ${id}`,
          placeHolder: 'Pick a column, or type its name',
          items: columns.map((c) => ({ label: c.name, description: c.type || '' })),
          allowTyped: true,
        })
      : await api.ask({
          prompt: `Column to trace from ${id}`,
          placeHolder: 'e.g. region',
          validate: (v) => (COLUMN_RE.test(String(v).trim()) ? null : 'Use letters, numbers and _.'),
        });
    column = String(column || '').trim();
    if (!column) return; // cancelled
  }
  await trace(api, { starts: [id], column, direction: 'both' }, signal);
}

async function trace(api, msg, signal) {
  const column = String(msg.column || '').trim();
  const direction = DIRECTIONS.has(msg.direction) ? msg.direction : null;
  const starts = Array.isArray(msg.starts) ? [...new Set(msg.starts.map(String))] : [];

  if (!COLUMN_RE.test(column)) return refuse(api, 'trace', 'Give a column name (letters, numbers and _).');
  if (!direction) return refuse(api, 'trace', 'Direction must be up, down or both.');
  if (!starts.length) return refuse(api, 'trace', 'Choose at least one box to start from.');
  if (starts.length > MAX_STARTS) return refuse(api, 'trace', `Choose at most ${MAX_STARTS} boxes to start from.`);
  const root = api.projectRoot();
  if (!root) return refuse(api, 'trace', 'No dbt project is open.');
  const view = api.view();
  const request = { column, direction, starts };

  api.post('started', request);
  const exe = executable(api);
  const timeoutMs = Number(api.setting('timeoutSeconds', 120)) * 1000;
  const traces = [];
  const skipped = [];
  const errors = [];
  let absent = null;

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
      const hint = /manifest|catalog/i.test(r.message) ? `${/[.!?]$/.test(r.message) ? '' : '.'} ${ARTIFACT_HINT}` : '';
      errors.push({ id, kind: r.kind, message: r.message + hint });
      continue;
    }
    const isAbsent = r.trace.start.status !== 'present';
    // "Where does this column go?" needs the column in the start box.
    if (isAbsent && direction === 'both' && starts.length === 1) {
      absent = { id, column };
      continue;
    }
    // Starting downstream from several boxes: only those that have the column take part.
    if (isAbsent && direction === 'down' && starts.length > 1) {
      skipped.push({ id, reason: `${column} is not in ${id}.` });
      continue;
    }
    traces.push(r.trace);
  }

  const merged = mergeTraces(traces);
  const result = { request, trace: merged ? toCanvasTrace(merged, view) : null, absent, skipped, errors };
  logSummary(api, result);
  api.post('result', result);
}

function refuse(api, action, message) {
  api.log(`${action} refused: ${message}`);
  api.post('error', { action, message });
}

/** A readable summary in the output channel, so a trace can be checked without the canvas. */
function logSummary(api, { request, trace, absent, skipped, errors }) {
  const { column, direction, starts } = request;
  const dir = { up: 'upstream', down: 'downstream', both: 'up and down' }[direction];
  const lines = [`Trace "${column}" ${dir} from ${starts.join(', ')}:`];
  if (absent) lines.push(`  ${column} is not in ${absent.id}.`);
  if (trace) {
    for (const c of trace.crossings) {
      const via = c.path.length > 2 ? ` (via ${c.path.slice(1, -1).join(', ')})` : '';
      lines.push(`  ✕ ${c.from} → ${c.to}${via}: ${column} stops here${c.uncertain ? ' (uncertain)' : ''}`);
    }
    if (!trace.crossings.length) lines.push(`  No connection where ${column} stops.`);
    for (const m of trace.markers) lines.push(`  · ${m.id}: ${m.cause}${m.uncertain ? ' (uncertain)' : ''}`);
    const by = (status) => Object.entries(trace.nodes).filter(([, n]) => n.status === status).map(([id]) => id);
    if (by('present').length) lines.push(`  Has ${column}: ${by('present').join(', ')}`);
    if (by('absent').length) lines.push(`  Lacks ${column}: ${by('absent').join(', ')}`);
    if (by('unknown').length) lines.push(`  Unknown: ${by('unknown').join(', ')}`);
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

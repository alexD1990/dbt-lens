'use strict';

/**
 * The only file that knows dgt's JSON format (schema/dgt-output-1.0.schema.json
 * in the DAGtracer repo). It turns a dgt run into a plain trace object and
 * rejects anything it does not understand.
 *
 * Contract rules from dgt: minor versions only add fields, so unknown fields
 * are ignored; a new major version is refused.
 */

const { parseJson } = require('./util');

const SUPPORTED_MAJOR = 1;
const DROP_CAUSES = new Set(['column_dropped', 'value_dropped']);

/**
 * From a finished process ({ ok, code, stdout, stderr, error } from runTool)
 * to { ok: true, trace } or { ok: false, kind, message }.
 * kind: 'not_found' | 'timeout' | 'process' | 'bad_output' | 'incompatible' | 'tool_error'
 */
function fromRun(run) {
  if (run.error === 'not_found') return fail('not_found', 'dgt was not found.');
  if (run.error === 'timeout') return fail('timeout', 'dgt took too long and was stopped.');
  if (run.error === 'cancelled') return fail('cancelled', 'The trace was cancelled.');
  if (run.error) return fail('process', `dgt could not run (${run.error}). ${firstLine(run.stderr)}`.trim());

  const parsed = parseJson(run.stdout);
  if (!parsed.ok) {
    // dgt exits 2 with a JSON error document; without one, stderr is the best clue.
    const why = firstLine(run.stderr) || parsed.message;
    return fail(run.code === 0 ? 'bad_output' : 'process', why);
  }
  return parseDocument(parsed.value);
}

/** From a parsed dgt document to { ok: true, trace } or { ok: false, kind, message }. */
function parseDocument(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return fail('bad_output', 'dgt output is not a JSON object.');
  const version = String(doc.schema_version || '');
  const m = /^(\d+)\.(\d+)$/.exec(version);
  if (!m) return fail('bad_output', 'dgt output has no schema_version.');
  if (Number(m[1]) !== SUPPORTED_MAJOR) {
    return fail('incompatible', `dgt writes schema ${version}; NodeViz understands ${SUPPORTED_MAJOR}.x.`);
  }
  if (doc.status === 'error') {
    return fail('tool_error', (doc.error && doc.error.message) || 'dgt reported an error without a message.');
  }
  if (!['complete', 'partial'].includes(doc.status) || !doc.run || typeof doc.run !== 'object') {
    return fail('bad_output', 'dgt output has no run.');
  }
  try {
    return { ok: true, trace: toTrace(doc) };
  } catch (e) {
    return fail('bad_output', `dgt output is not in the expected shape (${e.message}).`);
  }
}

function toTrace(doc) {
  const run = doc.run;
  const start = { ...ref(run.start), status: str(run.start.status) };
  const nodes = [];
  for (const dir of ['up', 'down']) {
    const t = doc.traversals && doc.traversals[dir];
    if (!t) continue;
    for (const n of arr(t.nodes)) {
      nodes.push({
        ...ref(n),
        traversal: dir,
        level: num(n.level),
        status: str(n.status),
        values: obj(n.values),
        columnType: n.column_type == null ? null : String(n.column_type),
        unknownReason: n.unknown_reason == null ? null : String(n.unknown_reason),
        stopped: n.stopped === true,
        reachedFrom: n.reached_from == null ? null : String(n.reached_from),
      });
    }
  }
  const findings = arr(doc.findings).map((f) => ({
    direction: str(f.direction),
    level: num(f.level),
    cause: str(f.cause),
    node: ref(f.node),
    values: obj(f.values),
    uncertain: f.uncertain === true,
    candidates: arr(f.candidates).map(String),
    parents: arr(f.parents).map((p) => ({
      ...ref(p),
      status: str(p.status),
      values: obj(p.values),
      via: arr(p.via).map(String),
    })),
  }));
  return {
    schemaVersion: String(doc.schema_version),
    toolVersion: String(doc.tool_version || ''),
    partial: doc.status === 'partial',
    column: str(run.column),
    columnType: run.column_type == null ? null : String(run.column_type),
    values: arr(run.values).map(String),
    direction: str(run.direction),
    start,
    nodes,
    findings,
    warnings: arr(doc.warnings).map(String),
  };
}

/**
 * The connections where the column (or a tracked value) stops: from every
 * parent that still has it to the node that lost it. `via` lists unknown
 * (e.g. ephemeral) nodes in between, nearest the child first; such a crossing
 * is uncertain, because the loss may be in one of them.
 */
function crossings(trace) {
  const out = [];
  for (const f of trace.findings) {
    if (!DROP_CAUSES.has(f.cause)) continue;
    const lost = Object.keys(f.values);
    for (const p of f.parents) {
      let carried;
      if (f.cause === 'column_dropped') carried = p.status === 'present';
      else carried = lost.some((v) => p.values[v] === 'present');
      if (!carried) continue;
      out.push({
        from: p.uid,
        to: f.node.uid,
        via: p.via,
        cause: f.cause,
        values: f.cause === 'value_dropped' ? lost.filter((v) => p.values[v] === 'present') : [],
        uncertain: f.uncertain || p.via.length > 0,
      });
    }
  }
  return out;
}

/** Combines traces from several start nodes into one. Duplicates collapse. */
function mergeTraces(traces) {
  if (!traces.length) return null;
  const first = traces[0];
  const nodes = new Map();
  const findings = new Map();
  for (const t of traces) {
    // Each start node is part of the picture too, at level 0.
    const startKey = t.start.uid;
    if (!nodes.has(startKey)) {
      nodes.set(startKey, { ...t.start, traversal: null, level: 0, values: {}, columnType: t.columnType, unknownReason: null, stopped: false, reachedFrom: null });
    }
    for (const n of t.nodes) {
      const prev = nodes.get(n.uid);
      if (!prev || (prev.status === 'unknown' && n.status !== 'unknown')) nodes.set(n.uid, n);
    }
    for (const f of t.findings) {
      const key = [f.direction, f.cause, f.node.uid].join('|');
      if (!findings.has(key)) findings.set(key, f);
    }
  }
  return {
    ...first,
    starts: traces.map((t) => t.start),
    partial: traces.some((t) => t.partial),
    nodes: [...nodes.values()],
    findings: [...findings.values()],
    warnings: [...new Set(traces.flatMap((t) => t.warnings))],
  };
}

// ---------------------------------------------------------------- helpers

function ref(n) {
  if (!n || typeof n !== 'object') throw new Error('missing node reference');
  return { uid: str(n.unique_id), name: str(n.name), resourceType: str(n.resource_type) };
}

function str(v) {
  if (typeof v !== 'string') throw new Error(`expected text, got ${v === null ? 'null' : typeof v}`);
  return v;
}

function num(v) {
  if (typeof v !== 'number') throw new Error(`expected a number, got ${typeof v}`);
  return v;
}

const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {});

function firstLine(text) {
  return String(text || '').trim().split('\n').find(Boolean) || '';
}

function fail(kind, message) {
  return { ok: false, kind, message };
}

module.exports = { fromRun, parseDocument, crossings, mergeTraces, SUPPORTED_MAJOR };

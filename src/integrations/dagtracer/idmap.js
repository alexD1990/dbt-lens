'use strict';

/**
 * Translates between dgt's node references (dbt unique_ids) and dbt Lens's
 * box ids, and turns a trace into the shape the canvas draws.
 *
 * dbt Lens ids: models, seeds and snapshots by name; sources as
 * "source:<source_name>.<table_name>". dgt names sources "<source_name>.<table_name>".
 */

const { crossings } = require('./contract');

const TRACEABLE = new Set(['model', 'seed', 'snapshot', 'source']);
const DROP_CAUSES = new Set(['column_dropped', 'value_dropped']);

/** Box id for a dgt node reference { uid, name, resourceType }. */
function canvasIdOf(ref) {
  return ref.resourceType === 'source' ? `source:${ref.name}` : ref.name;
}

/**
 * Box id for a bare unique_id, e.g. "model.pkg.orders" -> "orders",
 * "source.pkg.raw.orders" -> "source:raw.orders". Anything else is returned as is.
 */
function canvasIdOfUid(uid) {
  const parts = String(uid).split('.');
  if (parts[0] === 'source' && parts.length >= 4) return `source:${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (['model', 'seed', 'snapshot'].includes(parts[0]) && parts.length >= 3) return parts[2];
  return String(uid);
}

/** The argument dgt takes as start node for a box, or null if the box cannot be traced. */
function startArgFor(id, view) {
  const n = view && Array.isArray(view.nodes) ? view.nodes.find((x) => x.id === id) : null;
  if (!n || !TRACEABLE.has(n.kind)) return null;
  return n.kind === 'source' ? id.slice('source:'.length) : n.name;
}

/** A merged trace (contract.mergeTraces) in box ids, ready for the canvas. */
function toCanvasTrace(trace, view) {
  const byUid = new Map();
  const remember = (r) => byUid.set(r.uid, canvasIdOf(r));
  for (const s of trace.starts || [trace.start]) remember(s);
  for (const n of trace.nodes) remember(n);
  for (const f of trace.findings) {
    remember(f.node);
    for (const p of f.parents) remember(p);
  }
  const idOf = (uid) => byUid.get(uid) || canvasIdOfUid(uid);

  const nodes = {};
  const startIds = new Set((trace.starts || [trace.start]).map(canvasIdOf));
  for (const n of trace.nodes) {
    nodes[canvasIdOf(n)] = {
      status: n.status,
      level: n.level,
      traversal: n.traversal,
      stopped: n.stopped,
      unknownReason: n.unknownReason,
      columnType: n.columnType,
      values: n.values,
      start: startIds.has(canvasIdOf(n)),
    };
  }

  const edgeSet = new Set(((view && view.edges) || []).map((e) => `${e.from}\u0000${e.to}`));
  const crossed = [];
  const seen = new Set();
  for (const c of crossings(trace)) {
    const from = idOf(c.from);
    const to = idOf(c.to);
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const path = [from, ...c.via.slice().reverse().map(idOf), to];
    crossed.push({
      from,
      to,
      path,
      cause: c.cause,
      values: c.values,
      uncertain: c.uncertain,
      // The edge the canvas marks: the last hop into the node that lost the column.
      edge: { from: path[path.length - 2], to },
      onCanvas: edgeSet.has(`${path[path.length - 2]}\u0000${to}`),
    });
  }

  const findings = trace.findings.map((f) => ({
    direction: f.direction,
    level: f.level,
    cause: f.cause,
    id: canvasIdOf(f.node),
    name: f.node.name,
    values: f.values,
    uncertain: f.uncertain,
    candidates: f.candidates.map(idOf),
    parents: f.parents.map((p) => ({ id: canvasIdOf(p), name: p.name, status: p.status, values: p.values, via: p.via.map(idOf) })),
  }));

  const markers = findings
    .filter((f) => !DROP_CAUSES.has(f.cause))
    .map((f) => ({ id: f.id, cause: f.cause, direction: f.direction, uncertain: f.uncertain, values: f.values }));

  const onCanvas = new Set(((view && view.nodes) || []).map((n) => n.id));
  const mentioned = new Set([...Object.keys(nodes), ...findings.map((f) => f.id), ...crossed.flatMap((c) => c.path)]);
  const unmapped = [...mentioned].filter((id) => !onCanvas.has(id)).sort();

  return {
    column: trace.column,
    columnType: trace.columnType,
    values: trace.values,
    direction: trace.direction,
    starts: [...startIds],
    partial: trace.partial,
    warnings: trace.warnings,
    nodes,
    crossings: crossed,
    markers,
    findings,
    unmapped,
  };
}

module.exports = { canvasIdOf, canvasIdOfUid, startArgFor, toCanvasTrace };

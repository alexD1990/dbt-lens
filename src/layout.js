'use strict';

/** Layered left-to-right DAG layout (longest-path layering + barycenter ordering). */

const NODE_W = 220;
const NODE_H = 58;
const COL_W = 300;
const ROW_H = 86;

/**
 * `minLayer(id)` is an optional lower bound on a box's column, used to keep
 * dbt layers in order (staging before intermediate before marts) even where
 * the files have no ref() between them. Connections always win: a box is
 * never placed left of something it depends on.
 */
function layeredLayout(ids, edges, sortKey = (id) => id, minLayer = () => 0) {
  const idSet = new Set(ids);
  const ins = new Map(ids.map((id) => [id, []]));
  const outs = new Map(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to) || e.from === e.to) continue;
    outs.get(e.from).push(e.to);
    ins.get(e.to).push(e.from);
  }

  // Longest path from roots via Kahn, starting each box at its layer hint.
  // Nodes left in a cycle keep their hint.
  const layer = new Map(ids.map((id) => [id, minLayer(id) || 0]));
  const indeg = new Map(ids.map((id) => [id, ins.get(id).length]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  while (queue.length) {
    const id = queue.shift();
    for (const t of outs.get(id)) {
      layer.set(t, Math.max(layer.get(t), layer.get(id) + 1));
      indeg.set(t, indeg.get(t) - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }

  // Pull pure roots (e.g. sources) right next to their first consumer.
  for (const id of ids) {
    if (ins.get(id).length === 0 && outs.get(id).length) {
      const minChild = Math.min(...outs.get(id).map((t) => layer.get(t)));
      layer.set(id, Math.max(minLayer(id) || 0, minChild - 1));
    }
  }

  // Close gaps left by layer hints that no box uses (e.g. no sources at all).
  const used = [...new Set(layer.values())].sort((a, b) => a - b);
  const compact = new Map(used.map((l, i) => [l, i]));
  for (const id of ids) layer.set(id, compact.get(layer.get(id)));

  const layers = [];
  for (const id of ids) {
    const l = layer.get(id);
    (layers[l] = layers[l] || []).push(id);
  }
  for (let i = 0; i < layers.length; i++) {
    layers[i] = (layers[i] || []).sort((a, b) => String(sortKey(a)).localeCompare(String(sortKey(b))));
  }

  const order = new Map();
  const reindex = () => layers.forEach((L) => L.forEach((id, i) => order.set(id, i)));
  reindex();
  const bary = (id, neighbours) => {
    const ns = neighbours.get(id);
    if (!ns.length) return order.get(id);
    return ns.reduce((s, n) => s + order.get(n), 0) / ns.length;
  };
  for (let sweep = 0; sweep < 6; sweep++) {
    const down = sweep % 2 === 0;
    const seq = down ? layers.map((_, i) => i) : layers.map((_, i) => layers.length - 1 - i);
    for (const i of seq) {
      const L = layers[i];
      const scores = new Map(L.map((id) => [id, bary(id, down ? ins : outs)]));
      L.sort((a, b) => scores.get(a) - scores.get(b) || order.get(a) - order.get(b));
      L.forEach((id, k) => order.set(id, k));
    }
  }

  const pos = {};
  layers.forEach((L, li) => {
    const offset = ((L.length - 1) * ROW_H) / 2;
    L.forEach((id, k) => {
      pos[id] = { x: li * COL_W, y: Math.round(k * ROW_H - offset) };
    });
  });
  return pos;
}

function overlaps(a, b) {
  return Math.abs(a.x - b.x) < NODE_W + 24 && Math.abs(a.y - b.y) < NODE_H + 14;
}

/** Picks a spot for a single new node next to its neighbours without overlapping. */
function placeNew(id, edges, positions) {
  const ups = edges.filter((e) => e.to === id && positions[e.from]).map((e) => positions[e.from]);
  const downs = edges.filter((e) => e.from === id && positions[e.to]).map((e) => positions[e.to]);
  const all = Object.values(positions);
  let p;
  if (ups.length) {
    p = { x: Math.max(...ups.map((u) => u.x)) + COL_W, y: avg(ups.map((u) => u.y)) };
  } else if (downs.length) {
    p = { x: Math.min(...downs.map((d) => d.x)) - COL_W, y: avg(downs.map((d) => d.y)) };
  } else if (all.length) {
    p = { x: Math.min(...all.map((a) => a.x)), y: Math.max(...all.map((a) => a.y)) + ROW_H };
  } else {
    p = { x: 0, y: 0 };
  }
  p = { x: Math.round(p.x), y: Math.round(p.y) };
  let guard = 0;
  while (all.some((q) => overlaps(p, q)) && guard++ < 500) p.y += ROW_H;
  return p;
}

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

module.exports = { layeredLayout, placeNew, NODE_W, NODE_H, COL_W, ROW_H };

'use strict';

/**
 * Layered DAG layout (longest-path layering + barycenter ordering), flowing
 * left to right ('LR') or top to bottom ('TB').
 */

const NODE_W = 220;
const NODE_H = 60;
// Left to right: layers are columns, boxes in a layer stack downwards.
const COL_W = 300;
const ROW_H = 86;
// Top to bottom: layers are rows, boxes in a layer sit side by side.
const TB_LAYER_H = 140;
const TB_SLOT_W = 260;

/**
 * `minLayer(id)` is an optional lower bound on a box's column, used to keep
 * dbt layers in order (staging before intermediate before marts) even where
 * the files have no ref() between them. Connections always win: a box is
 * never placed left of something it depends on.
 */
function layeredLayout(ids, edges, sortKey = (id) => id, minLayer = () => 0, direction = 'LR') {
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
    if (direction === 'TB') {
      const offset = ((L.length - 1) * TB_SLOT_W) / 2;
      L.forEach((id, k) => {
        pos[id] = { x: Math.round(k * TB_SLOT_W - offset), y: li * TB_LAYER_H };
      });
    } else {
      const offset = ((L.length - 1) * ROW_H) / 2;
      L.forEach((id, k) => {
        pos[id] = { x: li * COL_W, y: Math.round(k * ROW_H - offset) };
      });
    }
  });
  return pos;
}

function overlaps(a, b) {
  return Math.abs(a.x - b.x) < NODE_W + 24 && Math.abs(a.y - b.y) < NODE_H + 14;
}

/** Picks a spot for a single new node next to its neighbours without overlapping. */
function placeNew(id, edges, positions, direction = 'LR') {
  const ups = edges.filter((e) => e.to === id && positions[e.from]).map((e) => positions[e.from]);
  const downs = edges.filter((e) => e.from === id && positions[e.to]).map((e) => positions[e.to]);
  const all = Object.values(positions);
  // Work in "flow" coordinates (along the flow, across it) and map back at the end.
  const tb = direction === 'TB';
  const along = (p) => (tb ? p.y : p.x);
  const across = (p) => (tb ? p.x : p.y);
  const step = tb ? TB_LAYER_H : COL_W;
  const slot = tb ? TB_SLOT_W : ROW_H;
  let a;
  let c;
  if (ups.length) {
    a = Math.max(...ups.map(along)) + step;
    c = avg(ups.map(across));
  } else if (downs.length) {
    a = Math.min(...downs.map(along)) - step;
    c = avg(downs.map(across));
  } else if (all.length) {
    a = Math.min(...all.map(along));
    c = Math.max(...all.map(across)) + slot;
  } else {
    a = 0;
    c = 0;
  }
  const make = () => (tb ? { x: Math.round(c), y: Math.round(a) } : { x: Math.round(a), y: Math.round(c) });
  let p = make();
  let guard = 0;
  while (all.some((q) => overlaps(p, q)) && guard++ < 500) {
    c += slot;
    p = make();
  }
  return p;
}

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

module.exports = { layeredLayout, placeNew, NODE_W, NODE_H, COL_W, ROW_H };

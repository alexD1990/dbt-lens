'use strict';

/**
 * Which model or source a name in a model's SQL stands for, so a column like
 * `prep1.order_id` can be traced from the model behind `prep1`.
 *
 * Understands the two usual dbt patterns:
 *   prep1 as ( select * from {{ ref('prep1') }} )      import CTE
 *   from {{ ref('prep1') }} as p   /   join {{ source('raw', 'orders') }} o
 * Anything else (a CTE that joins or filters, a subquery) is not resolved.
 */

const { stripComments } = require('./parser');

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const CALL = String.raw`\{\{\s*(ref|source)\s*\(([^)]*)\)\s*\}\}`;
const CTE_RE = new RegExp(String.raw`(${IDENT})\s+as\s*\(\s*select\s+\*\s+from\s+${CALL}\s*(?:as\s+)?(?:${IDENT}\s*)?\)`, 'gi');
const ALIAS_RE = new RegExp(String.raw`${CALL}\s+(?:as\s+)?(${IDENT})`, 'gi');
const NOT_ALIAS = new Set([
  'where', 'join', 'inner', 'left', 'right', 'full', 'cross', 'outer', 'on', 'using', 'group', 'order',
  'having', 'limit', 'union', 'except', 'intersect', 'qualify', 'window', 'select', 'from', 'lateral', 'natural',
]);

/** Map of lower-case name → { kind: 'ref', name } | { kind: 'source', source, table }. */
function importAliases(sql) {
  const text = stripComments(String(sql || ''));
  const out = new Map();
  let m;
  CTE_RE.lastIndex = 0;
  while ((m = CTE_RE.exec(text))) {
    const dep = depOf(m[2], m[3]);
    if (dep) out.set(m[1].toLowerCase(), dep);
  }
  ALIAS_RE.lastIndex = 0;
  while ((m = ALIAS_RE.exec(text))) {
    const alias = m[3].toLowerCase();
    if (NOT_ALIAS.has(alias) || out.has(alias)) continue;
    const dep = depOf(m[1], m[2]);
    if (dep) out.set(alias, dep);
  }
  return out;
}

/** Box id on the canvas for a dependency from importAliases. */
function boxIdOf(dep) {
  return dep.kind === 'source' ? `source:${dep.source}.${dep.table}` : dep.name;
}

function depOf(fn, argText) {
  const args = [...argText.matchAll(/(['"])([^'"]+)\1/g)].map((a) => a[2]);
  if (fn.toLowerCase() === 'source') return args.length >= 2 ? { kind: 'source', source: args[0], table: args[1] } : null;
  // ref('model') or ref('package', 'model'); a version argument (v=2) is not quoted.
  if (!args.length) return null;
  return { kind: 'ref', name: args.length >= 2 ? args[1] : args[0] };
}

module.exports = { importAliases, boxIdOf };

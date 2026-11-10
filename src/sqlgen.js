'use strict';

/**
 * SQL text helpers: generating a new model from its upstream boxes, and adding
 * a dependency to an existing model as an import CTE at the top of the file.
 */

const INDENT = '    ';

function depExpression(dep) {
  return dep.kind === 'source'
    ? `{{ source('${dep.source}', '${dep.table}') }}`
    : `{{ ref('${dep.name}') }}`;
}

function baseCteName(dep) {
  return dep.kind === 'source' ? dep.table : dep.name;
}

function cteBlock(name, dep) {
  return `${name} as (\n${INDENT}select * from ${depExpression(dep)}\n)`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function alreadyDepends(sql, dep) {
  if (dep.kind === 'source') {
    const re = new RegExp(
      `source\\s*\\(\\s*['"]${escapeRe(dep.source)}['"]\\s*,\\s*['"]${escapeRe(dep.table)}['"]`
    );
    return re.test(sql);
  }
  const re = new RegExp(`ref\\s*\\(\\s*(?:['"][^'"]+['"]\\s*,\\s*)?['"]${escapeRe(dep.name)}['"]`);
  return re.test(sql);
}

function uniqueCteName(sql, base) {
  const taken = (n) => new RegExp(`(^|[\\s,])${escapeRe(n)}\\s+as\\s*\\(`, 'i').test(sql);
  if (!taken(base)) return base;
  let i = 2;
  while (taken(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/** Content for a brand new model file. */
function generateModelSql(deps) {
  if (!deps.length) {
    return 'select\n' + INDENT + '1 as id  -- replace with your model\n';
  }
  const used = new Set();
  const names = deps.map((d) => {
    let n = baseCteName(d);
    let i = 2;
    while (used.has(n)) n = `${baseCteName(d)}_${i++}`;
    used.add(n);
    return n;
  });
  const ctes = deps.map((d, i) => cteBlock(names[i], d)).join(',\n\n');
  return `with\n\n${ctes}\n\nselect * from ${names[0]}\n`;
}

/**
 * Length of the leading part of the file that must stay first:
 * blank lines, comments and Jinja blocks such as {{ config(...) }}.
 */
function headerLength(sql) {
  const re = /^(\s+|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/|\{#[\s\S]*?#\}|\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\})/;
  let pos = 0;
  for (;;) {
    const m = re.exec(sql.slice(pos));
    if (!m || !m[0].length) break;
    pos += m[0].length;
  }
  // Give back trailing whitespace so the header keeps its own line breaks.
  while (pos > 0 && /\s/.test(sql[pos - 1])) pos--;
  return pos;
}

/**
 * Returns { sql, changed }. Adds `dep` as the first import CTE, after any
 * config block or leading comments. Leaves the file untouched if the
 * dependency is already there.
 */
function insertDependency(sql, dep) {
  if (alreadyDepends(sql, dep)) return { sql, changed: false };
  const cut = headerLength(sql);
  const head = sql.slice(0, cut);
  const body = sql.slice(cut).replace(/^\s+/, '');
  const block = cteBlock(uniqueCteName(sql, baseCteName(dep)), dep);
  const sep = head ? '\n\n' : '';

  const withMatch = /^with\b(\s+recursive\b)?/i.exec(body);
  let newBody;
  if (withMatch) {
    const keyword = withMatch[0];
    const rest = body.slice(keyword.length).replace(/^\s+/, '');
    newBody = `${keyword}\n\n${block},\n\n${rest}`;
  } else {
    newBody = `with\n\n${block}\n\n${body}`;
  }
  return { sql: head + sep + newBody, changed: true };
}

/**
 * The reverse of insertDependency: removes the import CTE for `dep`
 * (`name as ( select * from {{ ref('x') }} )`) with its comma, and `with` when
 * it was the only CTE. Returns { sql, changed, reason }.
 *
 * It only removes what it can remove safely. Nothing changes, with a reason, when:
 *   'not-found'  the file does not use the dependency at all
 *   'not-import' it is used, but not as a plain `select *` import CTE
 *   'in-use'     the CTE's name is used elsewhere in the file (a from, a join, a column)
 *   'other-use'  the dependency is also used outside the import CTE
 *   'unexpected' the text around the CTE is not what dbt Flow understands
 */
function removeImportCte(sql, dep) {
  const call = dep.kind === 'source'
    ? `source\\s*\\(\\s*['"]${escapeRe(dep.source)}['"]\\s*,\\s*['"]${escapeRe(dep.table)}['"]\\s*\\)`
    : `ref\\s*\\(\\s*(?:['"][^'"]+['"]\\s*,\\s*)?['"]${escapeRe(dep.name)}['"]\\s*(?:,[^)]*)?\\)`;
  const cte = new RegExp(`([A-Za-z_][A-Za-z0-9_]*)\\s+as\\s*\\(\\s*select\\s+\\*\\s+from\\s+\\{\\{-?\\s*${call}\\s*-?\\}\\}\\s*\\)`, 'i');
  const unchanged = (reason) => ({ sql, changed: false, reason });
  const m = cte.exec(sql);
  if (!m) return unchanged(alreadyDepends(sql, dep) ? 'not-import' : 'not-found');

  const name = m[1];
  const start = m.index;
  const end = m.index + m[0].length;
  const outside = sql.slice(0, start) + ' ' + sql.slice(end);
  if (alreadyDepends(outside, dep)) return unchanged('other-use');
  if (new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(name)}([^A-Za-z0-9_]|$)`, 'i').test(stripSqlComments(outside))) {
    return unchanged('in-use');
  }

  // Followed by a comma: remove the CTE, the comma and the space up to the next CTE.
  const after = /^\s*,\s*/.exec(sql.slice(end));
  if (after) return { sql: sql.slice(0, start) + sql.slice(end + after[0].length), changed: true, reason: null };

  // The last CTE after others: remove the comma before it as well.
  const before = /,\s*$/.exec(sql.slice(0, start));
  if (before) return { sql: sql.slice(0, before.index) + sql.slice(end), changed: true, reason: null };

  // The only CTE: remove `with` too, and the space up to what follows.
  const withKw = /\bwith\s*$/i.exec(sql.slice(0, start));
  if (withKw) {
    const rest = sql.slice(end).replace(/^\s+/, '');
    return { sql: sql.slice(0, withKw.index) + rest, changed: true, reason: null };
  }
  return unchanged('unexpected');
}

function stripSqlComments(text) {
  return text
    .replace(/\{#[\s\S]*?#\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

module.exports = { generateModelSql, insertDependency, removeImportCte, alreadyDepends, headerLength, depExpression };

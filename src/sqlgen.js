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

module.exports = { generateModelSql, insertDependency, alreadyDepends, headerLength, depExpression };

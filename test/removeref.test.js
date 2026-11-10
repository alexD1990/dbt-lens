'use strict';
// Removing a ref() to a model that no longer exists: the import CTE goes, nothing else.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { removeImportCte, insertDependency } = require('../src/sqlgen');

const ref = (name) => ({ kind: 'ref', name });
const CTE = (name, target = name) => `${name} as (\n    select * from {{ ref('${target}') }}\n)`;

// ---------------------------------------------------------------- sqlgen

test('sqlgen: the first import CTE goes with its comma (the tpch_dbt case)', () => {
  const sql = `with\n\n${CTE('source5')},\n\n${CTE('raw_stores')}\n\nselect\n    store_id,\n    region\nfrom raw_stores\n`;
  const r = removeImportCte(sql, ref('source5'));
  assert.equal(r.changed, true);
  assert.equal(r.sql, `with\n\n${CTE('raw_stores')}\n\nselect\n    store_id,\n    region\nfrom raw_stores\n`);
});

test('sqlgen: a CTE in the middle and the last one', () => {
  const three = `with\n\n${CTE('a')},\n\n${CTE('b')},\n\n${CTE('c')}\n\nselect * from a join c using (id)\n`;
  assert.equal(removeImportCte(three, ref('b')).sql, `with\n\n${CTE('a')},\n\n${CTE('c')}\n\nselect * from a join c using (id)\n`);
  const lastGone = removeImportCte(`with\n\n${CTE('a')},\n\n${CTE('c')}\n\nselect * from a\n`, ref('c'));
  assert.equal(lastGone.sql, `with\n\n${CTE('a')}\n\nselect * from a\n`);
});

test('sqlgen: the only CTE takes `with` along, and a config block stays', () => {
  const sql = `{{ config(materialized='table') }}\n\nwith\n\n${CTE('old')}\n\nselect 1 as id\n`;
  assert.equal(removeImportCte(sql, ref('old')).sql, `{{ config(materialized='table') }}\n\nselect 1 as id\n`);
});

test('sqlgen: what insertDependency adds, removeImportCte takes out', () => {
  const src = 'with orders as (\n    select 1 as id\n)\n\nselect * from orders\n';
  const added = insertDependency(src, ref('stg_customers')).sql;
  const removed = removeImportCte(added, ref('stg_customers'));
  assert.equal(removed.changed, true);
  assert.equal(removed.sql, 'with\n\norders as (\n    select 1 as id\n)\n\nselect * from orders\n');
});

test('sqlgen: never removes a CTE that is still used', () => {
  const used = `with\n\n${CTE('source5')}\n\nselect * from source5\n`;
  assert.deepEqual(removeImportCte(used, ref('source5')), { sql: used, changed: false, reason: 'in-use' });
  const joined = `with\n\n${CTE('p', 'prep1')},\n\n${CTE('q', 'prep2')}\n\nselect * from q left join p on p.id = q.id\n`;
  assert.equal(removeImportCte(joined, ref('prep1')).reason, 'in-use');
  const column = `with\n\n${CTE('s', 'src')},\n\n${CTE('t')}\n\nselect t.id, s.name from t\n`;
  assert.equal(removeImportCte(column, ref('src')).reason, 'in-use');
});

test('sqlgen: a name only mentioned in a comment does not block removal', () => {
  const sql = `with\n\n${CTE('gone')},\n\n${CTE('t')}\n\n-- gone used to be joined here\nselect * from t\n`;
  assert.equal(removeImportCte(sql, ref('gone')).changed, true);
});

test('sqlgen: refuses refs that are not plain import CTEs or are used twice', () => {
  const direct = "select * from {{ ref('x') }}\n";
  assert.equal(removeImportCte(direct, ref('x')).reason, 'not-import');
  const filtered = "with x as (\n    select * from {{ ref('x') }} where id > 1\n)\nselect * from x\n";
  assert.equal(removeImportCte(filtered, ref('x')).reason, 'not-import');
  const twice = `with\n\n${CTE('x')},\n\n${CTE('t')}\n\nselect * from t join {{ ref('x') }} on true\n`;
  assert.equal(removeImportCte(twice, ref('x')).reason, 'other-use');
  assert.equal(removeImportCte('select 1\n', ref('x')).reason, 'not-found');
});

test('sqlgen: ref forms, sources and spacing', () => {
  const pkg = "with\n\nm as (select * from {{ ref('pkg', 'm') }}),\n\nt as (select 1)\n\nselect * from t\n";
  assert.equal(removeImportCte(pkg, ref('m')).sql, 'with\n\nt as (select 1)\n\nselect * from t\n');
  const ver = "WITH m AS (SELECT * FROM {{ ref(\"m\", v=2) }}), t AS (SELECT 1) SELECT * FROM t";
  assert.equal(removeImportCte(ver, ref('m')).sql, 'WITH t AS (SELECT 1) SELECT * FROM t');
  const src = "with\n\norders as (\n    select * from {{ source('raw', 'orders') }}\n),\n\nt as (select 1)\n\nselect * from t\n";
  assert.equal(removeImportCte(src, { kind: 'source', source: 'raw', table: 'orders' }).sql, 'with\n\nt as (select 1)\n\nselect * from t\n');
  const other = "with\n\nsource55 as (select * from {{ ref('source55') }})\n\nselect * from source55\n";
  assert.equal(removeImportCte(other, ref('source5')).reason, 'not-found', 'source5 is not source55');
});

// ---------------------------------------------------------------- model

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtflow-rm-'));
  for (const [rel, text] of Object.entries({ 'dbt_project.yml': "name: 'demo'\n", ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const { FlowModel } = require('../src/model');
  const { createNodeIO } = require('../src/nodeio');
  const m = new FlowModel(createNodeIO());
  m.open(root);
  return { m, root, read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8') };
}

test('model: removing refs to a deleted model clears the red box, and undo brings it back', () => {
  const source3 = `with\n\n${CTE('source5')},\n\n${CTE('raw_stores')}\n\nselect * from raw_stores\n`;
  const { m, read } = project({
    'models/staging/source3.sql': source3,
    'models/staging/raw_stores.sql': 'select 1 as store_id\n',
    'models/prep/prep9.sql': `with\n\n${CTE('source5')}\n\nselect * from source5\n`,
  });
  assert.equal(m.nodes.get('source5').kind, 'missing');

  const plan = m.planRemoveRefs('source5');
  assert.deepEqual(plan.auto.map((f) => f.rel), ['models/staging/source3.sql']);
  assert.deepEqual(plan.manual.map((f) => [f.rel, f.reason]), [['models/prep/prep9.sql', 'in-use']]);

  const r = m.removeRefs('source5');
  assert.equal(r.ok, true);
  assert.deepEqual(r.updated, ['models/staging/source3.sql']);
  assert.deepEqual(r.manual, ['models/prep/prep9.sql']);
  assert.equal(read('models/staging/source3.sql'), `with\n\n${CTE('raw_stores')}\n\nselect * from raw_stores\n`);
  assert.ok(!m.edges.some((e) => e.from === 'source5' && e.to === 'source3'));
  assert.equal(m.nodes.get('source5').kind, 'missing', 'prep9 still uses it, so the red box stays');

  m.undo();
  assert.equal(read('models/staging/source3.sql'), source3);
});

test('model: the red box disappears when its last ref is removed', () => {
  const { m } = project({
    'models/a.sql': `with\n\n${CTE('gone')},\n\n${CTE('b')}\n\nselect * from b\n`,
    'models/b.sql': 'select 1 as id\n',
  });
  assert.equal(m.removeRefs('gone').ok, true);
  assert.equal(m.nodes.has('gone'), false);
});

test('model: nothing to remove automatically is reported, not done', () => {
  const { m, read } = project({ 'models/a.sql': "select * from {{ ref('gone') }}\n" });
  const r = m.removeRefs('gone');
  assert.equal(r.ok, false);
  assert.deepEqual(r.manual, ['models/a.sql']);
  assert.equal(read('models/a.sql'), "select * from {{ ref('gone') }}\n");
});

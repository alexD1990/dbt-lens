'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FlowModel } = require('../src/model');
const { createNodeIO } = require('../src/nodeio');
const { parseModel, readPathList } = require('../src/parser');
const { insertDependency, generateModelSql } = require('../src/sqlgen');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtflow-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const PROJECT = {
  'dbt_project.yml': "name: 'shop'\nversion: '1.0'\n",
  // Singular "model" folder on purpose: must still be found.
  'model/staging/stg_orders.sql': "select * from {{ source('shop', 'orders') }}\n",
  'model/staging/stg_customers.sql': "-- customers\nselect * from {{ source(\"shop\", \"customers\") }}\n",
  'model/marts/fct_orders.sql':
    "{{ config(materialized='table') }}\n\nwith orders as (\n    select * from {{ ref('stg_orders') }}\n)\n\nselect * from orders\n",
  'model/marts/py_model.py': 'def model(dbt, session):\n    return dbt.ref("fct_orders")\n',
  'model/broken.sql': "select * from {{ ref('does_not_exist') }} -- {{ ref('commented_out') }}\n",
  'seeds/countries.csv': 'code,name\nNO,Norway\n',
};

test('parser handles ref forms, sources, comments and config', () => {
  const p = parseModel(
    "{{ config(materialized = 'incremental') }}\n{# {{ ref('hidden') }} #}\n" +
      "select * from {{ ref('a') }} join {{ ref('pkg', 'b') }} join {{ ref('c', v=2) }}\n" +
      "join {{ source('raw', 'events') }} /* {{ ref('nope') }} */"
  );
  assert.deepEqual(p.refs.sort(), ['a', 'b', 'c']);
  assert.deepEqual(p.sources, ['raw.events']);
  assert.equal(p.materialized, 'incremental');
});

test('readPathList reads inline and block lists', () => {
  assert.deepEqual(readPathList('model-paths: ["models", "other"]\n', 'model-paths'), ['models', 'other']);
  assert.deepEqual(readPathList('model-paths:\n  - "models"\n  - extra # note\nname: x\n', 'model-paths'), [
    'models',
    'extra',
  ]);
});

test('insertDependency adds an import CTE at the top, after config', () => {
  const src = "{{ config(materialized='table') }}\n\nwith orders as (\n    select 1\n)\n\nselect * from orders\n";
  const { sql, changed } = insertDependency(src, { kind: 'ref', name: 'stg_customers' });
  assert.ok(changed);
  assert.equal(
    sql,
    "{{ config(materialized='table') }}\n\nwith\n\nstg_customers as (\n    select * from {{ ref('stg_customers') }}\n),\n\norders as (\n    select 1\n)\n\nselect * from orders\n"
  );
  assert.equal(insertDependency(sql, { kind: 'ref', name: 'stg_customers' }).changed, false);

  const plain = insertDependency('select * from x\n', { kind: 'source', source: 'raw', table: 'x' });
  assert.equal(plain.sql, "with\n\nx as (\n    select * from {{ source('raw', 'x') }}\n)\n\nselect * from x\n");
  assert.match(plain.sql, /^with\n\nx as/); // CTE named like the table; no clash because "x" is not a CTE yet
});

test('generateModelSql writes one CTE per upstream', () => {
  const sql = generateModelSql([
    { kind: 'ref', name: 'stg_orders' },
    { kind: 'source', source: 'shop', table: 'payments' },
  ]);
  assert.match(sql, /stg_orders as \(\n {4}select \* from \{\{ ref\('stg_orders'\) \}\}\n\),/);
  assert.match(sql, /payments as \(\n {4}select \* from \{\{ source\('shop', 'payments'\) \}\}\n\)/);
  assert.match(sql, /select \* from stg_orders\n$/);
});

test('reads an existing project: model folder fallback, sources, seeds, missing refs', () => {
  const root = fixture(PROJECT);
  const m = new FlowModel(createNodeIO());
  m.open(root);
  const v = m.getView();
  const byId = Object.fromEntries(v.nodes.map((n) => [n.id, n]));
  assert.equal(v.project.modelDirs[0], 'model');
  assert.equal(byId.fct_orders.materialized, 'table');
  assert.equal(byId.fct_orders.folder, 'marts');
  assert.equal(byId['source:shop.orders'].kind, 'source');
  assert.equal(byId.countries.kind, 'seed');
  assert.equal(byId.does_not_exist.kind, 'missing');
  assert.equal(byId.commented_out, undefined);
  assert.ok(v.edges.some((e) => e.from === 'fct_orders' && e.to === 'py_model'));
  assert.ok(v.edges.some((e) => e.from === 'stg_orders' && e.to === 'fct_orders'));
  // Sources sit left of staging, staging left of marts.
  assert.ok(byId['source:shop.orders'].x < byId.stg_orders.x);
  assert.ok(byId.stg_orders.x < byId.fct_orders.x);
  // Opening the view must not write anything to the repo.
  assert.equal(fs.existsSync(path.join(root, '.dbtflow.json')), false);
});

test('connect between existing files writes a ref, and undo restores the file', () => {
  const root = fixture(PROJECT);
  const m = new FlowModel(createNodeIO());
  m.open(root);
  const original = read(root, 'model/marts/fct_orders.sql');
  const r = m.connect('stg_customers', 'fct_orders');
  assert.ok(r.ok, r.message);
  assert.match(read(root, 'model/marts/fct_orders.sql'), /stg_customers as \(\n {4}select \* from \{\{ ref\('stg_customers'\) \}\}/);
  assert.ok(m.getView().edges.some((e) => e.from === 'stg_customers' && e.to === 'fct_orders' && !e.planned));
  assert.ok(m.undo().ok);
  assert.equal(read(root, 'model/marts/fct_orders.sql'), original);
  assert.ok(m.redo().ok);
  assert.match(read(root, 'model/marts/fct_orders.sql'), /ref\('stg_customers'\)/);
});

test('connect refuses loops and connections into sources', () => {
  const root = fixture(PROJECT);
  const m = new FlowModel(createNodeIO());
  m.open(root);
  assert.equal(m.connect('fct_orders', 'stg_orders').ok, false);
  assert.equal(m.connect('stg_orders', 'source:shop.orders').ok, false);
});

test('locked boxes refuse moves; unlock, move, revert brings them home', () => {
  const root = fixture(PROJECT);
  const m = new FlowModel(createNodeIO());
  m.open(root);
  const home = { ...m.getView().nodes.find((n) => n.id === 'fct_orders') };
  assert.equal(m.moveNode('fct_orders', 999, 999).ok, false);
  m.unlock('fct_orders');
  assert.ok(m.moveNode('fct_orders', 999, 999).ok);
  let n = m.getView().nodes.find((x) => x.id === 'fct_orders');
  assert.deepEqual([n.x, n.y, n.locked], [999, 999, false]);
  assert.deepEqual(n.home, { x: home.x, y: home.y });
  // Moving never touches SQL.
  assert.equal(read(root, 'model/marts/fct_orders.sql'), PROJECT['model/marts/fct_orders.sql']);
  m.revert('fct_orders');
  n = m.getView().nodes.find((x) => x.id === 'fct_orders');
  assert.deepEqual([n.x, n.y, n.locked], [home.x, home.y, true]);
  // Undo of the revert puts it back out, unlocked.
  m.undo();
  n = m.getView().nodes.find((x) => x.id === 'fct_orders');
  assert.deepEqual([n.x, n.y, n.locked], [999, 999, false]);
});

test('empty project: plan boxes, connect, create all files', () => {
  const root = fixture({ 'dbt_project.yml': 'name: fresh\n', 'models/staging/.gitkeep': '', 'models/marts/.gitkeep': '' });
  const m = new FlowModel(createNodeIO());
  m.open(root);
  const choices = m.folderChoices();
  assert.deepEqual(choices.map((c) => c.folder), ['', 'marts', 'staging']);
  assert.equal(choices[m.suggestFolder('stg_orders', choices)].folder, 'staging');
  assert.equal(choices[m.suggestFolder('fct_orders', choices)].folder, 'marts');

  assert.ok(m.createBox('stg_orders', choices[2], 0, 0).ok);
  assert.ok(m.createBox('stg_customers', choices[2], 0, 100).ok);
  assert.ok(m.createBox('fct_orders', choices[1], 300, 50).ok);
  assert.equal(m.createBox('Bad Name', choices[0], 0, 0).ok, false);
  assert.equal(m.createBox('stg_orders', choices[0], 0, 0).ok, false);
  assert.ok(m.connect('stg_orders', 'fct_orders').ok);
  assert.ok(m.connect('stg_customers', 'fct_orders').ok);
  assert.equal(m.connect('fct_orders', 'stg_orders').ok, false); // loop

  const r = m.createFiles(m.getView().nodes.map((n) => n.id));
  assert.ok(r.ok, r.message);
  const fct = read(root, 'models/marts/fct_orders.sql');
  assert.match(fct, /ref\('stg_orders'\)/);
  assert.match(fct, /ref\('stg_customers'\)/);
  assert.ok(fct.indexOf('stg_orders') < fct.indexOf('stg_customers')); // ordered top to bottom
  assert.ok(fs.existsSync(path.join(root, 'models/staging/stg_orders.sql')));

  const v = m.getView();
  assert.equal(v.plannedCount, 0);
  assert.ok(v.nodes.every((n) => n.locked));
  assert.equal(v.edges.filter((e) => !e.planned).length, 2);
  // Positions survive file creation.
  assert.deepEqual(
    [v.nodes.find((n) => n.id === 'fct_orders').x, v.nodes.find((n) => n.id === 'fct_orders').y],
    [300, 50]
  );

  // One undo removes all three files and brings the boxes back.
  assert.ok(m.undo().ok);
  assert.equal(fs.existsSync(path.join(root, 'models/marts/fct_orders.sql')), false);
  assert.equal(m.getView().plannedCount, 3);
  const state = JSON.parse(read(root, '.dbtflow.json'));
  assert.equal(state.plannedEdges.length, 2);
});

test('creating a planned upstream adds its ref into an existing downstream file', () => {
  const root = fixture(PROJECT);
  const m = new FlowModel(createNodeIO());
  m.open(root);
  m.createBox('stg_payments', { modelDir: 'model', folder: 'staging' }, 0, 400);
  const plan = m.connect('stg_payments', 'fct_orders');
  assert.ok(plan.ok);
  // Not written yet: the upstream model has no file.
  assert.doesNotMatch(read(root, 'model/marts/fct_orders.sql'), /stg_payments/);
  assert.ok(m.createFiles(['stg_payments']).ok);
  assert.match(read(root, 'model/marts/fct_orders.sql'), /ref\('stg_payments'\)/);
  assert.equal(JSON.parse(read(root, '.dbtflow.json')).plannedEdges.length, 0);
});

test('undo refuses to overwrite a file edited by hand afterwards', () => {
  const root = fixture(PROJECT);
  const m = new FlowModel(createNodeIO());
  m.open(root);
  m.connect('stg_customers', 'fct_orders');
  fs.appendFileSync(path.join(root, 'model/marts/fct_orders.sql'), '-- my edit\n');
  const r = m.undo();
  assert.equal(r.ok, false);
  assert.match(r.message, /edited after/);
  assert.match(read(root, 'model/marts/fct_orders.sql'), /my edit/);
});

test('a missing ref can be planned as a box and keeps its edge', () => {
  const root = fixture(PROJECT);
  const m = new FlowModel(createNodeIO());
  m.open(root);
  assert.ok(m.createBox('does_not_exist', { modelDir: 'model', folder: '' }, 0, 0).ok);
  const v = m.getView();
  assert.equal(v.nodes.find((n) => n.id === 'does_not_exist').kind, 'planned');
  assert.ok(v.edges.some((e) => e.from === 'does_not_exist' && e.to === 'broken'));
});

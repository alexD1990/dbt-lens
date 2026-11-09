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

test('every box moves freely, never touches SQL, and undo puts it back', () => {
  const root = fixture(PROJECT);
  const m = new FlowModel(createNodeIO());
  m.open(root);
  const start = { ...m.getView().nodes.find((n) => n.id === 'fct_orders') };
  assert.ok(m.moveNode('fct_orders', 999, 999).ok);
  let n = m.getView().nodes.find((x) => x.id === 'fct_orders');
  assert.deepEqual([n.x, n.y], [999, 999]);
  assert.equal(read(root, 'model/marts/fct_orders.sql'), PROJECT['model/marts/fct_orders.sql']);
  m.undo();
  n = m.getView().nodes.find((x) => x.id === 'fct_orders');
  assert.deepEqual([n.x, n.y], [start.x, start.y]);
});

test('old .dbtflow.json with lock "home" spots still loads', () => {
  const root = fixture({
    ...PROJECT,
    '.dbtflow.json': JSON.stringify({ version: 1, positions: { fct_orders: { x: 5, y: 6, home: { x: 1, y: 2 } } }, planned: {}, plannedEdges: [] }),
  });
  const m = new FlowModel(createNodeIO());
  m.open(root);
  const n = m.getView().nodes.find((x) => x.id === 'fct_orders');
  assert.deepEqual([n.x, n.y, n.home], [5, 6, undefined]);
});

test('rename a model from the canvas: file, refs and position follow; one undo reverts all', () => {
  const root = fixture(PROJECT);
  const m = new FlowModel(createNodeIO());
  m.open(root);
  m.moveNode('stg_orders', 40, 70);
  const r = m.renameModel('stg_orders', 'stg_shop_orders');
  assert.ok(r.ok, r.message);
  assert.ok(fs.existsSync(path.join(root, 'model/staging/stg_shop_orders.sql')));
  assert.ok(!fs.existsSync(path.join(root, 'model/staging/stg_orders.sql')));
  assert.match(read(root, 'model/marts/fct_orders.sql'), /ref\('stg_shop_orders'\)/);
  assert.doesNotMatch(read(root, 'model/marts/fct_orders.sql'), /ref\('stg_orders'\)/);
  const v = m.getView();
  const n = v.nodes.find((x) => x.id === 'stg_shop_orders');
  assert.deepEqual([n.x, n.y], [40, 70]);
  assert.ok(!v.nodes.some((x) => x.kind === 'missing' && x.id === 'stg_orders'));
  assert.equal(m.renameModel('stg_customers', 'fct_orders').ok, false); // name taken

  assert.ok(m.undo().ok);
  assert.ok(fs.existsSync(path.join(root, 'model/staging/stg_orders.sql')));
  assert.ok(!fs.existsSync(path.join(root, 'model/staging/stg_shop_orders.sql')));
  assert.match(read(root, 'model/marts/fct_orders.sql'), /ref\('stg_orders'\)/);
  assert.deepEqual(
    (({ x, y }) => [x, y])(m.getView().nodes.find((x) => x.id === 'stg_orders')),
    [40, 70]
  );
});

test('renamed in Explorer: new name keeps the box, no ghost after refs are updated', () => {
  const root = fixture(PROJECT);
  const m = new FlowModel(createNodeIO());
  m.open(root);
  m.moveNode('stg_orders', 40, 70);
  const oldAbs = path.join(root, 'model/staging/stg_orders.sql');
  const newAbs = path.join(root, 'model/staging/orders.sql');
  fs.renameSync(oldAbs, newAbs);
  m.refresh(); // the file watcher may run first
  const info = m.fileRenamed(oldAbs, newAbs);
  assert.deepEqual(info, { oldName: 'stg_orders', newName: 'orders', usedBy: ['model/marts/fct_orders.sql'] });
  let v = m.getView();
  assert.deepEqual((({ x, y }) => [x, y])(v.nodes.find((x) => x.id === 'orders')), [40, 70]);
  const ghost = v.nodes.find((x) => x.id === 'stg_orders');
  assert.equal(ghost.kind, 'missing');
  assert.deepEqual(ghost.usedBy, ['model/marts/fct_orders.sql']);

  assert.ok(m.retargetRefs('stg_orders', 'orders').ok);
  v = m.getView();
  assert.ok(!v.nodes.some((x) => x.id === 'stg_orders'));
  assert.ok(v.edges.some((e) => e.from === 'orders' && e.to === 'fct_orders'));
  // A move to another folder keeps the same name: nothing to do.
  assert.equal(m.fileRenamed(newAbs, path.join(root, 'model/marts/orders.sql')), null);
});

test('deleting a .sql file leaves a red box; removing it from the canvas hides it', () => {
  const root = fixture(PROJECT);
  const m = new FlowModel(createNodeIO());
  m.open(root);
  fs.unlinkSync(path.join(root, 'model/staging/stg_orders.sql'));
  m.refresh();
  let red = m.getView().nodes.find((n) => n.id === 'stg_orders');
  assert.equal(red.kind, 'missing'); // fct_orders still uses ref('stg_orders')
  const r = m.removeFromCanvas('stg_orders');
  assert.ok(r.ok, r.message);
  assert.deepEqual(r.usedBy, ['model/marts/fct_orders.sql']);
  let v = m.getView();
  assert.ok(!v.nodes.some((n) => n.id === 'stg_orders'));
  assert.ok(!v.edges.some((e) => e.from === 'stg_orders'));
  assert.equal(v.hiddenCount, 1);
  // SQL is untouched.
  assert.match(read(root, 'model/marts/fct_orders.sql'), /ref\('stg_orders'\)/);
  // Survives a reload.
  const again = new FlowModel(createNodeIO());
  again.open(root);
  assert.ok(!again.getView().nodes.some((n) => n.id === 'stg_orders'));
  // Creating the model again brings it back as a normal box.
  fs.writeFileSync(path.join(root, 'model/staging/stg_orders.sql'), 'select 1\n');
  again.refresh();
  assert.equal(again.getView().nodes.find((n) => n.id === 'stg_orders').kind, 'model');
});

test('removing a box that has a file only hides it; the file stays; undo and show bring it back', () => {
  const root = fixture(PROJECT);
  const m = new FlowModel(createNodeIO());
  m.open(root);
  assert.ok(m.removeFromCanvas('fct_orders').ok);
  assert.ok(fs.existsSync(path.join(root, 'model/marts/fct_orders.sql')));
  let v = m.getView();
  assert.ok(!v.nodes.some((n) => n.id === 'fct_orders'));
  assert.ok(!v.edges.some((e) => e.to === 'fct_orders' || e.from === 'fct_orders'));
  m.undo();
  assert.ok(m.getView().nodes.some((n) => n.id === 'fct_orders'));
  m.redo();
  assert.ok(m.removeFromCanvas('source:shop.orders').ok);
  assert.equal(m.getView().hiddenCount, 2);
  assert.ok(m.showHidden().ok);
  v = m.getView();
  assert.equal(v.hiddenCount, 0);
  assert.ok(v.nodes.some((n) => n.id === 'fct_orders') && v.nodes.some((n) => n.id === 'source:shop.orders'));
  // A box without a file is deleted for real.
  m.createBox('stg_new', { modelDir: 'model', folder: 'staging' }, 0, 0);
  assert.ok(m.removeFromCanvas('stg_new').ok);
  assert.equal(m.getView().hiddenCount, 0);
  assert.ok(!m.getView().nodes.some((n) => n.id === 'stg_new'));
});

test('sync with files: an emptied canvas gets every model back, laid out left to right', () => {
  // Mirrors Alex's tpch_dbt test project: everything removed from the canvas,
  // and the prep models ref() names that have no file.
  const prep = "with\n\nsource as (\n    select * from {{ ref('source') }}\n),\n\ntest as (\n    select * from {{ ref('test') }}\n)\n\nselect * from test\n";
  const files = {
    'dbt_project.yml': "name: 'tpch_dbt'\nmodel-paths: [\"models\"]\n",
    'models/staging/source1.sql': 'select\n    1 as id\n',
    'models/staging/source2.sql': 'select 2\n',
    'models/staging/source3.sql': 'select 3\n',
    'models/staging/source4.sql': 'select 4\n',
    'models/prep/prep1.sql': prep,
    'models/prep/prep2.sql': prep,
    'models/mart/mart.sql': "select * from {{ ref('prep1') }} join {{ ref('prep2') }}\n",
  };
  const hidden = { source: 'missing', test: 'missing', source1: 'model', source2: 'model', source3: 'model',
    source4: 'model', prep1: 'model', prep2: 'model', mart: 'model' };
  files['.dbtflow.json'] = JSON.stringify({ version: 1, positions: {}, planned: {}, plannedEdges: [], hidden });
  const root = fixture(files);
  const m = new FlowModel(createNodeIO());
  m.open(root);
  assert.equal(m.getView().nodes.length, 0);
  assert.equal(m.getView().hiddenCount, 9);

  const r = m.syncFromFiles();
  assert.ok(r.ok, r.message);
  assert.deepEqual(r.summary, { models: 7, sources: 0, seeds: 0, snapshots: 0, missing: ['source', 'test'], connections: 6 });
  const v = m.getView();
  assert.equal(v.hiddenCount, 0);
  assert.equal(v.nodes.length, 9);
  const x = Object.fromEntries(v.nodes.map((n) => [n.id, n.x]));
  assert.ok(x.source < x.prep1 && x.prep1 < x.mart, 'flows left to right');
  // Files are untouched.
  assert.equal(read(root, 'models/prep/prep1.sql'), prep);
  // One undo empties the canvas again.
  m.undo();
  assert.equal(m.getView().nodes.length, 0);
});

test('layout keeps dbt folder layers in order even without refs between them', () => {
  // Alex's tpch_dbt as it is: mart.sql is empty, prep refs names with no file.
  const prep = "select * from {{ ref('source') }} join {{ ref('test') }}\n";
  const root = fixture({
    'dbt_project.yml': "name: 'tpch_dbt'\n",
    'models/staging/source1.sql': 'select 1\n',
    'models/staging/source2.sql': 'select 1\n',
    'models/prep/prep1.sql': prep,
    'models/prep/prep2.sql': prep,
    'models/mart/mart.sql': '',
    'models/loose.sql': 'select 1\n',
  });
  const m = new FlowModel(createNodeIO());
  m.open(root);
  m.syncFromFiles();
  const x = Object.fromEntries(m.getView().nodes.map((n) => [n.id, n.x]));
  assert.ok(x.source1 < x.prep1, 'staging left of prep');
  assert.ok(x.prep1 < x.mart, 'prep left of mart');
  assert.equal(x.source, x.source1, 'red refs sit next to what uses them');
  assert.equal(x.source1, x.source2);
  assert.equal(x.loose, x.source1, 'a model outside any layer folder shares the first model column');
  // No empty columns: three layers in use, so three columns.
  assert.equal(new Set(Object.values(x)).size, 3);
});

test('tidy lays out only the boxes on the canvas', () => {
  const root = fixture(PROJECT);
  const m = new FlowModel(createNodeIO());
  m.open(root);
  m.removeFromCanvas('fct_orders');
  m.moveNode('fct_orders', 5000, 5000); // moving a hidden box is allowed but not shown
  const hiddenPos = { ...m.state.positions.fct_orders };
  m.tidy();
  assert.deepEqual(m.state.positions.fct_orders, hiddenPos);
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
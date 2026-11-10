'use strict';
// DAGtracer integration: the dgt JSON contract, id mapping, and a full trace
// through the integration host with a fake dgt. Fixtures are real dgt output
// from ~/projects/dbt-lab/tpch_dbt (see test/fixtures/dagtracer/README.md).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fromRun, parseDocument, crossings, mergeTraces } = require('../src/integrations/dagtracer/contract');
const { canvasIdOfUid, startArgFor, toCanvasTrace } = require('../src/integrations/dagtracer/idmap');
const dagtracer = require('../src/integrations/dagtracer');
const { IntegrationHost, STATE } = require('../src/host/integrationHost');

const FIX = path.join(__dirname, 'fixtures', 'dagtracer');
const fixtureText = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const fixture = (name) => JSON.parse(fixtureText(name));
const okRun = (stdout, code = 0) => ({ ok: code === 0, code, stdout, stderr: '', durationMs: 5, error: null });

// The tpch_dbt project as the canvas sees it.
const VIEW = {
  nodes: [
    ...['raw_customers', 'raw_orders', 'raw_stores', 'raw_store_targets'].map((id) => ({ id, name: id, kind: 'seed' })),
    ...['source1', 'source2', 'source3', 'source4', 'prep1', 'prep2', 'mart'].map((id) => ({ id, name: id, kind: 'model' })),
  ],
  edges: [
    { from: 'raw_customers', to: 'source1' }, { from: 'raw_orders', to: 'source2' },
    { from: 'raw_stores', to: 'source3' }, { from: 'raw_store_targets', to: 'source4' },
    { from: 'source1', to: 'prep1' }, { from: 'source2', to: 'prep1' },
    { from: 'source3', to: 'prep2' }, { from: 'source4', to: 'prep2' },
    { from: 'prep1', to: 'mart' }, { from: 'prep2', to: 'mart' },
  ],
};

const lastError = (posted) => posted.filter((m) => m.type === 'dagtracer/error').at(-1);
const crossingPairs = (t) => t.crossings.map((c) => `${c.from}->${c.to}`).sort();

// ---------------------------------------------------------------- contract

test('contract: reads the real upstream trace from mart', () => {
  const r = parseDocument(fixture('dgt_mart_region.json'));
  assert.equal(r.ok, true, r.message);
  const t = r.trace;
  assert.equal(t.column, 'region');
  assert.equal(t.direction, 'up');
  assert.equal(t.start.name, 'mart');
  assert.equal(t.start.status, 'absent');
  assert.equal(t.nodes.length, 5);
  assert.deepEqual(t.findings.map((f) => `${f.cause}:${f.node.name}`), [
    'column_absent_at_source:raw_orders',
    'column_dropped:prep1',
    'column_dropped:mart',
  ]);
  // Crosses go only on lines from a parent that still has the column.
  assert.deepEqual(crossings(t).map((c) => `${c.from}->${c.to}`), [
    'model.tpch_dbt.source1->model.tpch_dbt.prep1',
    'model.tpch_dbt.prep2->model.tpch_dbt.mart',
  ]);
});

test('contract: the two downstream traces give one cross each, and merge into both', () => {
  const a = parseDocument(fixture('dgt_source1_region_down.json')).trace;
  const b = parseDocument(fixture('dgt_source3_region_down.json')).trace;
  assert.equal(crossings(a).length, 1);
  assert.equal(crossings(b).length, 1);
  const merged = mergeTraces([a, b]);
  assert.equal(merged.starts.length, 2);
  assert.deepEqual(crossings(merged).map((c) => c.to).sort(), ['model.tpch_dbt.mart', 'model.tpch_dbt.prep1']);
  // Start nodes are part of the merged picture at level 0.
  assert.ok(merged.nodes.some((n) => n.uid === 'model.tpch_dbt.source1' && n.level === 0));
});

test('contract: unknown fields are ignored, a new minor version is accepted', () => {
  const doc = fixture('dgt_mart_region.json');
  doc.schema_version = '1.7';
  doc.something_new = { x: 1 };
  doc.findings[1].extra = true;
  assert.equal(parseDocument(doc).ok, true);
});

test('contract: refuses what it does not understand', () => {
  const v2 = fixture('dgt_mart_region.json');
  v2.schema_version = '2.0';
  assert.equal(parseDocument(v2).kind, 'incompatible');
  assert.equal(parseDocument(null).kind, 'bad_output');
  assert.equal(parseDocument([]).kind, 'bad_output');
  assert.equal(parseDocument({}).kind, 'bad_output');
  const broken = fixture('dgt_mart_region.json');
  broken.findings[0].node = null;
  assert.equal(parseDocument(broken).kind, 'bad_output');
  const badLevel = fixture('dgt_mart_region.json');
  badLevel.traversals.up.nodes[0].level = 'deep';
  assert.equal(parseDocument(badLevel).kind, 'bad_output');
});

test('contract: dgt error documents and process failures', () => {
  const errDoc = {
    schema_version: '1.0', tool_version: '0.1.0', status: 'error', run: null,
    traversals: { up: null, down: null }, findings: [], warnings: [],
    error: { message: "no model, seed or snapshot named 'nope'" },
  };
  const r = fromRun(okRun(JSON.stringify(errDoc), 2));
  assert.equal(r.kind, 'tool_error');
  assert.match(r.message, /no model/);

  assert.equal(fromRun({ ...okRun(''), error: 'not_found', ok: false, code: null }).kind, 'not_found');
  assert.equal(fromRun({ ...okRun(''), error: 'timeout', ok: false, code: null }).kind, 'timeout');
  const noJson = fromRun({ ok: false, code: 2, stdout: '', stderr: 'dgt: error: manifest not found\n', error: null });
  assert.equal(noJson.kind, 'process');
  assert.match(noJson.message, /manifest not found/);
  assert.equal(fromRun(okRun('{ half')).kind, 'bad_output');
});

test('contract: value_dropped crosses only parents that had the value', () => {
  const doc = fixture('dgt_source1_region_down.json');
  doc.run.values = ['cancelled'];
  doc.findings = [{
    direction: 'down', level: 1, cause: 'value_dropped',
    node: { unique_id: 'model.p.prep1', name: 'prep1', resource_type: 'model' },
    values: { cancelled: 'absent' }, uncertain: false, candidates: [],
    parents: [
      { unique_id: 'model.p.source2', name: 'source2', resource_type: 'model', status: 'present', values: { cancelled: 'present' }, via: [] },
      { unique_id: 'model.p.source1', name: 'source1', resource_type: 'model', status: 'present', values: { cancelled: 'absent' }, via: [] },
    ],
  }];
  const c = crossings(parseDocument(doc).trace);
  assert.deepEqual(c.map((x) => [x.from, x.values]), [['model.p.source2', ['cancelled']]]);
});

// ---------------------------------------------------------------- idmap

test('idmap: unique_ids and box ids', () => {
  assert.equal(canvasIdOfUid('model.tpch_dbt.mart'), 'mart');
  assert.equal(canvasIdOfUid('model.pkg.orders.v2'), 'orders');
  assert.equal(canvasIdOfUid('seed.pkg.raw_orders'), 'raw_orders');
  assert.equal(canvasIdOfUid('source.pkg.raw.orders'), 'source:raw.orders');
  assert.equal(canvasIdOfUid('weird'), 'weird');
  const view = { nodes: [...VIEW.nodes, { id: 'source:raw.orders', name: 'orders', kind: 'source' }, { id: 'x', name: 'x', kind: 'planned' }] };
  assert.equal(startArgFor('mart', view), 'mart');
  assert.equal(startArgFor('source:raw.orders', view), 'raw.orders');
  assert.equal(startArgFor('x', view), null, 'boxes without a file cannot be traced');
  assert.equal(startArgFor('gone', view), null);
});

test('idmap: canvas trace for "why is region not in mart?"', () => {
  const merged = mergeTraces([parseDocument(fixture('dgt_mart_region.json')).trace]);
  const t = toCanvasTrace(merged, VIEW);
  assert.deepEqual(t.starts, ['mart']);
  assert.deepEqual(crossingPairs(t), ['prep2->mart', 'source1->prep1']);
  assert.ok(t.crossings.every((c) => c.onCanvas && !c.uncertain));
  assert.deepEqual(t.markers, [{ id: 'raw_orders', cause: 'column_absent_at_source', direction: 'up', uncertain: false, values: {} }]);
  assert.equal(t.nodes.source1.status, 'present');
  assert.equal(t.nodes.prep1.status, 'absent');
  assert.equal(t.nodes.mart.start, true);
  assert.deepEqual(t.unmapped, []);
});

test('idmap: a crossing through an ephemeral model marks the last hop and is uncertain', () => {
  const doc = fixture('dgt_source1_region_down.json');
  doc.findings[0].parents[0].via = ['model.tpch_dbt.eph'];
  doc.findings[0].uncertain = true;
  doc.findings[0].candidates = ['model.tpch_dbt.prep1', 'model.tpch_dbt.eph'];
  const view = { nodes: [...VIEW.nodes, { id: 'eph', name: 'eph', kind: 'model' }], edges: [{ from: 'source1', to: 'eph' }, { from: 'eph', to: 'prep1' }] };
  const t = toCanvasTrace(mergeTraces([parseDocument(doc).trace]), view);
  assert.deepEqual(t.crossings[0].path, ['source1', 'eph', 'prep1']);
  assert.deepEqual(t.crossings[0].edge, { from: 'eph', to: 'prep1' });
  assert.equal(t.crossings[0].uncertain, true);
  assert.deepEqual(t.findings[0].candidates, ['prep1', 'eph']);
});

test('idmap: nodes dgt knows but the canvas does not are listed', () => {
  const t = toCanvasTrace(mergeTraces([parseDocument(fixture('dgt_mart_region.json')).trace]), { nodes: [{ id: 'mart' }], edges: [] });
  assert.ok(t.unmapped.includes('prep1'));
  assert.ok(t.crossings.every((c) => !c.onCanvas));
});

// ---------------------------------------------------------------- through the host

/** A fake dgt: answers --version, and returns the fixture that matches the arguments. */
function fakeDgt({ missing = false } = {}) {
  const calls = [];
  const absentStart = (name) => {
    const doc = fixture('dgt_source1_region_down.json');
    doc.run.start = { unique_id: `model.tpch_dbt.${name}`, name, resource_type: 'model', status: 'absent', values: {} };
    doc.findings = [];
    doc.traversals.down.nodes = [];
    return JSON.stringify(doc);
  };
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (missing) return { ok: false, code: null, stdout: '', stderr: 'spawn dgt ENOENT', durationMs: 1, error: 'not_found' };
    if (args[0] === '--version') return okRun('dgt 0.1.0\n');
    const [start, , column, , direction] = args;
    if (column !== 'region') throw new Error('unexpected column');
    if (start === 'mart' && direction === 'up') return okRun(fixtureText('dgt_mart_region.json'));
    if (start === 'source1' && direction === 'down') return okRun(fixtureText('dgt_source1_region_down.json'));
    if (start === 'source3' && direction === 'down') return okRun(fixtureText('dgt_source3_region_down.json'));
    if (start === 'source2' || start === 'source4') return okRun(absentStart(start));
    if (start === 'prep2' && direction === 'both') return okRun(fixtureText('dgt_prep2_region_both.json'));
    if (start === 'mart' && direction === 'both') return okRun(absentStart('mart'));
    return okRun('', 2);
  };
  return { run, calls };
}

async function hostWith(dgt, settings = {}, services = {}) {
  const posted = [];
  const host = new IntegrationHost({
    projectRoot: () => '/home/alex/projects/dbt-lab/tpch_dbt',
    view: () => VIEW,
    post: (m) => posted.push(m),
    setting: (id, key) => settings[key],
    logger: () => () => {},
    run: dgt.run,
    ...services,
  });
  host.register(dagtracer);
  await host.start();
  return { host, posted };
}

test('dagtracer: detects dgt and its version', async () => {
  const { host } = await hostWith(fakeDgt());
  assert.equal(host.status()[0].state, STATE.READY);
  assert.equal(host.status()[0].version, '0.1.0');
});

test('dagtracer: missing dgt leaves the integration missing with a helpful reason', async () => {
  const { host, posted } = await hostWith(fakeDgt({ missing: true }));
  assert.equal(host.status()[0].state, STATE.MISSING);
  assert.match(host.status()[0].reason, /dbtFlow\.integrations\.dagtracer\.executable/);
  await host.handle({ type: 'dagtracer/trace', starts: ['mart'], column: 'region', direction: 'up' });
  assert.match(lastError(posted).message, /not available/);
});

test('dagtracer: the configured executable and project dir are used', async () => {
  const dgt = fakeDgt();
  const { host } = await hostWith(dgt, { executable: '/venv/bin/dgt' });
  await host.handle({ type: 'dagtracer/trace', starts: ['mart'], column: 'region', direction: 'up' });
  const call = dgt.calls.at(-1);
  assert.equal(call.cmd, '/venv/bin/dgt');
  assert.deepEqual(call.args, ['mart', '-c', 'region', '-d', 'up', '-o', 'json', '--project-dir', '/home/alex/projects/dbt-lab/tpch_dbt']);
  assert.equal(call.opts.cwd, '/home/alex/projects/dbt-lab/tpch_dbt');
});

test('dagtracer: why is region not in mart (upstream from mart)', async () => {
  const { host, posted } = await hostWith(fakeDgt());
  await host.handle({ type: 'dagtracer/trace', starts: ['mart'], column: 'region', direction: 'up' });
  const types = posted.map((m) => m.type).filter((t) => t.startsWith('dagtracer/'));
  assert.deepEqual(types, ['dagtracer/started', 'dagtracer/result']);
  const res = posted.find((m) => m.type === 'dagtracer/result');
  assert.deepEqual(crossingPairs(res.trace), ['prep2->mart', 'source1->prep1']);
  assert.deepEqual(res.errors, []);
});

test('dagtracer: downstream from all four staging models finds both crosses', async () => {
  const { host, posted } = await hostWith(fakeDgt());
  await host.handle({ type: 'dagtracer/trace', starts: ['source1', 'source2', 'source3', 'source4'], column: 'region', direction: 'down' });
  const res = posted.find((m) => m.type === 'dagtracer/result');
  assert.deepEqual(crossingPairs(res.trace), ['prep2->mart', 'source1->prep1']);
  assert.deepEqual(res.trace.starts.sort(), ['source1', 'source3']);
  assert.deepEqual(res.skipped.map((s) => s.id), ['source2', 'source4'], 'staging models without region are skipped');
});

test('dagtracer: a failing start does not stop the others', async () => {
  const { host, posted } = await hostWith(fakeDgt());
  await host.handle({ type: 'dagtracer/trace', starts: ['source1', 'prep2'], column: 'region', direction: 'down' });
  const res = posted.find((m) => m.type === 'dagtracer/result');
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].id, 'prep2');
  assert.deepEqual(crossingPairs(res.trace), ['source1->prep1']);
});

test('dagtracer: bad input is refused before dgt runs', async () => {
  const dgt = fakeDgt();
  const { host, posted } = await hostWith(dgt);
  const before = dgt.calls.length;
  for (const msg of [
    { starts: ['mart'], column: '', direction: 'up' },
    { starts: ['mart'], column: 'region; drop', direction: 'up' },
    { starts: ['mart'], column: 'region', direction: 'sideways' },
    { starts: [], column: 'region', direction: 'up' },
  ]) {
    const n = posted.length;
    await host.handle({ type: 'dagtracer/trace', ...msg });
    assert.ok(posted.slice(n).some((m) => m.type === 'dagtracer/error'), JSON.stringify(msg));
  }
  assert.equal(dgt.calls.length, before);
});

test('dagtracer: a dgt crash in the middle of a run never escapes the host', async () => {
  const run = async (cmd, args) => {
    if (args[0] === '--version') return okRun('dgt 0.1.0');
    throw new Error('the fake process exploded');
  };
  const { host, posted } = await hostWith({ run });
  await host.handle({ type: 'dagtracer/trace', starts: ['mart'], column: 'region', direction: 'up' });
  assert.match(posted.find((m) => m.type === 'dagtracer/error').message, /exploded/);
  assert.equal(host.status()[0].state, STATE.READY, 'still usable afterwards');
});

test('dagtracer: each trace writes a readable summary to its log', async () => {
  const lines = [];
  const host = new IntegrationHost({
    projectRoot: () => '/p',
    view: () => VIEW,
    post: () => {},
    setting: () => undefined,
    logger: () => (l) => lines.push(l),
    run: fakeDgt().run,
  });
  host.register(dagtracer);
  await host.start();
  await host.handle({ type: 'dagtracer/trace', starts: ['source1', 'source2', 'source3', 'source4'], column: 'region', direction: 'down' });
  const text = lines.join('\n');
  assert.match(text, /Trace "region" downstream from source1, source2, source3, source4:/);
  assert.match(text, /✕ source1 → prep1: region stops here/);
  assert.match(text, /✕ prep2 → mart: region stops here/);
  assert.match(text, /Skipped source2: region is not in source2\./);
  await host.handle({ type: 'dagtracer/trace', starts: ['mart'], column: '', direction: 'up' });
  assert.match(lines.at(-1), /refused/);
});

// ---------------------------------------------------------------- trace a box (up and down)

test('dagtracer: tracing a box runs dgt both ways and shows where the column starts and stops', async () => {
  const dgt = fakeDgt();
  const { host, posted } = await hostWith(dgt);
  await host.handle({ type: 'dagtracer/traceBox', id: 'prep2', column: 'region' });
  assert.deepEqual(dgt.calls.at(-1).args.slice(0, 5), ['prep2', '-c', 'region', '-d', 'both']);
  const res = posted.find((m) => m.type === 'dagtracer/result');
  assert.deepEqual(res.request, { column: 'region', direction: 'both', starts: ['prep2'] });
  assert.equal(res.absent, null);
  assert.deepEqual(crossingPairs(res.trace), ['prep2->mart']);
  assert.deepEqual(res.trace.markers.map((m) => `${m.cause}:${m.id}`), ['present_at_source:raw_stores']);
  assert.equal(res.trace.nodes.prep2.start, true);
  assert.equal(res.trace.nodes.source3.level, -1);
  assert.equal(res.trace.nodes.mart.level, 1);
});

test('dagtracer: a column that is not in the box is reported as absent, not drawn', async () => {
  const { host, posted } = await hostWith(fakeDgt());
  await host.handle({ type: 'dagtracer/traceBox', id: 'mart', column: 'region' });
  const res = posted.find((m) => m.type === 'dagtracer/result');
  assert.deepEqual(res.absent, { id: 'mart', column: 'region' });
  assert.equal(res.trace, null);
});

test('dagtracer: without a column it offers the box columns from catalog.json', async () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dbtflow-cat-'));
  fs.mkdirSync(path.join(root, 'target'));
  fs.writeFileSync(path.join(root, 'target', 'catalog.json'), JSON.stringify({
    nodes: {
      'model.tpch_dbt.prep2': { columns: {
        REGION: { name: 'region', type: 'VARCHAR', index: 3 },
        STORE_ID: { name: 'store_id', type: 'INTEGER', index: 1 },
      } },
    },
    sources: {},
  }));
  let offered = null;
  const dgt = fakeDgt();
  const { host, posted } = await hostWith(dgt, {}, {
    projectRoot: () => root,
    pick: async (opts) => ((offered = opts), 'region'),
    ask: async () => { throw new Error('should pick, not ask'); },
  });
  await host.handle({ type: 'dagtracer/traceBox', id: 'prep2' });
  assert.deepEqual(offered.items, [{ label: 'store_id', description: 'INTEGER' }, { label: 'region', description: 'VARCHAR' }]);
  assert.equal(offered.allowTyped, true);
  assert.deepEqual(crossingPairs(posted.find((m) => m.type === 'dagtracer/result').trace), ['prep2->mart']);
});

test('dagtracer: without a catalog it asks for the name; cancelling runs nothing', async () => {
  const dgt = fakeDgt();
  let asked = 0;
  // An empty folder, so a real catalog.json on this machine cannot answer instead.
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dbtflow-nocat-'));
  const { host, posted } = await hostWith(dgt, {}, { projectRoot: () => root, ask: async () => (asked++, undefined) });
  const before = dgt.calls.length;
  await host.handle({ type: 'dagtracer/traceBox', id: 'prep2' });
  assert.equal(asked, 1);
  assert.equal(dgt.calls.length, before);
  assert.ok(!posted.some((m) => m.type === 'dagtracer/started'));
});

test('dagtracer: boxes without a file cannot be traced', async () => {
  const { host, posted } = await hostWith(fakeDgt());
  await host.handle({ type: 'dagtracer/traceBox', id: 'nope', column: 'region' });
  assert.match(lastError(posted).message, /no model, seed, snapshot or source/);
});

test('dagtracer: a missing manifest or catalog gets a hint to build first', async () => {
  const run = async (cmd, args) =>
    args[0] === '--version'
      ? okRun('dgt 0.1.0')
      : { ok: false, code: 2, stdout: '', stderr: 'dgt: error: target/manifest.json not found\n', durationMs: 3, error: null };
  const { host, posted } = await hostWith({ run });
  await host.handle({ type: 'dagtracer/traceBox', id: 'prep2', column: 'region' });
  const res = posted.find((m) => m.type === 'dagtracer/result');
  assert.match(res.errors[0].message, /manifest\.json not found\. Run dbt build and dbt docs generate/);
});

test('catalog: columns for models, seeds and sources; null when there is no catalog', () => {
  const { columnsFor } = require('../src/integrations/dagtracer/catalog');
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dbtflow-cat-'));
  assert.equal(columnsFor(root, 'prep2'), null);
  fs.mkdirSync(path.join(root, 'target'));
  fs.writeFileSync(path.join(root, 'target', 'catalog.json'), JSON.stringify({
    nodes: { 'seed.p.raw_orders': { columns: { a: { name: 'order_id', type: 'INTEGER', index: 1 } } } },
    sources: { 'source.p.raw.orders': { columns: { b: { name: 'id', type: 'BIGINT', index: 1 } } } },
  }));
  assert.deepEqual(columnsFor(root, 'raw_orders'), [{ name: 'order_id', type: 'INTEGER' }]);
  assert.deepEqual(columnsFor(root, 'source:raw.orders'), [{ name: 'id', type: 'BIGINT' }]);
  assert.equal(columnsFor(root, 'mart'), null);
  fs.writeFileSync(path.join(root, 'target', 'catalog.json'), '{ broken');
  assert.equal(columnsFor(root, 'raw_orders'), null);
});

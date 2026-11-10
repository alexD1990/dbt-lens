'use strict';
// The integration host and the tool runner: every way an integration or a tool
// can fail must end in a clear state, never in an exception for the caller.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTool, parseJson } = require('../src/host/runTool');
const { IntegrationHost, STATE } = require('../src/host/integrationHost');

const NODE = process.execPath;

// ---------------------------------------------------------------- runTool

test('runTool: success, exit code and stdout', async () => {
  const r = await runTool(NODE, ['-e', 'process.stdout.write(JSON.stringify({a:1}))']);
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.equal(r.error, null);
  assert.deepEqual(parseJson(r.stdout), { ok: true, value: { a: 1 } });
});

test('runTool: non-zero exit is not ok, stderr is kept', async () => {
  const r = await runTool(NODE, ['-e', 'console.error("boom"); process.exit(2)']);
  assert.equal(r.ok, false);
  assert.equal(r.code, 2);
  assert.equal(r.error, null);
  assert.match(r.stderr, /boom/);
});

test('runTool: missing executable resolves with not_found', async () => {
  const r = await runTool('dbtflow-no-such-tool-xyz', ['--version']);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_found');
});

test('runTool: timeout stops the process', async () => {
  const r = await runTool(NODE, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
  assert.ok(r.durationMs < 5000);
});

test('runTool: cancel through an AbortSignal', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const r = await runTool(NODE, ['-e', 'setTimeout(() => {}, 10000)'], { signal: ac.signal });
  assert.equal(r.error, 'cancelled');
});

test('runTool: output larger than the limit is stopped', async () => {
  const r = await runTool(NODE, ['-e', 'process.stdout.write("x".repeat(5000))'], { maxOutput: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'too_large');
});

test('runTool: logs the command line and the outcome', async () => {
  const lines = [];
  await runTool(NODE, ['-e', '1'], { log: (l) => lines.push(l) });
  assert.match(lines[0], /^\$ /);
  assert.ok(lines.some((l) => /exit 0/.test(l)));
});

test('parseJson: empty and broken output', () => {
  assert.equal(parseJson('').ok, false);
  assert.equal(parseJson('not json').ok, false);
});

// ---------------------------------------------------------------- IntegrationHost

function makeHost(over = {}) {
  const posted = [];
  const logs = {};
  const settings = over.settings || {};
  const host = new IntegrationHost({
    projectRoot: () => '/project',
    view: () => ({ nodes: [{ id: 'a' }], edges: [] }),
    post: (m) => posted.push(m),
    setting: (id, key) => settings[`${id}.${key}`],
    logger: (id) => (line) => (logs[id] = logs[id] || []).push(line),
    run: over.run || (async () => ({ ok: true, code: 0, stdout: '', stderr: '', error: null })),
    ...over.services,
  });
  return { host, posted, logs };
}

function fakeIntegration(over = {}) {
  return {
    id: 'fake',
    title: 'Fake',
    detect: async () => ({ ok: true, version: '1.2.3' }),
    activate: (api) => ({ handlers: { echo: async (msg) => api.post('echoed', { value: msg.value }) } }),
    ...over,
  };
}

const lastOfType = (posted, type) => posted.filter((m) => m.type === type).at(-1);

test('host: a working integration becomes ready and gets its messages', async () => {
  const { host, posted } = makeHost();
  host.register(fakeIntegration());
  await host.start();
  assert.deepEqual(host.status()[0], { id: 'fake', title: 'Fake', state: STATE.READY, version: '1.2.3', reason: null, busy: false });
  assert.equal(await host.handle({ type: 'fake/echo', value: 7 }), true);
  assert.deepEqual(lastOfType(posted, 'fake/echoed'), { value: 7, type: 'fake/echoed' });
  assert.ok(lastOfType(posted, 'integrations'), 'the canvas hears about state changes');
});

test('host: messages without a prefix are left to the core', async () => {
  const { host } = makeHost();
  assert.equal(await host.handle({ type: 'move', id: 'a' }), false);
  assert.equal(await host.handle(null), false);
});

test('host: detect that reports a missing tool', async () => {
  const { host, posted } = makeHost();
  host.register(fakeIntegration({ detect: async () => ({ ok: false, state: 'missing', reason: 'not installed' }) }));
  await host.start();
  assert.equal(host.status()[0].state, STATE.MISSING);
  assert.equal(host.status()[0].reason, 'not installed');
  await host.handle({ type: 'fake/echo' });
  assert.match(lastOfType(posted, 'fake/error').message, /not available: not installed/);
});

test('host: detect or activate that throws ends in failed, not in an exception', async () => {
  for (const over of [
    { detect: async () => { throw new Error('detect broke'); } },
    { detect: () => { throw new Error('detect broke'); } },
    { activate: () => { throw new Error('activate broke'); } },
    { activate: () => null },
    { detect: async () => 'yes' },
  ]) {
    const { host } = makeHost();
    host.register(fakeIntegration(over));
    await host.start();
    assert.equal(host.status()[0].state, STATE.FAILED, JSON.stringify(Object.keys(over)));
  }
});

test('host: a handler that throws posts an error and the host keeps working', async () => {
  const { host, posted, logs } = makeHost();
  let calls = 0;
  host.register(fakeIntegration({
    activate: (api) => ({
      handlers: {
        crash: async () => { throw new Error('kaboom'); },
        echo: async () => { calls++; api.post('ok'); },
      },
    }),
  }));
  await host.start();
  await host.handle({ type: 'fake/crash' });
  assert.match(lastOfType(posted, 'fake/error').message, /kaboom/);
  assert.ok(logs.fake.some((l) => /ERROR in crash/.test(l)));
  await host.handle({ type: 'fake/echo' });
  assert.equal(calls, 1);
  assert.equal(host.status()[0].busy, false);
});

test('host: unknown integration and unknown action are refused politely', async () => {
  const { host, posted } = makeHost();
  host.register(fakeIntegration());
  await host.start();
  await host.handle({ type: 'nope/run' });
  assert.match(lastOfType(posted, 'nope/error').message, /no integration called nope/);
  await host.handle({ type: 'fake/missingAction' });
  assert.match(lastOfType(posted, 'fake/error').message, /no action missingAction/);
});

test('host: a second request while busy is refused', async () => {
  const { host, posted } = makeHost();
  let release;
  host.register(fakeIntegration({
    activate: () => ({ handlers: { slow: () => new Promise((r) => (release = r)) } }),
  }));
  await host.start();
  const first = host.handle({ type: 'fake/slow' });
  await host.handle({ type: 'fake/slow' });
  assert.match(lastOfType(posted, 'fake/error').message, /still working/);
  release();
  await first;
  assert.equal(host.status()[0].busy, false);
});

test('host: turned off in settings', async () => {
  const { host } = makeHost({ settings: { 'fake.enabled': false } });
  let detected = false;
  host.register(fakeIntegration({ detect: async () => ((detected = true), { ok: true }) }));
  await host.start();
  assert.equal(host.status()[0].state, STATE.DISABLED);
  assert.equal(detected, false);
});

test('host: modules that fail to load or have the wrong shape are recorded as failed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtflow-int-'));
  fs.mkdirSync(path.join(dir, 'broken'));
  fs.writeFileSync(path.join(dir, 'broken', 'index.js'), 'this is not javascript (');
  fs.mkdirSync(path.join(dir, 'shapeless'));
  fs.writeFileSync(path.join(dir, 'shapeless', 'index.js'), 'module.exports = { id: "shapeless" };');
  const { host } = makeHost();
  host.load(['broken', 'shapeless', 'absent'], dir);
  host.register(fakeIntegration());
  await host.start();
  const byId = Object.fromEntries(host.status().map((s) => [s.id, s]));
  assert.equal(byId.broken.state, STATE.FAILED);
  assert.match(byId.broken.reason, /Could not load/);
  assert.equal(byId.shapeless.state, STATE.FAILED);
  assert.equal(byId.absent.state, STATE.FAILED);
  assert.equal(byId.fake.state, STATE.READY, 'the good one is not affected');
});

test('host: the API hands out copies and survives broken services', async () => {
  let api;
  const { host, posted } = makeHost({
    services: { projectRoot: () => { throw new Error('no root'); } },
  });
  host.register(fakeIntegration({ activate: (a) => ((api = a), { handlers: {} }) }));
  await host.start();
  const v = api.view();
  v.nodes.push({ id: 'evil' });
  assert.equal(api.view().nodes.length, 1, 'changing the copy does not change the graph');
  assert.equal(api.projectRoot(), null);
  api.post('hello', { type: 'graph' });
  assert.equal(posted.at(-1).type, 'fake/hello', 'integrations cannot post core messages');
  assert.throws(() => { api.view = null; }, TypeError);
});

test('host: logger that throws does not break anything', async () => {
  const { host } = makeHost({ services: { logger: () => { throw new Error('no channel'); } } });
  host.register(fakeIntegration());
  await host.start();
  assert.equal(host.status()[0].state, STATE.READY);
});

test('host: recheck after the tool appears', async () => {
  let installed = false;
  const { host } = makeHost();
  host.register(fakeIntegration({
    detect: async () => (installed ? { ok: true, version: '1.0.0' } : { ok: false, state: 'missing', reason: 'no' }),
  }));
  await host.start();
  assert.equal(host.status()[0].state, STATE.MISSING);
  installed = true;
  await host.recheck();
  assert.equal(host.status()[0].state, STATE.READY);
});

test('host: dispose calls each integration dispose once and survives errors', async () => {
  const { host } = makeHost();
  let disposed = 0;
  host.register(fakeIntegration({ activate: () => ({ handlers: {}, dispose: () => { disposed++; throw new Error('x'); } }) }));
  await host.start();
  host.dispose();
  host.dispose();
  assert.equal(disposed, 1);
});

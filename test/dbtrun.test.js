'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planDbt, selectorFor, boxCommands, envFileLine, shellWord, PROJECT_COMMANDS } = require('../src/dbtrun');

const mart = { id: 'mart', name: 'mart', kind: 'model' };

test('a box runs with everything upstream of it', () => {
  assert.equal(planDbt({ command: 'build', node: mart }).line, 'dbt build --select +mart');
  assert.equal(planDbt({ command: 'run', node: { id: 'prep1', name: 'prep1', kind: 'model' } }).line, 'dbt run --select +prep1');
  assert.equal(planDbt({ command: 'snapshot', node: { id: 'snap', name: 'snap', kind: 'snapshot' } }).line, 'dbt snapshot --select +snap');
});

test('seeds have nothing upstream; sources are selected by source:<source>.<table>', () => {
  assert.equal(planDbt({ command: 'seed', node: { id: 'raw_orders', name: 'raw_orders', kind: 'seed' } }).line, 'dbt seed --select raw_orders');
  const src = { id: 'source:shop.orders', name: 'orders', kind: 'source' };
  assert.equal(planDbt({ command: 'test', node: src }).line, 'dbt test --select source:shop.orders');
  assert.deepEqual(boxCommands(src), ['test']);
  assert.equal(planDbt({ command: 'build', node: src }).ok, false);
});

test('boxes without a file get no dbt commands', () => {
  for (const kind of ['planned', 'missing']) {
    const n = { id: 'x', name: 'x', kind };
    assert.equal(selectorFor(n), null);
    assert.deepEqual(boxCommands(n), []);
    assert.equal(planDbt({ command: 'build', node: n }).ok, false);
  }
});

test('whole project, executable and target', () => {
  assert.equal(planDbt({ command: 'build' }).line, 'dbt build');
  assert.equal(planDbt({ command: 'docs generate', target: 'databricks' }).line, 'dbt docs generate --target databricks');
  assert.equal(
    planDbt({ command: 'build', node: mart, executable: '~/.venvs/dbt-databricks/bin/dbt', target: 'databricks' }).line,
    '~/.venvs/dbt-databricks/bin/dbt build --select +mart --target databricks'
  );
  // deps takes no --target.
  assert.equal(planDbt({ command: 'deps', target: 'databricks' }).line, 'dbt deps');
  // Blank settings fall back to plain dbt and no target.
  assert.equal(planDbt({ command: 'run', executable: '  ', target: '' }).line, 'dbt run');
});

test('only listed commands run, and every part is quoted', () => {
  assert.equal(planDbt({ command: 'rm -rf /' }).ok, false);
  assert.equal(planDbt({ command: 'clean' }).ok, false);
  assert.equal(planDbt({}).ok, false);
  assert.equal(shellWord("it's; rm x"), `'it'\\''s; rm x'`);
  assert.equal(shellWord('~/my venv/bin/dbt'), `"$HOME"/'my venv/bin/dbt'`);
  assert.equal(shellWord('-x'), `'-x'`);
  assert.equal(
    planDbt({ command: 'run', node: { id: 'a$b', name: 'a$(b)', kind: 'model' }, target: 'dev; rm' }).line,
    `dbt run --select '+a$(b)' --target 'dev; rm'`
  );
  for (const c of PROJECT_COMMANDS) if (c !== '-') assert.equal(planDbt({ command: c.command }).ok, true, c.command);
});

test('env file is loaded into the terminal once, exporting plain KEY=VALUE lines too', () => {
  assert.equal(envFileLine('~/.databricks.env'), 'set -a; . ~/.databricks.env; set +a');
  assert.equal(envFileLine(''), null);
  assert.equal(envFileLine(undefined), null);
});

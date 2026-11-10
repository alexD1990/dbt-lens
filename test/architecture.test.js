'use strict';
// Keeps the boundaries in docs/ARCHITECTURE.md from eroding:
// - the core (src/*.js) never requires the host or any integration,
// - the host never requires the core, an integration or vscode,
// - an integration only requires files in its own folder and Node built-ins.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const SRC = path.join(__dirname, '..', 'src');
const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

function requires(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
}

const resolvedInside = (file, spec, dir) => {
  if (!spec.startsWith('.')) return false;
  const target = path.resolve(path.dirname(file), spec);
  return target === dir || target.startsWith(dir + path.sep);
};

test('core files never require the host or integrations', () => {
  const core = fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).map((f) => path.join(SRC, f));
  assert.ok(core.length >= 6);
  for (const file of core) {
    for (const spec of requires(file)) {
      assert.ok(!/(^|\/)(host|integrations)(\/|$)/.test(spec), `${path.basename(file)} requires ${spec}`);
    }
  }
});

test('the host only requires its own files and Node built-ins', () => {
  const dir = path.join(SRC, 'host');
  for (const file of jsFiles(dir)) {
    for (const spec of requires(file)) {
      assert.ok(BUILTIN.has(spec) || resolvedInside(file, spec, dir), `host/${path.basename(file)} requires ${spec}`);
    }
  }
});

test('the host loads integrations by path, not by require from the core', () => {
  const text = fs.readFileSync(path.join(SRC, 'host', 'integrationHost.js'), 'utf8');
  assert.match(text, /INTEGRATIONS_DIR/);
});

test('each integration only requires files in its own folder and Node built-ins', () => {
  const root = path.join(SRC, 'integrations');
  const folders = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(folders.length >= 1);
  for (const f of folders) {
    const dir = path.join(root, f.name);
    for (const file of jsFiles(dir)) {
      for (const spec of requires(file)) {
        assert.ok(
          BUILTIN.has(spec) || resolvedInside(file, spec, dir),
          `integrations/${f.name}/${path.relative(dir, file)} requires ${spec}`
        );
      }
    }
  }
});

test('every listed integration has a folder', () => {
  const list = require('../src/integrations');
  for (const name of list) assert.ok(fs.existsSync(path.join(SRC, 'integrations', name, 'index.js')), name);
});

test('canvas add-ons only use the API main.js gives them', () => {
  const dir = path.join(__dirname, '..', 'media', 'integrations');
  const list = require('../src/integrations');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const id = file.slice(0, -3);
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(list.includes(id), `media/integrations/${file} has no integration called ${id}`);
    assert.doesNotMatch(text, /acquireVsCodeApi/, `${file} must post through its API, not its own VS Code handle`);
    assert.match(text, /window\.dbtFlowPlugins/, `${file} must register through window.dbtFlowPlugins`);
    assert.match(text, new RegExp(`id: '${id}'`), `${file} must register with id '${id}'`);
  }
});

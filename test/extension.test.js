'use strict';
// Loads extension.js with a fake `vscode` module and drives the webview message
// handler, to catch wiring mistakes that the pure model tests cannot see.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function makeVscode(wsRoot, answers) {
  const posted = [];
  const warnings = [];
  const handlers = { panels: [] };
  const commands = {};
  const emitter = () => () => ({ dispose() {} });
  const vscode = {
    Uri: {
      file: (p) => ({ fsPath: p, toString: () => 'file://' + p }),
      joinPath: (u, ...parts) => ({ fsPath: path.join(u.fsPath, ...parts) }),
    },
    ViewColumn: { One: 1, Two: 2, Beside: -2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1 },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: wsRoot } }],
      textDocuments: [],
      getConfiguration: () => ({
        get: (k) => ({ projectPath: '', confirmFileEdits: true, openCreatedFile: true, openOnStartup: true })[k],
        update: async () => {},
      }),
      createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
      onDidChangeWorkspaceFolders: emitter(),
      onDidRenameFiles: (fn) => {
        handlers.rename = fn;
        return { dispose() {} };
      },
      onDidChangeConfiguration: emitter(),
    },
    window: {
      activeTextEditor: null,
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      onDidChangeActiveTextEditor: emitter(),
      showInputBox: async (opts) => {
        const v = answers.shift();
        if (opts.validateInput && v) {
          const err = opts.validateInput(v);
          if (err) throw new Error('validation: ' + err);
        }
        return v;
      },
      showQuickPick: async (items) => items[0],
      showInformationMessage: async (msg, opts, ...buttons) => (typeof opts === 'object' ? buttons[0] : undefined),
      showWarningMessage: (m, ...buttons) => {
        warnings.push(m);
        return Promise.resolve(buttons.includes('Update refs') ? 'Update refs' : undefined);
      },
      showErrorMessage: (m) => warnings.push('ERR ' + m),
      setStatusBarMessage: () => {},
      showTextDocument: async (uri, opts = {}) => posted.push({ opened: uri.fsPath, viewColumn: opts.viewColumn }),
      tabGroups: { all: [{}, {}] },
      createWebviewPanel: (type, title, showOptions, options) => {
        const panel = {
          type, title, showOptions, options, viewColumn: showOptions.viewColumn,
          webview: handlers.webview,
          reveal() { panel.revealed = (panel.revealed || 0) + 1; },
          onDidDispose() {},
        };
        handlers.panels.push(panel);
        return panel;
      },
    },
    commands: {
      executeCommand: async (id) => posted.push({ command: id }),
      registerCommand: (id, fn) => {
        commands[id] = fn;
        return { dispose() {} };
      },
    },
  };
  return { vscode, posted, warnings, handlers, commands };
}

test('extension activates, renders HTML and handles canvas messages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtflow-ext-'));
  fs.writeFileSync(path.join(root, 'dbt_project.yml'), 'name: demo\n');
  fs.mkdirSync(path.join(root, 'models', 'staging'), { recursive: true });
  fs.writeFileSync(path.join(root, 'models', 'staging', 'stg_a.sql'), 'select 1 as id\n');

  const answers = ['stg_b', 'fct_c'];
  const fake = makeVscode(root, answers);
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'vscode') return fake.vscode;
    return origLoad.call(this, request, ...rest);
  };
  delete require.cache[require.resolve('../extension')];
  const ext = require('../extension');
  Module._load = origLoad;

  const context = {
    subscriptions: [],
    extensionUri: { fsPath: path.join(__dirname, '..') },
    workspaceState: { get: () => undefined, update: async () => {} },
  };
  let onMessage;
  const graphs = [];
  const webview = {
    cspSource: 'vscode-resource:',
    asWebviewUri: (u) => 'vscode-resource:' + u.fsPath,
    postMessage: (m) => {
      if (m.type === 'graph') graphs.push(m.view);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (fn) => {
      onMessage = fn;
      return { dispose() {} };
    },
  };
  fake.handlers.webview = webview;
  ext.activate(context);
  assert.ok(fake.commands['dbtFlow.openPanel']);

  // On startup the canvas opens by itself as an editor tab to the right, without stealing focus.
  assert.equal(fake.handlers.panels.length, 0);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(fake.handlers.panels.length, 1);
  const panel = fake.handlers.panels[0];
  assert.equal(panel.type, 'dbtFlow.panel');
  assert.deepEqual(panel.showOptions, { viewColumn: 2, preserveFocus: true });
  assert.equal(panel.options.retainContextWhenHidden, true);
  // The command focuses the existing tab instead of opening a second one.
  fake.commands['dbtFlow.openPanel']();
  assert.equal(fake.handlers.panels.length, 1);
  assert.equal(panel.revealed, 1);
  assert.match(webview.html, /Content-Security-Policy/);
  assert.match(webview.html, /media\/main\.js/);

  const send = async (m) => {
    onMessage(m);
    await new Promise((r) => setTimeout(r, 20));
  };
  await send({ type: 'ready' });
  assert.equal(graphs.at(-1).nodes.length, 1);

  await send({ type: 'createBoxAt', x: 0, y: 200 });
  await send({ type: 'createBoxAt', x: 300, y: 100 });
  await send({ type: 'connect', from: 'stg_a', to: 'fct_c' });
  await send({ type: 'connect', from: 'stg_b', to: 'fct_c' });
  assert.equal(graphs.at(-1).plannedCount, 2);
  await send({ type: 'createAll' });
  const fct = fs.readFileSync(path.join(root, 'models', 'fct_c.sql'), 'utf8');
  assert.match(fct, /ref\('stg_a'\)/);
  assert.match(fct, /ref\('stg_b'\)/);

  // Connecting two real files asks first (fake says yes) and edits the file.
  await send({ type: 'connect', from: 'stg_b', to: 'stg_a' });
  assert.match(fs.readFileSync(path.join(root, 'models', 'staging', 'stg_a.sql'), 'utf8'), /ref\('stg_b'\)/);
  // ...which would loop back: stg_a -> fct_c already, fct_c -> stg_a must be refused.
  await send({ type: 'connect', from: 'fct_c', to: 'stg_b' });
  assert.ok(fake.warnings.some((w) => /loop/.test(w)), fake.warnings.join('\n'));

  await send({ type: 'undo' });
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'models', 'staging', 'stg_a.sql'), 'utf8'), /ref\('stg_b'\)/);
  // Renaming a file in Explorer: the box keeps its place and refs are updated on request.
  const before = graphs.at(-1).nodes.find((n) => n.id === 'stg_b');
  const oldUri = fake.vscode.Uri.file(path.join(root, 'models', 'staging', 'stg_b.sql'));
  const newUri = fake.vscode.Uri.file(path.join(root, 'models', 'staging', 'stg_bb.sql'));
  fs.renameSync(oldUri.fsPath, newUri.fsPath);
  fake.handlers.rename({ files: [{ oldUri, newUri }] });
  await new Promise((r) => setTimeout(r, 50));
  assert.match(fs.readFileSync(path.join(root, 'models', 'fct_c.sql'), 'utf8'), /ref\('stg_bb'\)/);
  const after = graphs.at(-1);
  assert.ok(!after.nodes.some((n) => n.id === 'stg_b'), 'old box is gone');
  const moved = after.nodes.find((n) => n.id === 'stg_bb');
  assert.deepEqual([moved.x, moved.y], [before.x, before.y]);

  // Files open to the left of the canvas, which stays on the right.
  await send({ type: 'open', id: 'stg_a' });
  assert.deepEqual(fake.posted.at(-1), { opened: path.join(root, 'models', 'staging', 'stg_a.sql'), viewColumn: 1 });
  // Canvas alone on screen (all files closed): open beside it, then move that group to the left.
  panel.viewColumn = 1;
  fake.vscode.window.tabGroups.all = [{}];
  await send({ type: 'open', id: 'stg_a' });
  assert.deepEqual(fake.posted.slice(-2), [
    { opened: path.join(root, 'models', 'staging', 'stg_a.sql'), viewColumn: 2 },
    { command: 'workbench.action.moveActiveEditorGroupLeft' },
  ]);
  assert.equal(fake.warnings.filter((w) => w.startsWith('ERR')).length, 0, fake.warnings.join('\n'));
});
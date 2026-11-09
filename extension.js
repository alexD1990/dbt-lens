'use strict';

const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const { FlowModel } = require('./src/model');
const { createNodeIO } = require('./src/nodeio');
const { findProjectRoots } = require('./src/project');

const PANEL_TYPE = 'dbtFlow.panel';
const STARTUP_DELAY_MS = 500;
const FOLDER_RE = /^[\w-]+(\/[\w-]+)*$/;

class Controller {
  constructor(context) {
    this.context = context;
    this.surfaces = new Set(); // { webview, kind: 'view' | 'panel', panel? }
    this.panel = null;
    this.model = null;
    this.io = createNodeIO((abs) =>
      vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.fsPath === abs)
    );
    this.refreshTimer = null;
  }

  // ------------------------------------------------------------ project

  loadProject(forceRoot) {
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    if (!folders.length) {
      this.model = null;
      return;
    }
    let root = forceRoot;
    if (!root) {
      const configured = vscode.workspace.getConfiguration('dbtFlow').get('projectPath');
      if (configured) {
        root = path.isAbsolute(configured) ? configured : path.join(folders[0], configured);
      }
    }
    if (!root) {
      const roots = findProjectRoots(folders, this.io);
      const remembered = this.context.workspaceState.get('dbtFlow.root');
      root = roots.includes(remembered) ? remembered : roots[0] || folders[0];
      this.roots = roots;
    }
    this.model = new FlowModel(this.io);
    this.model.open(root);
    if (this.model.loadError) vscode.window.showWarningMessage(`dbt Flow: ${this.model.loadError}`);
  }

  async selectProject() {
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const roots = findProjectRoots(folders, this.io);
    if (!roots.length) {
      vscode.window.showInformationMessage('dbt Flow found no dbt_project.yml in this workspace.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      roots.map((r) => ({ label: path.basename(r), description: r, root: r })),
      { placeHolder: 'Which dbt project should dbt Flow show?' }
    );
    if (!pick) return;
    await this.context.workspaceState.update('dbtFlow.root', pick.root);
    this.loadProject(pick.root);
    this.broadcast();
  }

  scheduleRefresh(stateFile = false) {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      if (!this.model) return this.loadProject(), this.broadcast();
      if (stateFile && this.model.stateChangedOnDisk()) this.model.open(this.model.cfg.root);
      else this.model.refresh();
      this.broadcast();
    }, 200);
  }

  broadcast() {
    const view = this.model ? this.model.getView() : null;
    for (const s of this.surfaces) s.webview.postMessage({ type: 'graph', view });
    this.postActiveFile();
  }

  postActiveFile() {
    const ed = vscode.window.activeTextEditor;
    let id = null;
    if (ed && this.model) {
      const fsPath = ed.document.uri.fsPath;
      for (const n of this.model.nodes.values()) if (n.abs === fsPath && n.kind === 'model') id = n.id;
    }
    for (const s of this.surfaces) s.webview.postMessage({ type: 'activeFile', id });
  }

  // ------------------------------------------------------------ webviews

  attach(webview, kind, panel) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">
<title>dbt Flow</title>
</head>
<body data-surface="${kind}">
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    const surface = { webview, kind, panel };
    this.surfaces.add(surface);
    const sub = webview.onDidReceiveMessage((msg) =>
      this.handle(msg, surface).catch((e) => vscode.window.showErrorMessage(`dbt Flow: ${e.message}`))
    );
    return {
      dispose: () => {
        sub.dispose();
        this.surfaces.delete(surface);
      },
    };
  }

  /**
   * Opens the canvas as an editor tab in the group to the right of the code,
   * so Explorer, the file and the canvas are all visible at once.
   * On startup it opens without taking focus from the file.
   */
  openPanel({ preserveFocus = false } = {}) {
    if (this.panel) {
      this.panel.reveal(undefined, preserveFocus);
      return;
    }
    const ed = vscode.window.activeTextEditor;
    const column = ed && ed.viewColumn ? ed.viewColumn + 1 : vscode.ViewColumn.Two;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      PANEL_TYPE,
      'dbt Flow',
      { viewColumn: column, preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] }
    );
    panel.iconPath = {
      dark: vscode.Uri.joinPath(media, 'icon.svg'),
      light: vscode.Uri.joinPath(media, 'icon-light.svg'),
    };
    const handle = this.attach(panel.webview, 'panel', panel);
    this.panel = panel;
    panel.onDidDispose(() => {
      handle.dispose();
      this.panel = null;
    });
  }

  // ------------------------------------------------------------ messages

  report(result, successMessage) {
    if (!result) return;
    if (result.ok === false && result.message && !result.quiet) {
      vscode.window.showWarningMessage(result.message);
    } else if (result.ok !== false && successMessage) {
      vscode.window.setStatusBarMessage(`dbt Flow: ${successMessage}`, 4000);
    }
    this.broadcast();
  }

  async handle(msg, surface) {
    if (msg.type === 'ready') {
      if (!this.model) this.loadProject();
      return this.broadcast();
    }
    const m = this.model;
    if (!m) return;

    switch (msg.type) {
      case 'createBoxAt': {
        const name = await this.askName('Name of the new model', '');
        if (!name) return;
        const place = await this.pickFolder(name);
        if (!place) return;
        return this.report(m.createBox(name, place, msg.x, msg.y));
      }
      case 'planMissing': {
        const place = await this.pickFolder(msg.id);
        if (!place) return;
        const n = m.getView().nodes.find((x) => x.id === msg.id);
        return this.report(m.createBox(msg.id, place, n ? n.x : 0, n ? n.y : 0));
      }
      case 'rename': {
        const name = await this.askName(`Rename ${msg.id}`, msg.id, msg.id);
        if (!name || name === msg.id) return;
        return this.report(m.renameBox(msg.id, name));
      }
      case 'changeFolder': {
        const place = await this.pickFolder(msg.id, true);
        if (!place) return;
        return this.report(m.setFolder(msg.id, place));
      }
      case 'deleteBox':
        return this.report(m.deleteBox(msg.id));
      case 'move':
        return this.report(m.moveNode(msg.id, msg.x, msg.y));
      case 'unlock':
        return this.report(m.unlock(msg.id));
      case 'lockHere':
        return this.report(m.lockHere(msg.id));
      case 'revert':
        return this.report(m.revert(msg.id));
      case 'revertAll':
        return this.report(m.revertAll());
      case 'tidy':
        return this.report(m.tidy(), 'Layout tidied. Undo puts it back.');
      case 'undo': {
        const r = m.undo();
        return this.report(r, r.ok ? r.message : null);
      }
      case 'redo': {
        const r = m.redo();
        return this.report(r, r.ok ? r.message : null);
      }
      case 'refresh':
        m.refresh();
        return this.broadcast();
      case 'connect':
        return this.connect(msg.from, msg.to);
      case 'disconnect': {
        const r = m.disconnect(msg.from, msg.to);
        if (r.fileEdge) {
          const choice = await vscode.window.showInformationMessage(r.message, 'Open file');
          if (choice) this.openFile(msg.to, surface);
          return;
        }
        return this.report(r);
      }
      case 'open':
        return this.openFile(msg.id, surface);
      case 'createFile': {
        const r = m.createFiles([msg.id]);
        this.report(r, `Created ${msg.id}.sql`);
        if (r.ok && vscode.workspace.getConfiguration('dbtFlow').get('openCreatedFile')) {
          this.openFile(msg.id, surface);
        }
        return;
      }
      case 'createAll': {
        const ids = m.getView().nodes.filter((n) => n.kind === 'planned').map((n) => n.id);
        const r = m.createFiles(ids);
        return this.report(r, r.ok ? `Created ${ids.length} file${ids.length > 1 ? 's' : ''}` : null);
      }
      case 'selectProject':
        return this.selectProject();
    }
  }

  async connect(from, to) {
    const m = this.model;
    const plan = m.planConnect(from, to);
    if (!plan.ok) return this.report(plan);
    const config = vscode.workspace.getConfiguration('dbtFlow');
    if (plan.fileEdit && config.get('confirmFileEdits')) {
      const expr = plan.from.kind === 'source'
        ? `{{ source('${plan.from.source}', '${plan.from.table}') }}`
        : `{{ ref('${plan.from.name}') }}`;
      const always = 'Add, and stop asking';
      const choice = await vscode.window.showInformationMessage(
        `Add ${expr} to ${plan.rel}?`,
        { modal: true, detail: 'It goes in as an import CTE at the top of the file. Undo in dbt Flow takes it out again.' },
        'Add ref',
        always
      );
      if (!choice) return this.broadcast();
      if (choice === always) await config.update('confirmFileEdits', false, vscode.ConfigurationTarget.Global);
    }
    this.report(m.connect(from, to), `Connected ${plan.from.name} to ${plan.to.name}`);
  }

  async openFile(id, surface) {
    const abs = this.model.absPath(id);
    if (!abs) return;
    let viewColumn;
    if (surface && surface.panel) {
      // Keep the canvas visible: open next to it, not on top of it.
      viewColumn = surface.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: false, viewColumn });
  }

  askName(prompt, value, ignore) {
    return vscode.window
      .showInputBox({
        prompt,
        value,
        placeHolder: 'e.g. stg_orders, int_orders_joined, fct_orders',
        validateInput: (v) => this.model.validateName(v.trim(), ignore),
      })
      .then((v) => (v ? v.trim() : v));
  }

  /** Returns { modelDir, folder } or undefined if cancelled. */
  async pickFolder(name, alwaysAsk = false) {
    const m = this.model;
    const choices = m.folderChoices();
    if (choices.length === 1 && !alwaysAsk) return choices[0];
    const suggested = m.suggestFolder(name, choices);
    const items = choices.map((c, i) => ({
      label: c.folder ? `$(folder) ${c.folder}` : `$(root-folder) ${c.modelDir}`,
      description: i === suggested && suggested !== 0 ? 'suggested from the name' : c.folder ? `${c.modelDir}/${c.folder}` : 'top of the models folder',
      choice: c,
    }));
    const ordered = [items[suggested], ...items.filter((_, i) => i !== suggested)];
    ordered.push({ label: '$(new-folder) New folder…', description: 'created when the file is created', newFolder: true });
    const pick = await vscode.window.showQuickPick(ordered, { placeHolder: `Where should ${name}.sql go?` });
    if (!pick) return undefined;
    if (!pick.newFolder) return pick.choice;
    const folder = await vscode.window.showInputBox({
      prompt: `New folder inside ${choices[0].modelDir}/`,
      placeHolder: 'e.g. staging or marts/finance',
      validateInput: (v) => (FOLDER_RE.test(v.trim()) ? null : 'Use letters, numbers, - and _; separate subfolders with /.'),
    });
    if (!folder) return undefined;
    return { modelDir: choices[0].modelDir, folder: folder.trim() };
  }
}

function activate(context) {
  const ctl = new Controller(context);

  // A status bar button to bring the canvas back after it has been closed.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.text = '$(type-hierarchy-sub) dbt Flow';
  status.tooltip = 'Open the dbt Flow canvas';
  status.command = 'dbtFlow.openPanel';
  status.show();

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand('dbtFlow.openPanel', () => ctl.openPanel()),
    vscode.commands.registerCommand('dbtFlow.refresh', () => {
      ctl.loadProject(ctl.model ? ctl.model.cfg.root : undefined);
      ctl.broadcast();
    }),
    vscode.commands.registerCommand('dbtFlow.undo', () => ctl.handle({ type: 'undo' })),
    vscode.commands.registerCommand('dbtFlow.redo', () => ctl.handle({ type: 'redo' })),
    vscode.commands.registerCommand('dbtFlow.tidy', () => ctl.handle({ type: 'tidy' })),
    vscode.commands.registerCommand('dbtFlow.createAll', () => ctl.handle({ type: 'createAll' })),
    vscode.commands.registerCommand('dbtFlow.selectProject', () => ctl.selectProject()),
    vscode.window.onDidChangeActiveTextEditor(() => ctl.postActiveFile()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      ctl.loadProject();
      ctl.broadcast();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dbtFlow.projectPath')) {
        ctl.loadProject();
        ctl.broadcast();
      }
    })
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{sql,py,csv,yml,yaml}');
  const onChange = () => ctl.scheduleRefresh();
  watcher.onDidCreate(onChange);
  watcher.onDidChange(onChange);
  watcher.onDidDelete(onChange);
  const stateWatcher = vscode.workspace.createFileSystemWatcher('**/.dbtflow.json');
  const onState = () => ctl.scheduleRefresh(true);
  stateWatcher.onDidChange(onState);
  stateWatcher.onDidCreate(onState);
  context.subscriptions.push(watcher, stateWatcher);

  // Open next to the code when VS Code starts, after editors have been restored.
  if (vscode.workspace.getConfiguration('dbtFlow').get('openOnStartup')) {
    const timer = setTimeout(() => {
      if (!ctl.panel) ctl.openPanel({ preserveFocus: true });
    }, STARTUP_DELAY_MS);
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }
}

function deactivate() {}

module.exports = { activate, deactivate };

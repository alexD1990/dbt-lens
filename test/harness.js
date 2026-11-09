'use strict';
// Drives the real webview (media/main.js) against the real FlowModel in a headless
// browser. VS Code's input boxes are replaced by queued answers.
// Usage: NODE_PATH=<global node_modules> node test/harness.js <outDir>

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { FlowModel } = require('../src/model');
const { createNodeIO } = require('../src/nodeio');

const OUT = process.argv[2] || path.join(os.tmpdir(), 'dbtflow-shots');
fs.mkdirSync(OUT, { recursive: true });

const DARK = {
  '--vscode-font-family': '-apple-system, "Segoe UI", system-ui, sans-serif',
  '--vscode-font-size': '13px',
  '--vscode-editor-font-family': 'Consolas, "DejaVu Sans Mono", monospace',
  '--vscode-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-sideBar-background': '#181818',
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-editorWidget-background': '#202020',
  '--vscode-widget-border': '#313131',
  '--vscode-widget-shadow': 'rgba(0,0,0,0.36)',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-input-background': '#313131',
  '--vscode-input-border': '#3c3c3c',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-button-background': '#0078d4',
  '--vscode-button-foreground': '#ffffff',
  '--vscode-button-hoverBackground': '#026ec1',
  '--vscode-toolbar-hoverBackground': 'rgba(90,93,94,0.31)',
  '--vscode-menu-background': '#1f1f1f',
  '--vscode-menu-foreground': '#cccccc',
  '--vscode-menu-border': '#454545',
  '--vscode-menu-selectionBackground': '#0078d4',
  '--vscode-menu-selectionForeground': '#ffffff',
  '--vscode-menu-separatorBackground': '#454545',
  '--vscode-errorForeground': '#f85149',
  '--vscode-editorWarning-foreground': '#cca700',
  '--vscode-editorHoverWidget-background': '#202020',
  '--vscode-editorHoverWidget-border': '#454545',
};
const LIGHT = {
  ...DARK,
  '--vscode-foreground': '#3b3b3b',
  '--vscode-descriptionForeground': '#717171',
  '--vscode-sideBar-background': '#f8f8f8',
  '--vscode-editor-background': '#ffffff',
  '--vscode-editorWidget-background': '#ffffff',
  '--vscode-widget-border': '#e5e5e5',
  '--vscode-widget-shadow': 'rgba(0,0,0,0.12)',
  '--vscode-focusBorder': '#005fb8',
  '--vscode-input-background': '#ffffff',
  '--vscode-input-border': '#cecece',
  '--vscode-input-foreground': '#3b3b3b',
  '--vscode-menu-background': '#ffffff',
  '--vscode-menu-foreground': '#3b3b3b',
  '--vscode-menu-border': '#cecece',
  '--vscode-toolbar-hoverBackground': 'rgba(184,184,184,0.31)',
  '--vscode-errorForeground': '#e51400',
  '--vscode-editorHoverWidget-background': '#f8f8f8',
};

const PROJECT = {
  'dbt_project.yml': "name: 'jaffle_shop'\nversion: '1.0.0'\nmodel-paths: [\"models\"]\n",
  'models/staging/stg_customers.sql': "select * from {{ source('shop', 'raw_customers') }}\n",
  'models/staging/stg_orders.sql': "select * from {{ source('shop', 'raw_orders') }}\n",
  'models/staging/stg_payments.sql': "select * from {{ source('stripe', 'payments') }}\n",
  'models/staging/stg_products.sql': "select * from {{ source('shop', 'raw_products') }}\n",
  'models/intermediate/int_order_payments.sql':
    "with orders as (select * from {{ ref('stg_orders') }}),\npayments as (select * from {{ ref('stg_payments') }})\nselect * from orders\n",
  'models/intermediate/int_order_items.sql':
    "select * from {{ ref('stg_orders') }} join {{ ref('stg_products') }} join {{ ref('product_categories') }}\n",
  'models/marts/fct_orders.sql':
    "{{ config(materialized='incremental') }}\nselect * from {{ ref('int_order_payments') }} join {{ ref('int_order_items') }}\n",
  'models/marts/dim_customers.sql':
    "{{ config(materialized='table') }}\nselect * from {{ ref('stg_customers') }} join {{ ref('fct_orders') }}\n",
  'models/marts/customer_ltv.sql': "select * from {{ ref('dim_customers') }} join {{ ref('customer_segments') }}\n",
  'seeds/product_categories.csv': 'id,name\n',
};

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jaffle-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

async function main() {
  const answers = []; // queued replies for "input boxes"
  const log = [];
  const root = fixture(PROJECT);
  const model = new FlowModel(createNodeIO());
  model.open(root);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 720 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => log.push('PAGE ERROR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && log.push('CONSOLE ' + m.text()));

  const send = (view) => page.evaluate((v) => window.postMessage({ type: 'graph', view: v }, '*'), view);

  await page.exposeFunction('__toHost', async (msg) => {
    log.push('-> ' + JSON.stringify(msg));
    let r = null;
    const ask = () => answers.shift();
    switch (msg.type) {
      case 'ready': break;
      case 'createBoxAt': {
        const name = ask();
        const choices = model.folderChoices();
        r = model.createBox(name, choices[model.suggestFolder(name, choices)], msg.x, msg.y);
        break;
      }
      case 'planMissing': {
        const choices = model.folderChoices();
        const n = model.getView().nodes.find((x) => x.id === msg.id);
        r = model.createBox(msg.id, choices[model.suggestFolder(msg.id, choices)], n.x, n.y);
        break;
      }
      case 'move': r = model.moveNode(msg.id, msg.x, msg.y); break;
      case 'rename': r = model.renameModel(msg.id, ask()); break;
      case 'retarget': r = model.retargetRefs(msg.id, ask()); break;
      case 'removeFromCanvas': r = model.removeFromCanvas(msg.id); break;
      case 'showHidden': r = model.showHidden(); break;
      case 'tidy': r = model.tidy(); break;
      case 'undo': r = model.undo(); break;
      case 'redo': r = model.redo(); break;
      case 'connect': r = model.connect(msg.from, msg.to); break;
      case 'disconnect': r = model.disconnect(msg.from, msg.to); break;
      case 'deleteBox': r = model.deleteBox(msg.id); break;
      case 'createFile': r = model.createFiles([msg.id]); break;
      case 'createAll': r = model.createFiles(model.getView().nodes.filter((n) => n.kind === 'planned').map((n) => n.id)); break;
      default: break;
    }
    if (r) log.push('<- ' + JSON.stringify({ ok: r.ok, message: r.message }));
    await send(model.getView());
  });

  const vars = (theme) => Object.entries(theme).map(([k, v]) => `${k}:${v}`).join(';');
  const html = (theme, surface) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>:root{${vars(theme)}}</style>
<link rel="stylesheet" href="file://${path.join(__dirname, '../media/main.css')}"></head>
<body class="${theme === LIGHT ? 'vscode-light' : 'vscode-dark'}" data-surface="${surface}"><div id="app"></div>
<script>window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__toHost(m),getState:()=>null,setState:()=>{}});</script>
<script src="file://${path.join(__dirname, '../media/main.js')}"></script></body></html>`;

  const htmlPath = path.join(OUT, 'harness.html');
  const load = async (theme, surface = 'panel') => {
    fs.writeFileSync(htmlPath, html(theme, surface));
    await page.goto('file://' + htmlPath);
    await page.waitForSelector('.node');
    await page.waitForTimeout(150);
  };
  const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png') });
  const box = async (id) => page.locator(`.node[data-id="${id}"]`).boundingBox();

  // 1. Existing project, dark theme.
  await load(DARK);
  await shot('01-existing-dark');

  // 2. Select a model to see lineage.
  let b = await box('fct_orders');
  await page.mouse.click(b.x + 60, b.y + 20);
  await page.waitForTimeout(150);
  await shot('02-lineage');
  await page.keyboard.press('Escape');

  const canvas0 = await page.locator('#viewport').boundingBox();
  // 3. Boxes move freely; right-click menus for a model and a missing ref.
  b = await box('dim_customers');
  await page.mouse.move(b.x + 60, b.y + 20);
  await page.mouse.down();
  await page.mouse.move(b.x + 120, b.y + 190, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  await shot('03-moved');
  b = await box('dim_customers');
  await page.mouse.click(b.x + 60, b.y + 20, { button: 'right' });
  await page.waitForSelector('.menu:not([hidden])');
  await shot('04-node-menu');
  answers.push('dim_customer');
  await page.locator('.menu-item', { hasText: 'Rename' }).click();
  await page.waitForSelector('.node[data-id="dim_customer"]');
  b = await box('customer_segments');
  await page.mouse.click(b.x + 60, b.y + 20, { button: 'right' });
  await page.waitForSelector('.menu:not([hidden])');
  await shot('05-missing-menu');
  await page.keyboard.press('Escape');
  await page.mouse.click(b.x + 60, b.y + 20);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(150);
  await shot('05b-missing-removed');
  await page.mouse.click(canvas0.x + 600, canvas0.y + 650, { button: 'right' });
  await page.waitForSelector('.menu:not([hidden])');
  await shot('05c-canvas-menu-show-removed');
  await page.locator('.menu-item', { hasText: 'Show removed boxes' }).click();
  await page.waitForTimeout(150);

  // 4. Plan new boxes on the canvas, connect them, create files.
  const canvas = await page.locator('#viewport').boundingBox();
  answers.push('fct_revenue');
  await page.mouse.click(canvas.x + canvas.width - 300, canvas.y + 150, { button: 'right' });
  await page.waitForSelector('.menu:not([hidden])');
  await shot('06-canvas-menu');
  await page.locator('.menu-item', { hasText: 'Create new box' }).click();
  await page.waitForSelector('.node[data-id="fct_revenue"]');
  await page.waitForTimeout(100);

  // Drag from fct_orders' output port onto the new box.
  b = await box('fct_orders');
  const target = await box('fct_revenue');
  await page.mouse.move(b.x + 40, b.y + 20);
  await page.waitForTimeout(50);
  await page.mouse.move(b.x + b.width + 1, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 60, target.y + 25, { steps: 10 });
  await shot('07-connecting');
  await page.mouse.up();
  await page.waitForTimeout(200);

  // Plan the missing ref as a box.
  b = await box('customer_segments');
  await page.mouse.click(b.x + 60, b.y + 20, { button: 'right' });
  await page.locator('.menu-item', { hasText: 'Plan this model' }).click();
  await page.waitForTimeout(200);
  await shot('08-planned-boxes');

  // Create all files.
  await page.locator('#btn-create-all').click();
  await page.waitForTimeout(250);
  await shot('09-files-created');

  // Undo it all, then redo.
  await page.locator('#viewport').focus();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  const afterUndo = fs.existsSync(path.join(root, 'models/marts/fct_revenue.sql'));
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(200);
  const afterRedo = fs.readFileSync(path.join(root, 'models/marts/fct_revenue.sql'), 'utf8');

  // 5. Light theme in a narrow sidebar.
  await page.setViewportSize({ width: 420, height: 640 });
  await load(LIGHT, 'view');
  await shot('10-light-sidebar');

  // 6. Empty project.
  const emptyRoot = fixture({ 'dbt_project.yml': 'name: fresh\n', 'models/staging/x.txt': '', 'models/marts/x.txt': '' });
  model.open(emptyRoot);
  await page.setViewportSize({ width: 1000, height: 600 });
  fs.writeFileSync(htmlPath, html(DARK, 'panel'));
  await page.goto('file://' + htmlPath);
  await page.waitForSelector('.empty:not([hidden])');
  await shot('11-empty');
  answers.push('stg_orders', 'stg_customers', 'fct_orders');
  const v = await page.locator('#viewport').boundingBox();
  for (const [dx, dy] of [[260, 160], [260, 330], [620, 240]]) {
    await page.mouse.click(v.x + dx, v.y + dy, { button: 'right' });
    await page.locator('.menu-item', { hasText: 'Create new box' }).click();
    await page.waitForTimeout(120);
  }
  for (const from of ['stg_orders', 'stg_customers']) {
    const a = await box(from);
    const c = await box('fct_orders');
    await page.mouse.move(a.x + 40, a.y + 20);
    await page.mouse.move(a.x + a.width + 1, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(c.x + 50, c.y + 25, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(150);
  }
  await shot('12-empty-sketched');
  await page.mouse.click(v.x + 900, v.y + 500, { button: 'right' });
  await page.locator('.menu-item', { hasText: 'Create all files' }).click();
  await page.waitForTimeout(200);
  await shot('13-empty-created');
  const created = fs.readFileSync(path.join(emptyRoot, 'models/marts/fct_orders.sql'), 'utf8');

  await browser.close();
  console.log(log.filter((l) => !l.startsWith('-> {"type":"ready"')).join('\n'));
  console.log('\nundo removed fct_revenue.sql:', !afterUndo);
  console.log('redo fct_revenue.sql:\n' + afterRedo);
  console.log('dim_customers.sql (got ref to customer_segments? n/a) / customer_ltv:\n' +
    fs.readFileSync(path.join(root, 'models/marts/customer_ltv.sql'), 'utf8'));
  console.log('empty project fct_orders.sql:\n' + created);
  console.log('state file:\n' + fs.readFileSync(path.join(emptyRoot, '.dbtflow.json'), 'utf8').slice(0, 400));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

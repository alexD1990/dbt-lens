'use strict';
// Records the README pictures and GIFs from the real canvas (media/main.js) and the
// real FlowModel, inside a small editor-like frame (studio.html).
// Needs Playwright with Chromium, and ffmpeg for the GIFs.
//
//   node scripts/readme-media/record.js [scene ...]
//
// Writes to images/ next to the README. Scenes: hero, sketch, trace, run, lineage.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const REPO = path.join(__dirname, '..', '..');
const { FlowModel } = require(path.join(REPO, 'src', 'model'));
const { createNodeIO } = require(path.join(REPO, 'src', 'nodeio'));
const dbtrun = require(path.join(REPO, 'src', 'dbtrun'));
const { IntegrationHost } = require(path.join(REPO, 'src', 'host', 'integrationHost'));
const dagtracer = require(path.join(REPO, 'src', 'integrations', 'dagtracer'));
const { makeProject, renameFixture } = require('./project');

const OUT = path.join(REPO, 'images');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtflow-media-'));
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DARK = {
  '--vscode-font-family': '"Segoe UI", system-ui, -apple-system, sans-serif',
  '--vscode-font-size': '13px',
  '--vscode-editor-font-family': '"Cascadia Code", Consolas, "DejaVu Sans Mono", monospace',
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

function canvasHtml() {
  const vars = Object.entries(DARK).map(([k, v]) => `${k}:${v}`).join(';');
  const m = (p) => 'file://' + path.join(REPO, 'media', p);
  const file = path.join(WORK, 'canvas.html');
  fs.writeFileSync(file, `<!DOCTYPE html><html><head><meta charset="utf-8"><style>:root{${vars}}</style>
<link rel="stylesheet" href="${m('main.css')}"><link rel="stylesheet" href="${m('integrations/dagtracer.css')}"></head>
<body class="vscode-dark" data-surface="panel"><div id="app"></div>
<script>window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__toHost(m),getState:()=>null,setState:()=>{}});</script>
<script src="${m('integrations/dagtracer.js')}"></script>
<script src="${m('main.js')}"></script></body></html>`);
  return file;
}

// ------------------------------------------------------------------ a fake dgt

function fakeDgt() {
  const fix = (name) => renameFixture(fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'dagtracer', name), 'utf8'));
  return async (exe, args) => {
    const ok = (stdout) => ({ ok: true, code: 0, stdout, stderr: '', durationMs: 5, error: null });
    if (args[0] === '--version') return ok('dgt 0.1.0\n');
    await sleep(700);
    if (args[0] === 'int_store_targets') return ok(fix('dgt_prep2_region_both.json'));
    return ok(fix('dgt_mart_region.json'));
  };
}

// ------------------------------------------------------------------ the studio

class Studio {
  constructor(page, root) {
    this.page = page;
    this.root = root;
    this.model = new FlowModel(createNodeIO());
    this.model.open(root);
    this.model.syncFromFiles();
    this.answers = [];
    this.picks = [];
    this.cur = { x: 600, y: 400 };
    this.activeRel = null;
    this.fresh = null;
    this.speed = 1;
    this.integrations = new IntegrationHost({
      projectRoot: () => this.root,
      view: () => this.model.getView(),
      post: (msg) => this.toCanvas(msg),
      setting: () => undefined,
      logger: () => () => {},
      run: fakeDgt(),
      pick: (o) => this.quickPick(o),
      ask: (o) => this.askText(o),
    });
    this.integrations.register(dagtracer);
  }

  async load({ width = 1100, height = 640, layout = {}, open = null } = {}) {
    const page = this.page;
    await page.setViewportSize({ width, height });
    await page.exposeFunction('__toHost', (msg) => this.handle(msg).catch((e) => console.error('host', msg.type, e)));
    await this.integrations.start();
    await page.goto('file://' + path.join(__dirname, 'studio.html'));
    await page.evaluate((l) => window.studio.setLayout(l), layout);
    if (open) await this.openRel(open, false);
    await this.tree();
    await page.evaluate((src) => { document.getElementById('canvas').src = src; }, 'file://' + canvasHtml());
    this.frame = await (await page.waitForSelector('#canvas')).contentFrame();
    await this.frame.waitForSelector('.node');
    await sleep(300);
    // The legend opens on wide canvases; in a picture it only covers boxes.
    await this.frame.evaluate(() => { document.getElementById('legend').open = false; });
    await this.pointer(width * 0.55, height * 0.6);
  }

  toCanvas(msg) {
    if (!this.frame) this.frame = this.page.frames().find((f) => f.url().endsWith('canvas.html'));
    if (!this.frame) return;
    return this.frame.evaluate((m) => window.postMessage(m, '*'), msg).catch(() => {});
  }

  async graph() {
    await this.toCanvas({ type: 'graph', view: this.model.getView() });
    await this.toCanvas({ type: 'activeFile', id: this.activeId() });
  }

  activeId() {
    if (!this.activeRel) return null;
    for (const n of this.model.nodes.values()) if (n.rel === this.activeRel && n.kind === 'model') return n.id;
    return null;
  }

  async handle(msg) {
    const m = this.model;
    switch (msg.type) {
      case 'ready':
        await this.toCanvas({ type: 'dbtCommands', project: dbtrun.PROJECT_COMMANDS, box: dbtrun.BOX_COMMANDS });
        this.integrations.announce();
        break;
      case 'move': m.moveNode(msg.id, msg.x, msg.y); break;
      case 'tidy': m.tidy(); break;
      case 'undo': m.undo(); break;
      case 'redo': m.redo(); break;
      case 'setDirection': m.setDirection(msg.direction); await this.graph(); await this.toCanvas({ type: 'fit' }); return;
      case 'sync': { const r = m.syncFromFiles(); await this.graph(); await this.toCanvas({ type: 'synced', summary: r.summary }); return; }
      case 'connect': m.connect(msg.from, msg.to); break;
      case 'removeFromCanvas': m.removeFromCanvas(msg.id); break;
      case 'createBoxAt': {
        const name = await this.askText({ prompt: "Name of the new model (Press 'Enter' to confirm or 'Escape' to cancel)", placeHolder: 'e.g. stg_orders, int_orders_joined, fct_orders' });
        if (!name) break;
        const choices = m.folderChoices();
        const s = m.suggestFolder(name, choices);
        const ordered = [choices[s], ...choices.filter((_, i) => i !== s)];
        const label = await this.quickPick({
          placeHolder: `Where should ${name}.sql go?`,
          items: ordered.map((c, i) => ({ label: c.folder || c.modelDir, description: i === 0 ? 'suggested from the name' : `${c.modelDir}/${c.folder}` })),
        });
        const place = ordered.find((c) => (c.folder || c.modelDir) === label) || ordered[0];
        m.createBox(name, place, msg.x, msg.y);
        break;
      }
      case 'createFile': {
        const r = m.createFiles([msg.id]);
        if (r.ok) {
          await this.graph();
          await this.openId(msg.id, true);
        }
        break;
      }
      case 'open': await this.openId(msg.id, false); break;
      case 'dbt': await this.runDbt(msg.command, msg.id); return;
      default:
        if (typeof msg.type === 'string' && msg.type.includes('/')) {
          await this.integrations.handle(msg);
          return;
        }
    }
    await this.graph();
  }

  // ---------------------------------------------------------------- editor & explorer

  async tree() {
    const entries = [];
    const walk = (dir, depth) => {
      const kids = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.') && e.name !== 'target').sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of kids) {
        const abs = path.join(dir, e.name);
        const rel = path.relative(this.root, abs).split(path.sep).join('/');
        entries.push({ name: e.name, depth, dir: e.isDirectory(), rel });
        if (e.isDirectory()) walk(abs, depth + 1);
      }
    };
    walk(this.root, 0);
    await this.page.evaluate(([e, a, f]) => window.studio.setTree(e, a, f), [entries, this.activeRel, this.fresh]);
  }

  async openRel(rel, fresh) {
    this.activeRel = rel;
    this.fresh = fresh ? rel : null;
    const text = fs.readFileSync(path.join(this.root, rel), 'utf8');
    await this.page.evaluate(([r, t, f]) => window.studio.openFile(r, t, f), [rel, text, fresh]);
    await this.tree();
    if (this.frame) await this.toCanvas({ type: 'activeFile', id: this.activeId() });
  }

  async openId(id, fresh) {
    const n = this.model.nodes.get(id);
    if (n && n.rel) await this.openRel(n.rel, fresh);
  }

  async showEditor(on) {
    await this.page.evaluate((o) => document.getElementById('ed').classList.toggle('hidden', !o), on);
    await sleep(120);
    await this.toCanvas({ type: 'fit' });
  }

  // ---------------------------------------------------------------- quick input

  async askText({ prompt, placeHolder }) {
    const answer = this.answers.shift();
    await this.page.evaluate((o) => window.studio.qiShow(o), { prompt, placeholder: placeHolder });
    await sleep(500);
    for (let i = 1; i <= (answer || '').length; i++) {
      await this.page.evaluate((v) => window.studio.qiValue(v), answer.slice(0, i));
      await sleep(55 + Math.random() * 40);
    }
    await sleep(450);
    await this.page.evaluate(() => window.studio.qiHide());
    return answer;
  }

  async quickPick({ title, placeHolder, items, allowTyped = false }) {
    const want = this.picks.shift();
    await this.page.evaluate((o) => window.studio.qiShow(o), { title, placeholder: placeHolder, items });
    await this.page.evaluate(() => window.studio.qiSelect(0));
    await sleep(700);
    let idx = items.findIndex((it) => it.label === want);
    if (want && idx !== 0) {
      for (let i = 1; i <= want.length; i++) {
        await this.page.evaluate((v) => { window.studio.qiValue(v); window.studio.qiFilter(v); }, want.slice(0, i));
        await sleep(85);
      }
      if (idx < 0 && allowTyped) {
        // Like the real picker: a typed name that is not in the list becomes the first item.
        await this.page.evaluate(([o, v]) => { window.studio.qiShow(o); window.studio.qiValue(v); window.studio.qiSelect(0); },
          [{ title, placeholder: placeHolder, items: [{ label: want, description: 'not in the catalog' }] }, want]);
        await sleep(650);
        await this.page.evaluate(() => window.studio.qiHide());
        return want;
      }
      await this.page.evaluate((i) => window.studio.qiSelect(i), idx);
    }
    await sleep(550);
    await this.page.evaluate(() => window.studio.qiHide());
    return items[Math.max(0, idx)].label;
  }

  // ---------------------------------------------------------------- terminal

  async runDbt(command, id) {
    const node = id ? this.model.nodes.get(id) : null;
    const plan = dbtrun.planDbt({ command, node: node && { id: node.id, name: node.name, kind: node.kind } });
    if (!plan.ok) return;
    const p = this.page;
    await p.evaluate(() => window.studio.showPanel(true));
    if (!this.termStarted) {
      this.termStarted = true;
      await p.evaluate(() => { window.studio.termClear(); window.studio.termPrompt(); });
    }
    // Type into the prompt that is waiting at the bottom.
    const line = await p.evaluate(() => { const all = document.querySelectorAll('#term > div'); const el = all[all.length - 1]; el.id = 'cur-' + Date.now(); return el.id; });
    // dbt Flow sends the whole line at once, as if pasted.
    await sleep(250);
    await p.evaluate(([l, t]) => { const el = document.getElementById(l); window.studio.termType(el, t); window.studio.termDone(el); }, [line, plan.line]);
    await sleep(500);
    for (const [ms, html] of dbtOutput(command, this.selected(node))) {
      await sleep(ms);
      await p.evaluate((h) => window.studio.termAppend(h), html);
    }
    const last = await p.evaluate(() => { const el = window.studio.termPrompt(); return el.id = 'cur-end'; });
    void last;
  }

  /** The boxes dbt would run for a box: the box and everything upstream, in layer order. */
  selected(node) {
    const view = this.model.getView();
    const all = view.nodes;
    if (!node) return all.filter((n) => n.kind !== 'source');
    const up = new Set([node.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of view.edges) if (up.has(e.to) && !up.has(e.from)) { up.add(e.from); grew = true; }
    }
    return all.filter((n) => up.has(n.id) && n.kind !== 'source');
  }

  // ---------------------------------------------------------------- pointer

  async pointer(x, y) {
    this.cur = { x, y };
    await this.page.mouse.move(x, y);
    await this.page.evaluate(([a, b]) => window.studio.cursor(a, b), [x, y]);
  }

  async moveTo(x, y, ms = 550) {
    const from = { ...this.cur };
    const steps = Math.max(10, Math.round(ms / 22));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      await this.pointer(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
      await sleep(ms / steps);
    }
  }

  async click({ right = false, double = false } = {}) {
    const { x, y } = this.cur;
    await this.page.evaluate(([a, b, r]) => window.studio.ripple(a, b, r), [x, y, right]);
    if (double) await this.page.mouse.dblclick(x, y);
    else await this.page.mouse.click(x, y, { button: right ? 'right' : 'left' });
    await sleep(120);
  }

  async drag(x, y, ms = 900) {
    await this.page.mouse.down();
    await this.moveTo(x, y, ms);
    await sleep(120);
    await this.page.mouse.up();
  }

  /** Centre (or a point) of an element inside the canvas, in page coordinates. */
  async at(selector, fx = 0.5, fy = 0.5) {
    const b = await this.frame.locator(selector).first().boundingBox();
    if (!b) throw new Error('not on screen: ' + selector);
    return { x: b.x + b.width * fx, y: b.y + b.height * fy };
  }

  async box(id, fx = 0.35, fy = 0.5) { return this.at(`.node[data-id="${id}"]`, fx, fy); }

  async menuItem(text) {
    const loc = this.frame.locator('.menu-item', { hasText: text }).first();
    const b = await loc.boundingBox();
    return { x: b.x + Math.min(70, b.width / 3), y: b.y + b.height / 2 };
  }

  async go(p, ms) { await this.moveTo(p.x, p.y, ms); }

  async caption(html) { await this.page.evaluate((h) => window.studio.caption(h), html); }

  async captionAtTop() { await this.page.evaluate(() => { const c = document.getElementById('caption'); c.style.bottom = 'auto'; c.style.top = '78px'; }); }

  /** Zooms the canvas by about k around a page point, with the wheel like a user would. */
  async zoom(k, cx, cy) {
    const total = -Math.log(k) / 0.0015;
    const steps = 8;
    await this.page.mouse.move(cx, cy);
    for (let i = 0; i < steps; i++) {
      await this.page.mouse.wheel(0, total / steps);
      await sleep(25);
    }
    await this.page.mouse.move(this.cur.x, this.cur.y);
  }
}

// Realistic dbt output for a run, so the GIF shows what the terminal looks like.
function dbtOutput(command, nodes) {
  const verb = command.split(' ')[0];
  const clock = (() => { let s = 31; return () => `16:12:${String(s++ % 60).padStart(2, '0')}`; })();
  const dots = (text, width = 66) => `${text} ${'.'.repeat(Math.max(3, width - text.length))}`;
  const lines = [];
  const say = (ms, html) => lines.push([ms, `<span class="dim">${clock()}</span>  ${html}`]);
  const seeds = nodes.filter((n) => n.kind === 'seed');
  const models = nodes.filter((n) => n.kind === 'model');
  say(350, 'Running with dbt=1.12.6');
  say(250, 'Registered adapter: duckdb=1.10.0');
  say(150, `Found ${models.length} models, ${seeds.length} seeds, 1 source, 782 macros`);
  say(80, '');
  say(60, "Concurrency: 4 threads (target='dev')");
  say(60, '');
  const work = [...seeds, ...models];
  const total = work.length;
  let i = 0;
  const kindOf = (n) => (n.kind === 'seed' ? 'seed file' : n.materialized === 'table' || /^(fct|dim)_/.test(n.name) ? 'sql table model' : 'sql view model');
  const layers = [seeds, models.filter((n) => /^stg_/.test(n.name)), models.filter((n) => /^int_/.test(n.name)), models.filter((n) => /^(fct|dim)_/.test(n.name))];
  for (const layer of layers) {
    if (!layer.length) continue;
    const ids = layer.map((n) => [++i, n]);
    for (const [k, n] of ids) say(70, `${dots(`${k} of ${total} START ${kindOf(n)} dbt_dev.${n.name}`)} [RUN]`);
    for (const [k, n] of ids) {
      const done = n.kind === 'seed' ? `[<span class="ok">INSERT ${3 + (k % 5)}</span> in 0.${2 + (k % 6)}${k % 10}s]` : `[<span class="ok">OK</span> in 0.${1 + (k % 4)}${(k * 7) % 10}s]`;
      say(260, `${dots(`${k} of ${total} <span class="ok">OK</span> ${n.kind === 'seed' ? 'loaded' : 'created'} ${kindOf(n)} dbt_dev.${n.name}`, 87)} ${done}`);
    }
  }
  say(200, '');
  say(60, `Finished running ${seeds.length ? `${seeds.length} seeds, ` : ''}${models.length} models in 0 hours 0 minutes and 2.41 seconds (2.41s).`);
  say(60, '');
  say(60, '<span class="ok">Completed successfully</span>');
  say(60, '');
  say(60, `Done. PASS=${total} WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=${total}`);
  void verb;
  return lines;
}

// ------------------------------------------------------------------ recording

async function record(page, name, fn, { width = 1100, fps = 15 } = {}) {
  const dir = path.join(WORK, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    const file = path.join(dir, `f${String(frames.length).padStart(5, '0')}.png`);
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await sleep(400);
  await fn();
  await sleep(1600);
  // One more frame so the last state is held for its full time.
  await page.evaluate(() => { document.body.style.outline = '0px solid transparent'; });
  await sleep(200);
  await cdp.send('Page.stopScreencast');
  await sleep(200);
  const list = [];
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? frames[i + 1].t : frames[i].t + 1.8;
    list.push(`file '${frames[i].file}'`, `duration ${Math.max(0.01, next - frames[i].t).toFixed(3)}`);
  }
  list.push(`file '${frames.at(-1).file}'`);
  const listFile = path.join(dir, 'list.txt');
  fs.writeFileSync(listFile, list.join('\n'));
  const gif = path.join(OUT, `${name}.gif`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    '-loop', '0', gif]);
  const kb = Math.round(fs.statSync(gif).size / 1024);
  console.log(`${name}.gif  ${frames.length} frames  ${kb} KB`);
  return { dir, frames };
}

// ------------------------------------------------------------------ scenes

const SCENES = {
  async hero(browser) {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    const s = new Studio(page, makeProject(path.join(WORK, 'p-hero')));
    await s.load({ width: 1280, height: 700, layout: { sidebar: false, editor: true, edw: 370 }, open: 'models/intermediate/int_orders_enriched.sql' });
    await s.toCanvas({ type: 'fit' });
    await s.page.evaluate(() => window.studio.hideCursor(true));
    await sleep(700);
    await page.screenshot({ path: path.join(OUT, 'hero.png') });
    console.log('hero.png');
    await page.close();
  },

  async sketch(browser) {
    const page = await browser.newPage();
    const s = new Studio(page, makeProject(path.join(WORK, 'p-sketch'), { without: ['models/marts/dim_customers.sql'] }));
    await s.load({ width: 1100, height: 620, layout: { sidebar: false, editor: true, edw: 360 }, open: 'models/marts/fct_sales.sql' });
    await s.toCanvas({ type: 'fit' });
    await sleep(300);
    const z = await s.box('int_store_targets', 0.6, 0.5);
    await s.zoom(1.55, z.x + 60, z.y - 30);
    await sleep(400);
    await record(page, 'sketch', async () => {
      await s.caption('Right-click the canvas to sketch a new model');
      const a = await s.box('int_store_targets', 0.2, 0.5);
      const spot = { x: a.x + 20, y: a.y + 125 };
      await s.go(spot, 900);
      await sleep(250);
      await s.click({ right: true });
      await sleep(500);
      await s.go(await s.menuItem('Create new box'), 450);
      s.answers.push('dim_customers');
      s.picks.push('marts');
      await s.click();
      await s.frame.waitForSelector('.node[data-id="dim_customers"]', { timeout: 8000 });
      await sleep(500);
      await s.caption('Drag from a box\u2019s right-hand dot to connect it');
      for (const from of ['stg_customers', 'int_orders_enriched']) {
        await s.go(await s.at(`.node[data-id="${from}"] .port.out`), 750);
        await sleep(150);
        const to = await s.box('dim_customers', 0.5, 0.5);
        await s.drag(to.x, to.y, 900);
        await sleep(450);
      }
      await s.caption('<b>Create file</b> writes the SQL, one import CTE per upstream box');
      await s.go(await s.box('dim_customers', 0.5, 0.5), 500);
      await s.click({ right: true });
      await sleep(450);
      await s.go(await s.menuItem('Create file'), 400);
      await sleep(150);
      await s.click();
      await sleep(3000);
      await s.caption('');
      await sleep(400);
    });
    await page.close();
  },

  async trace(browser) {
    const page = await browser.newPage();
    const s = new Studio(page, makeProject(path.join(WORK, 'p-trace')));
    await s.load({ width: 1100, height: 620, layout: { sidebar: false, editor: false } });
    await s.toCanvas({ type: 'fit' });
    await sleep(400);
    await record(page, 'trace', async () => {
      await s.caption('Where does a column stop? Right-click a box → <b>Trace column…</b>');
      await s.go(await s.box('fct_sales', 0.4), 900);
      await s.click({ right: true });
      await sleep(450);
      await s.go(await s.menuItem('Trace column'), 450);
      s.picks.push('region');
      await s.click();
      await s.frame.waitForSelector('.dgt-btn', { timeout: 8000 });
      await sleep(900);
      await s.caption('Not in <b>fct_sales</b>, so follow it upstream');
      await s.go(await s.at('.dgt-btn'), 700);
      await s.click();
      await sleep(2600);
      await s.go({ x: 1020, y: 560 }, 700);
      await s.caption('✕ marks where <b>region</b> stops; green boxes still have it');
      await sleep(3000);
      await s.caption('');
    });
    await page.close();
  },

  async run(browser) {
    const page = await browser.newPage();
    const s = new Studio(page, makeProject(path.join(WORK, 'p-run')));
    await s.load({ width: 1100, height: 760, layout: { sidebar: false, editor: false, panel: true, ph: 230 } });
    await page.evaluate(() => { window.studio.termClear(); window.studio.termPrompt(); });
    s.termStarted = true;
    await s.captionAtTop();
    await s.toCanvas({ type: 'fit' });
    await sleep(400);
    await record(page, 'run', async () => {
      await s.caption('<b>\u25B6</b> in the tool bar runs dbt on the whole project');
      await s.go(await s.at('#btn-dbt'), 900);
      await s.click();
      await sleep(600);
      await s.go(await s.menuItem('dbt docs generate'), 700);
      await sleep(700);
      await s.frame.evaluate(() => { document.getElementById('menu').hidden = true; });
      await sleep(300);
      await s.caption('Right-click a box \u2192 <b>dbt build</b> runs it and everything upstream');
      await s.go(await s.box('int_orders_enriched', 0.4), 900);
      await s.click({ right: true });
      await sleep(500);
      await s.go(await s.menuItem('dbt build'), 450);
      await sleep(150);
      await s.click();
      await sleep(4300);
      await s.caption('');
    });
    await page.close();
  },

  async lineage(browser) {
    const page = await browser.newPage();
    const s = new Studio(page, makeProject(path.join(WORK, 'p-lineage')));
    await s.load({ width: 1100, height: 600, layout: { sidebar: false, editor: false } });
    await s.toCanvas({ type: 'fit' });
    await sleep(400);
    await record(page, 'lineage', async () => {
      await s.caption('Click a box to light up everything it depends on and everything it feeds');
      for (const id of ['int_store_targets', 'stg_customers', 'fct_sales']) {
        await s.go(await s.box(id), 800);
        await s.click();
        await sleep(1500);
      }
      await s.go({ x: 1000, y: 520 }, 600);
      await s.page.keyboard.press('Escape');
      await s.caption('');
      await sleep(500);
    });
    await page.close();
  },
};

(async () => {
  const wanted = process.argv.slice(2);
  const names = wanted.length ? wanted : Object.keys(SCENES);
  const browser = await chromium.launch();
  try {
    for (const n of names) {
      if (!SCENES[n]) throw new Error(`no scene ${n}`);
      await SCENES[n](browser);
    }
  } finally {
    await browser.close();
  }
  console.log('frames in', WORK);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

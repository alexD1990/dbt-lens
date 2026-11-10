'use strict';

/**
 * Loads optional integrations (DAGtracer, dataowl, ...) and keeps them apart
 * from the core canvas. See docs/ARCHITECTURE.md.
 *
 * Rules this file enforces:
 * - Every call into integration code is wrapped. An integration that throws,
 *   rejects or returns nonsense ends up in state 'failed'; nothing reaches
 *   the caller.
 * - Integrations get a small API (see makeApi). They can read the project
 *   root and a copy of the graph view, run tools, log, read their own settings
 *   and post messages to the canvas under their own prefix ("<id>/<type>").
 *   They cannot touch FlowModel, .dbtflow.json or undo history.
 * - No VS Code imports. Everything VS Code-specific comes in through `services`,
 *   so the host is tested with plain Node.
 */

const path = require('path');
const { runTool } = require('./runTool');

const INTEGRATIONS_DIR = path.join(__dirname, '..', 'integrations');
const ID_RE = /^[a-z][a-z0-9-]*$/;

/** disabled | checking | missing | incompatible | ready | failed */
const STATE = Object.freeze({
  DISABLED: 'disabled',
  CHECKING: 'checking',
  MISSING: 'missing',
  INCOMPATIBLE: 'incompatible',
  READY: 'ready',
  FAILED: 'failed',
});

class IntegrationHost {
  /**
   * services:
   *   projectRoot()            absolute path of the dbt project, or null
   *   view()                   current graph view (FlowModel.getView()), or null
   *   post(msg)                send a message to every canvas
   *   setting(id, key, dflt)   value of dbtFlow.integrations.<id>.<key>
   *   logger(id, title)        returns (line) => void, e.g. a VS Code output channel
   *   run                      optional replacement for runTool (tests)
   */
  constructor(services) {
    this.services = services;
    this.run = services.run || runTool;
    this.entries = new Map(); // id -> { id, title, mod, state, reason, version, handlers, log, busy }
  }

  /** Loads integrations by folder name from src/integrations. A broken module is recorded, not thrown. */
  load(names, dir = INTEGRATIONS_DIR) {
    for (const name of names) {
      let mod;
      try {
        mod = require(path.join(dir, name));
      } catch (e) {
        this.record(name, name, null, STATE.FAILED, `Could not load: ${e.message}`);
        continue;
      }
      this.register(mod, name);
    }
    return this;
  }

  register(mod, fallbackId = '?') {
    const problem = shapeProblem(mod);
    if (problem) {
      const id = mod && typeof mod.id === 'string' ? mod.id : fallbackId;
      this.record(id, id, null, STATE.FAILED, problem);
      return this;
    }
    this.record(mod.id, mod.title, mod, STATE.CHECKING, null);
    return this;
  }

  record(id, title, mod, state, reason) {
    const prev = this.entries.get(id);
    if (prev && prev.handlers && prev.handlers.dispose) this.call(prev, () => prev.handlers.dispose());
    this.entries.set(id, {
      id, title, mod, state, reason, version: null, handlers: null, busy: false,
      log: this.makeLogger(id, title),
    });
  }

  makeLogger(id, title) {
    try {
      const fn = this.services.logger && this.services.logger(id, title);
      return typeof fn === 'function' ? fn : () => {};
    } catch {
      return () => {};
    }
  }

  /** Checks every integration. Resolves when all checks are done; never rejects. */
  async start() {
    await Promise.all([...this.entries.keys()].map((id) => this.check(id)));
    this.announce();
    return this.status();
  }

  /** (Re)checks one integration: settings, detect(), then activate(). */
  async check(id) {
    const e = this.entries.get(id);
    if (!e || !e.mod) return;
    if (e.handlers) {
      if (e.handlers.dispose) this.call(e, () => e.handlers.dispose());
      e.handlers = null;
    }
    e.version = null;
    e.reason = null;
    if (this.setting(id, 'enabled', true) === false) {
      e.state = STATE.DISABLED;
      e.reason = `Turned off in settings (dbtFlow.integrations.${id}.enabled).`;
      e.log(e.reason);
      return;
    }
    e.state = STATE.CHECKING;
    const api = this.makeApi(e);
    const found = await this.callAsync(e, () => e.mod.detect(api));
    if (e.state === STATE.FAILED) return; // detect threw
    if (!found || found.ok !== true) {
      e.state = [STATE.MISSING, STATE.INCOMPATIBLE, STATE.FAILED].includes(found && found.state)
        ? found.state
        : STATE.FAILED;
      e.reason = (found && found.reason) || 'The check gave no answer.';
      e.log(`${e.state}: ${e.reason}`);
      return;
    }
    e.version = found.version || null;
    const handlers = this.call(e, () => e.mod.activate(api));
    if (e.state === STATE.FAILED) return; // activate threw
    if (!handlers || typeof handlers !== 'object' || typeof handlers.handlers !== 'object') {
      return this.fail(e, 'activate() did not return { handlers }.');
    }
    e.handlers = handlers;
    e.state = STATE.READY;
    e.log(`ready${e.version ? ` (version ${e.version})` : ''}`);
  }

  async recheck() {
    return this.start();
  }

  /**
   * Routes a canvas message "<id>/<action>" to its integration.
   * Returns true when the message had an integration prefix (handled or refused),
   * false when it is not an integration message. Never throws.
   */
  async handle(msg) {
    if (!msg || typeof msg.type !== 'string' || !msg.type.includes('/')) return false;
    const [id, action] = msg.type.split('/', 2);
    const e = this.entries.get(id);
    const refuse = (message) => {
      if (e) e.log(`refused ${action}: ${message}`);
      this.post({ type: `${id}/error`, action, message });
      return true;
    };
    if (!e) return refuse(`There is no integration called ${id}.`);
    if (e.state !== STATE.READY) return refuse(`${e.title} is not available: ${e.reason || e.state}.`);
    const fn = e.handlers.handlers[action];
    if (typeof fn !== 'function') return refuse(`${e.title} has no action ${action}.`);
    if (e.busy) return refuse(`${e.title} is still working on the previous request.`);
    e.busy = true;
    this.announce();
    try {
      await fn(msg);
    } catch (err) {
      e.log(`ERROR in ${action}: ${(err && err.stack) || err}`);
      this.post({ type: `${id}/error`, action, message: `${e.title} failed: ${(err && err.message) || err}` });
    } finally {
      e.busy = false;
      this.announce();
    }
    return true;
  }

  /** One line per integration, for the canvas and for "Check integrations". */
  status() {
    return [...this.entries.values()].map((e) => ({
      id: e.id, title: e.title, state: e.state, version: e.version, reason: e.reason, busy: e.busy,
    }));
  }

  isReady(id) {
    const e = this.entries.get(id);
    return !!e && e.state === STATE.READY;
  }

  announce() {
    this.post({ type: 'integrations', list: this.status() });
  }

  dispose() {
    for (const e of this.entries.values()) {
      if (e.handlers && e.handlers.dispose) this.call(e, () => e.handlers.dispose());
      e.handlers = null;
    }
  }

  // ---------------------------------------------------------------- internals

  makeApi(e) {
    const s = this.services;
    return Object.freeze({
      id: e.id,
      projectRoot: () => safeCall(() => s.projectRoot(), null),
      view: () => safeCall(() => JSON.parse(JSON.stringify(s.view())), null),
      post: (type, payload = {}) => this.post({ ...payload, type: `${e.id}/${type}` }),
      setting: (key, dflt) => this.setting(e.id, key, dflt),
      log: e.log,
      run: (command, args, opts = {}) => this.run(command, args, { ...opts, log: e.log }),
    });
  }

  setting(id, key, dflt) {
    const v = safeCall(() => this.services.setting(id, key, dflt), undefined);
    return v === undefined || v === null || v === '' ? dflt : v;
  }

  post(msg) {
    safeCall(() => this.services.post(msg));
  }

  fail(e, reason) {
    e.state = STATE.FAILED;
    e.reason = reason;
    e.handlers = null;
    e.log(`failed: ${reason}`);
  }

  call(e, fn) {
    try {
      return fn();
    } catch (err) {
      this.fail(e, (err && err.message) || String(err));
      return undefined;
    }
  }

  async callAsync(e, fn) {
    try {
      return await fn();
    } catch (err) {
      this.fail(e, (err && err.message) || String(err));
      return undefined;
    }
  }
}

function shapeProblem(mod) {
  if (!mod || typeof mod !== 'object') return 'The module does not export an integration object.';
  if (typeof mod.id !== 'string' || !ID_RE.test(mod.id)) return 'The integration has no valid id.';
  if (typeof mod.title !== 'string') return 'The integration has no title.';
  if (typeof mod.detect !== 'function') return 'The integration has no detect() function.';
  if (typeof mod.activate !== 'function') return 'The integration has no activate() function.';
  return null;
}

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

module.exports = { IntegrationHost, STATE, INTEGRATIONS_DIR };

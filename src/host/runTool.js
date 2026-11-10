'use strict';

/**
 * Runs an external tool (dgt, dataowl, dbt ...) as its own process.
 *
 * Never throws and never rejects. The result always has the same shape:
 *   { ok, code, stdout, stderr, durationMs, error }
 * where `error` is null or one of:
 *   'not_found'     the executable does not exist
 *   'spawn_failed'  it exists but could not be started
 *   'timeout'       it ran longer than timeoutMs and was stopped
 *   'cancelled'     the AbortSignal fired
 *   'too_large'     stdout grew past maxOutput and the process was stopped
 * `ok` is true only when the process exited with code 0 and no error.
 */

const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 20 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;

function runTool(command, args = [], opts = {}) {
  const {
    cwd,
    env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutput = DEFAULT_MAX_OUTPUT,
    signal,
    log = () => {},
  } = opts;
  const started = Date.now();
  log(`$ ${[command, ...args].map(quote).join(' ')}${cwd ? `   (in ${cwd})` : ''}`);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let error = null;
    let done = false;
    let child = null;
    let timer = null;
    let killTimer = null;

    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const durationMs = Date.now() - started;
      const result = { ok: !error && code === 0, code, stdout, stderr, durationMs, error };
      log(`  exit ${code === null ? '-' : code}${error ? ` (${error})` : ''} in ${durationMs} ms, stdout ${stdout.length} chars`);
      const tail = stderr.trim().split('\n').slice(-5).join('\n  ');
      if (tail) log(`  stderr: ${tail}`);
      resolve(result);
    };

    const stop = (reason) => {
      if (done || error) return;
      error = reason;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      // A process that ignores SIGTERM must not hang the caller.
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish(null);
      }, KILL_GRACE_MS);
    };
    const onAbort = () => stop('cancelled');

    if (signal && signal.aborted) {
      error = 'cancelled';
      return finish(null);
    }

    try {
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true });
    } catch (e) {
      error = 'spawn_failed';
      stderr = e.message;
      return finish(null);
    }

    child.on('error', (e) => {
      if (!error) error = e.code === 'ENOENT' ? 'not_found' : 'spawn_failed';
      stderr += e.message;
      finish(null);
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > maxOutput) stop('too_large');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxOutput) stderr += chunk;
    });
    child.on('close', (code) => finish(error ? null : code));

    timer = setTimeout(() => stop('timeout'), timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort);
  });
}

/** Parses stdout as JSON. Returns { ok: true, value } or { ok: false, message }. */
function parseJson(text) {
  if (!text || !text.trim()) return { ok: false, message: 'The tool wrote nothing to stdout.' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, message: `The tool did not write valid JSON (${e.message}).` };
  }
}

function quote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = { runTool, parseJson, DEFAULT_TIMEOUT_MS };

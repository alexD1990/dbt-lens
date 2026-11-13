'use strict';

/**
 * dbt commands run from the canvas, as plain lines in a terminal: the same thing
 * you would type yourself. The tool bar runs a command on the whole project; a
 * box's menu runs it on that box and everything upstream of it (`--select +mart`).
 *
 * Only the commands listed here can run. The canvas sends a command name and a
 * box id, never a command line; this file builds the line and quotes every part.
 * No VS Code imports, so it is tested on its own (test/dbtrun.test.js).
 */

/** Whole-project commands, in menu order. `hint` is shown next to the command. */
const PROJECT_COMMANDS = [
  { command: 'build', hint: 'seeds, models, snapshots, tests' },
  { command: 'run', hint: 'models' },
  { command: 'test', hint: 'data tests' },
  { command: 'seed', hint: 'load CSV seeds' },
  { command: 'snapshot', hint: 'snapshots' },
  { command: 'compile', hint: 'writes SQL to target/' },
  '-',
  { command: 'docs generate', hint: 'updates catalog.json' },
  { command: 'deps', hint: 'installs packages' },
  { command: 'debug', hint: 'checks the connection' },
];

/** Commands on a box's right-click menu, by box kind. Planned and red boxes get none. */
const BOX_COMMANDS = {
  model: ['build', 'run', 'test', 'compile'],
  snapshot: ['build', 'snapshot', 'test'],
  seed: ['build', 'seed', 'test'],
  source: ['test'],
};

/** Commands that do not take --target. */
const NO_TARGET = new Set(['deps']);

const KNOWN = new Set(PROJECT_COMMANDS.filter((c) => c !== '-').map((c) => c.command));

// A word the shell leaves alone. Anything else is single-quoted.
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./~-]+$/;

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** One shell word. A leading ~/ still points at the home folder when the rest needs quotes. */
function shellWord(value) {
  const s = String(value);
  if (s && SAFE_WORD.test(s) && !s.startsWith('-')) return s;
  if (s.startsWith('~/')) return `"$HOME"/${quote(s.slice(2))}`;
  return quote(s);
}

/**
 * The --select value for a box: the box and everything upstream of it, like
 * `dbt build --select +mart`. A seed has nothing upstream, so it is just its name;
 * a source is selected as source:<source>.<table> (its box id).
 * node: { id, name, kind }. Returns null for boxes dbt cannot run.
 */
function selectorFor(node) {
  if (!node || !BOX_COMMANDS[node.kind]) return null;
  if (node.kind === 'source') return /^source:[^.]+\..+/.test(String(node.id)) ? String(node.id) : null;
  const name = String(node.name || node.id || '');
  if (!name) return null;
  return node.kind === 'seed' ? name : `+${name}`;
}

/** Commands for a box's menu, or [] when dbt cannot run it. */
function boxCommands(node) {
  return selectorFor(node) ? BOX_COMMANDS[node.kind].slice() : [];
}

/**
 * The line to type into the terminal.
 * { command, node?, executable?, target? } → { ok: true, line, select } or { ok: false, message }.
 * node null = the whole project.
 */
function planDbt({ command, node = null, executable, target } = {}) {
  if (!KNOWN.has(command)) return { ok: false, message: `"${command}" is not a dbt command NodeViz runs.` };
  let select = null;
  if (node) {
    select = selectorFor(node);
    if (!select) return { ok: false, message: `dbt cannot run ${node.name || node.id}: it has no file yet.` };
    if (!BOX_COMMANDS[node.kind].includes(command)) {
      return { ok: false, message: `dbt ${command} does not apply to ${node.kind} ${node.name || node.id}.` };
    }
  }
  const exe = String(executable || '').trim() || 'dbt';
  const parts = [shellWord(exe), ...command.split(' ')];
  if (select) parts.push('--select', shellWord(select));
  const t = String(target || '').trim();
  if (t && !NO_TARGET.has(command)) parts.push('--target', shellWord(t));
  return { ok: true, line: parts.join(' '), select };
}

/**
 * Typed once when NodeViz opens its terminal: loads the env file (for example
 * the Databricks host and token) into that shell, the same as `source` by hand.
 * set -a exports plain KEY=VALUE lines too. Returns null without a file.
 */
function envFileLine(envFile) {
  const f = String(envFile || '').trim();
  return f ? `set -a; . ${shellWord(f)}; set +a` : null;
}

module.exports = { PROJECT_COMMANDS, BOX_COMMANDS, selectorFor, boxCommands, planDbt, envFileLine, shellWord };

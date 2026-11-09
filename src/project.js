'use strict';

const path = require('path');
const { parseModel, parseSnapshotBlocks, readPathList } = require('./parser');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', 'env', 'dbt_packages', 'dbt_modules',
  'target', 'logs', '__pycache__', '.idea', '.vscode',
]);

const toPosix = (p) => p.split(path.sep).join('/');

/**
 * Finds every dbt_project.yml under the given workspace roots (max depth 3).
 * Returns absolute project root paths, shallowest first.
 */
function findProjectRoots(workspaceRoots, io, maxDepth = 3) {
  const found = [];
  for (const wsRoot of workspaceRoots) {
    const queue = [{ dir: wsRoot, depth: 0 }];
    while (queue.length) {
      const { dir, depth } = queue.shift();
      if (io.exists(path.join(dir, 'dbt_project.yml'))) {
        found.push(dir);
        continue; // nested projects inside a project are packages, not roots
      }
      if (depth >= maxDepth) continue;
      for (const e of io.listDir(dir)) {
        if (e.isDir && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
          queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
        }
      }
    }
  }
  return found;
}

/**
 * Resolves a configured folder name against what is really on disk.
 * Forgiving about case and about "model" vs "models" (and "seed" vs "seeds").
 */
function resolveFolder(root, name, io) {
  const direct = path.join(root, name);
  if (io.isDir(direct)) return { rel: toPosix(name), abs: direct, exists: true };

  const lower = name.toLowerCase().replace(/\/+$/, '');
  const variants = new Set([lower]);
  if (lower.endsWith('s')) variants.add(lower.slice(0, -1));
  else variants.add(lower + 's');

  const parent = path.dirname(direct);
  const entries = io.listDir(parent).filter((e) => e.isDir);
  for (const v of variants) {
    const hit = entries.find((e) => e.name.toLowerCase() === path.basename(v));
    if (hit) {
      const abs = path.join(parent, hit.name);
      return { rel: toPosix(path.relative(root, abs)), abs, exists: true };
    }
  }
  return { rel: toPosix(name), abs: direct, exists: false };
}

function readConfig(root, io) {
  const ymlPath = path.join(root, 'dbt_project.yml');
  const yml = io.readText(ymlPath);
  const hasProject = yml !== null;
  const text = yml || '';
  const nameMatch = /^name\s*:\s*['"]?([\w-]+)/m.exec(text);
  const modelNames = readPathList(text, 'model-paths') || readPathList(text, 'source-paths') || ['models'];
  const seedNames = readPathList(text, 'seed-paths') || readPathList(text, 'data-paths') || ['seeds'];
  const snapshotNames = readPathList(text, 'snapshot-paths') || ['snapshots'];
  return {
    root,
    hasProject,
    projectName: nameMatch ? nameMatch[1] : path.basename(root),
    modelDirs: modelNames.map((n) => resolveFolder(root, n, io)),
    seedDirs: seedNames.map((n) => resolveFolder(root, n, io)),
    snapshotDirs: snapshotNames.map((n) => resolveFolder(root, n, io)),
  };
}

function walk(dir, io, onFile, onDir, relBase = '') {
  for (const e of io.listDir(dir)) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    const rel = relBase ? relBase + '/' + e.name : e.name;
    if (e.isDir) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (onDir) onDir(rel);
      walk(abs, io, onFile, onDir, rel);
    } else {
      onFile(abs, rel, e.name);
    }
  }
}

/** Scans models, seeds and snapshots. Pure apart from io reads. */
function scanProject(cfg, io) {
  const models = new Map();
  const duplicates = [];
  const folders = new Set();

  for (const md of cfg.modelDirs) {
    if (!md.exists) continue;
    walk(md.abs, io, (abs, rel, name) => {
      const ext = path.extname(name).toLowerCase();
      if (ext !== '.sql' && ext !== '.py') return;
      const modelName = name.slice(0, -ext.length);
      const text = io.readText(abs) || '';
      const parsed = parseModel(text, ext === '.py');
      const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      const entry = {
        name: modelName,
        kind: 'model',
        abs,
        rel: toPosix(path.relative(cfg.root, abs)),
        modelDir: md.rel,
        folder,
        group: folder ? folder.split('/')[0] : '',
        language: ext === '.py' ? 'python' : 'sql',
        ...parsed,
      };
      if (models.has(modelName)) duplicates.push(entry.rel);
      else models.set(modelName, entry);
    }, (relDir) => folders.add(md.rel + '\u0000' + relDir));
  }

  const seeds = new Map();
  for (const sd of cfg.seedDirs) {
    if (!sd.exists) continue;
    walk(sd.abs, io, (abs, rel, name) => {
      if (!name.toLowerCase().endsWith('.csv')) return;
      const seedName = name.slice(0, -4);
      if (!seeds.has(seedName)) {
        seeds.set(seedName, { name: seedName, kind: 'seed', abs, rel: toPosix(path.relative(cfg.root, abs)) });
      }
    });
  }

  const snapshots = new Map();
  for (const sd of cfg.snapshotDirs) {
    if (!sd.exists) continue;
    walk(sd.abs, io, (abs, rel, name) => {
      if (!name.toLowerCase().endsWith('.sql')) return;
      for (const block of parseSnapshotBlocks(io.readText(abs) || '')) {
        if (!snapshots.has(block.name)) {
          snapshots.set(block.name, {
            ...block, kind: 'snapshot', abs, rel: toPosix(path.relative(cfg.root, abs)),
          });
        }
      }
    });
  }

  const folderList = [...folders].sort().map((key) => {
    const [modelDir, folder] = key.split('\u0000');
    return { modelDir, folder };
  });
  return { models, seeds, snapshots, duplicates, folders: folderList };
}

module.exports = { findProjectRoots, resolveFolder, readConfig, scanProject, toPosix };

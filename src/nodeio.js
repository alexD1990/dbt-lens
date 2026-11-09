'use strict';

const fs = require('fs');
const path = require('path');

/** File access for FlowModel backed by Node's fs. `isDirty` is supplied by the caller. */
function createNodeIO(isDirty = () => false) {
  return {
    exists: (p) => fs.existsSync(p),
    isDir: (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    readText: (p) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    listDir: (p) => {
      try {
        return fs.readdirSync(p, { withFileTypes: true }).map((d) => ({
          name: d.name,
          isDir: d.isDirectory() || (d.isSymbolicLink() && safeIsDir(path.join(p, d.name))),
        }));
      } catch {
        return [];
      }
    },
    writeText: (p, text) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text, 'utf8');
    },
    remove: (p) => {
      try {
        fs.unlinkSync(p);
      } catch {
        /* already gone */
      }
    },
    isDirty,
  };
}

function safeIsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

module.exports = { createNodeIO };

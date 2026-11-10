'use strict';

/**
 * Reads the columns of one box from dbt's target/catalog.json, so the user can
 * pick a column instead of typing it. Only used for suggestions: whether a
 * column is in a box is always decided by dgt.
 */

const fs = require('fs');
const path = require('path');
const { canvasIdOfUid } = require('./idmap');

/** [{ name, type }] in column order, or null when the catalog or the box is not there. */
function columnsFor(root, boxId) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(root, 'target', 'catalog.json'), 'utf8'));
  } catch {
    return null;
  }
  for (const group of [doc && doc.nodes, doc && doc.sources]) {
    if (!group || typeof group !== 'object') continue;
    for (const [uid, entry] of Object.entries(group)) {
      if (canvasIdOfUid(uid) !== boxId || !entry || typeof entry.columns !== 'object') continue;
      return Object.values(entry.columns)
        .filter((c) => c && typeof c.name === 'string')
        .sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0))
        .map((c) => ({ name: c.name, type: c.type == null ? null : String(c.type) }));
    }
  }
  return null;
}

module.exports = { columnsFor };

'use strict';

/** Parses tool stdout as JSON. Returns { ok: true, value } or { ok: false, message }. */
function parseJson(text) {
  if (!text || !String(text).trim()) return { ok: false, message: 'dgt wrote nothing to stdout.' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, message: `dgt did not write valid JSON (${e.message}).` };
  }
}

module.exports = { parseJson };

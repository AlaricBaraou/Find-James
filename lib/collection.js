'use strict';

// Generic JSON-file backed collection with atomic writes. Low write volume, so
// the whole collection lives in memory and is flushed on every change.

const fs = require('fs');
const path = require('path');

function collection(dir, name) {
  const FILE = path.join(dir, name + '.json');
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(cache)) cache = [];
  } catch (_) {
    cache = [];
  }

  function persist() {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, FILE);
  }

  return {
    all: () => cache.slice(),
    find: (fn) => cache.find(fn) || null,
    filter: (fn) => cache.filter(fn),
    get: (id) => cache.find((x) => x.id === id) || null,
    add: (rec) => { cache.push(rec); persist(); return rec; },
    update: (id, patch) => {
      const x = cache.find((c) => c.id === id);
      if (!x) return null;
      Object.assign(x, patch);
      persist();
      return x;
    },
    remove: (id) => {
      const n = cache.length;
      cache = cache.filter((c) => c.id !== id);
      if (cache.length !== n) persist();
    },
  };
}

module.exports = { collection };

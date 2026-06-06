'use strict';

// Tiny JSON-file backed store for track metadata.
// Low write volume (search coordination), so we keep the whole list in memory
// and write it atomically (temp file + rename) on every change.

const fs = require('fs');
const path = require('path');

let FILE = null;
let cache = [];

function init(dataDir) {
  FILE = path.join(dataDir, 'tracks.json');
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(cache)) cache = [];
  } catch (_) {
    cache = [];
  }
}

function persist() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE);
}

function list() {
  // Newest first.
  return cache.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function get(id) {
  return cache.find((t) => t.id === id) || null;
}

function add(rec) {
  cache.push(rec);
  persist();
}

function remove(id) {
  const before = cache.length;
  cache = cache.filter((t) => t.id !== id);
  if (cache.length !== before) persist();
}

module.exports = { init, list, get, add, remove };

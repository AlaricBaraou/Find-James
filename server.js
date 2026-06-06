'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const store = require('./lib/store');

// ---- Config (all via env, with safe defaults) -----------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const GPX_DIR = path.join(DATA_DIR, 'gpx');
const MAX_FILE_BYTES = parseInt(process.env.MAX_FILE_BYTES || '10485760', 10); // 10 MB

// Optional gate for uploads. If set, uploaders must supply this passphrase.
// Leave unset for fully-open uploads.
const UPLOAD_PASSPHRASE = process.env.UPLOAD_PASSPHRASE || '';

// Required to delete entries. If unset, deletion is disabled entirely.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

fs.mkdirSync(GPX_DIR, { recursive: true });
store.init(DATA_DIR);

// ---- App ------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // correct client IPs behind a host's proxy (rate limiting)

// We load Leaflet + GSI tiles from CDNs, so we relax CSP rather than enumerate
// every origin. Other helmet protections stay on.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '64kb' }));

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

function looksLikeGpx(buf) {
  const head = buf.slice(0, 4000).toString('utf8').toLowerCase();
  return head.includes('<gpx');
}

function clampStr(v, n) {
  return String(v == null ? '' : v).slice(0, n);
}

// ---- API ------------------------------------------------------------------

// Public config for the frontend (does not leak secrets).
app.get('/api/config', (req, res) => {
  res.json({
    uploadGated: Boolean(UPLOAD_PASSPHRASE),
    maxFileBytes: MAX_FILE_BYTES,
  });
});

app.get('/api/tracks', (req, res) => {
  res.json(store.list());
});

app.get('/api/tracks/:id/gpx', (req, res) => {
  const t = store.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const fp = path.join(GPX_DIR, t.file);
  if (!fp.startsWith(GPX_DIR) || !fs.existsSync(fp)) {
    return res.status(404).json({ error: 'file missing' });
  }
  res.type('application/gpx+xml').sendFile(fp);
});

app.post('/api/tracks', uploadLimiter, upload.single('gpx'), (req, res) => {
  if (UPLOAD_PASSPHRASE) {
    const provided = req.get('x-upload-passphrase') || req.body.passphrase || '';
    if (provided !== UPLOAD_PASSPHRASE) {
      return res.status(401).json({ error: 'Invalid upload passphrase.' });
    }
  }
  if (!req.file) return res.status(400).json({ error: 'No GPX file was uploaded.' });
  if (!looksLikeGpx(req.file.buffer)) {
    return res.status(400).json({ error: 'That does not look like a GPX file.' });
  }

  const id = crypto.randomUUID();
  const file = id + '.gpx';
  fs.writeFileSync(path.join(GPX_DIR, file), req.file.buffer);

  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : null;
  const rec = {
    id,
    file,
    name: clampStr(req.body.name, 120) || 'Untitled track',
    date: clampStr(req.body.date, 40),
    uploader: clampStr(req.body.uploader, 80),
    notes: clampStr(req.body.notes, 1000),
    color,
    createdAt: new Date().toISOString(),
  };
  store.add(rec);
  res.status(201).json(rec);
});

app.delete('/api/tracks/:id', (req, res) => {
  if (!ADMIN_TOKEN || req.get('x-admin-token') !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const t = store.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  try {
    fs.unlinkSync(path.join(GPX_DIR, t.file));
  } catch (_) {
    /* file may already be gone */
  }
  store.remove(req.params.id);
  res.json({ ok: true });
});

// ---- Static frontend ------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ---- Error handling (e.g. file too large) ---------------------------------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'File too large (max ' + Math.round(MAX_FILE_BYTES / 1048576) + ' MB).',
      });
    }
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => {
  console.log('Find James search map listening on http://localhost:' + PORT);
  console.log('  uploads:', UPLOAD_PASSPHRASE ? 'gated (passphrase set)' : 'OPEN');
  console.log('  deletion:', ADMIN_TOKEN ? 'enabled (admin token set)' : 'disabled');
});

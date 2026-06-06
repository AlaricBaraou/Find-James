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

// Default map framing for the search area. Override at deploy time — no code
// change needed. Defaults to central Kyoto until the real area is set.
const SEARCH_LAT = parseFloat(process.env.SEARCH_LAT || '35.0116');
const SEARCH_LON = parseFloat(process.env.SEARCH_LON || '135.7681');
const SEARCH_ZOOM = parseInt(process.env.SEARCH_ZOOM || '12', 10);
const SEARCH_AREA_NAME = process.env.SEARCH_AREA_NAME || '';

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

function isAdmin(req) {
  return Boolean(ADMIN_TOKEN) && req.get('x-admin-token') === ADMIN_TOKEN;
}

function isTrue(v) {
  return v === 'true' || v === '1' || v === true;
}

// ---- API ------------------------------------------------------------------

// Public config for the frontend (does not leak secrets).
app.get('/api/config', (req, res) => {
  res.json({
    uploadGated: Boolean(UPLOAD_PASSPHRASE),
    maxFileBytes: MAX_FILE_BYTES,
    search: {
      lat: SEARCH_LAT,
      lon: SEARCH_LON,
      zoom: SEARCH_ZOOM,
      name: SEARCH_AREA_NAME,
    },
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
  const kind = req.body.kind === 'planned' ? 'planned' : 'searched';
  const rec = {
    id,
    file,
    kind,
    name: clampStr(req.body.name, 120) || 'Untitled track',
    date: clampStr(req.body.date, 40),
    uploader: clampStr(req.body.uploader, 80),
    notes: clampStr(req.body.notes, 1000),
    color,
    createdAt: new Date().toISOString(),
  };
  if (kind === 'planned') {
    rec.status = 'open'; // open -> claimed -> completed
    rec.claimedBy = '';
    rec.claimedAt = '';
    // Only admins can mark a planned route as officially "recommended".
    rec.recommended = isAdmin(req) && isTrue(req.body.recommended);
  }
  store.add(rec);
  res.status(201).json(rec);
});

// ---- Planned-route lifecycle (claim / release / complete) -----------------
// Open by design: volunteers identify themselves by name, mirroring open uploads.
function plannedOnly(req, res) {
  const t = store.get(req.params.id);
  if (!t || t.kind !== 'planned') {
    res.status(404).json({ error: 'planned route not found' });
    return null;
  }
  return t;
}

app.post('/api/tracks/:id/claim', (req, res) => {
  const t = plannedOnly(req, res);
  if (!t) return;
  if (t.status === 'claimed') {
    return res.status(409).json({ error: 'Already claimed by ' + (t.claimedBy || 'someone') + '.' });
  }
  const by = clampStr(req.body.by, 80);
  if (!by) return res.status(400).json({ error: 'Please provide a name.' });
  res.json(store.update(t.id, { status: 'claimed', claimedBy: by, claimedAt: new Date().toISOString() }));
});

app.post('/api/tracks/:id/release', (req, res) => {
  const t = plannedOnly(req, res);
  if (!t) return;
  res.json(store.update(t.id, { status: 'open', claimedBy: '', claimedAt: '' }));
});

app.post('/api/tracks/:id/complete', (req, res) => {
  const t = plannedOnly(req, res);
  if (!t) return;
  const by = clampStr(req.body.by, 80) || t.claimedBy;
  res.json(store.update(t.id, { status: 'completed', completedBy: by, completedAt: new Date().toISOString() }));
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

// ---- GSI tile / DEM proxy --------------------------------------------------
// GSI tiles don't send CORS headers, which taints WebGL/canvas textures in the
// 3D viewer and blocks fetch() of DEM tiles. Proxying them same-origin fixes
// both. Only used by the 3D view; 2D Leaflet loads GSI directly.
const GSI_LAYERS = {
  std: 'png',
  pale: 'png',
  relief: 'png',
  seamlessphoto: 'jpg',
  dem: 'txt', // DEM10B elevation, z<=14
  dem5a: 'txt', // 5m mesh, z<=15 (limited coverage)
};

app.get('/api/gsi/:layer/:z/:x/:y', async (req, res) => {
  const { layer, z, x, y } = req.params;
  const ext = GSI_LAYERS[layer];
  if (!ext) return res.status(400).json({ error: 'unknown layer' });
  if (![z, x, y].every((n) => /^\d+$/.test(n))) {
    return res.status(400).json({ error: 'bad tile coords' });
  }
  const url = `https://cyberjapandata.gsi.go.jp/xyz/${layer}/${z}/${x}/${y}.${ext}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).end();
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=604800');
    res.type(ext === 'txt' ? 'text/plain' : ext === 'jpg' ? 'image/jpeg' : 'image/png');
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: 'tile fetch failed' });
  }
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

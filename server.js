'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { DOMParser } = require('@xmldom/xmldom');
const togeojson = require('@tmcw/togeojson');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const store = require('./lib/store');
const { collection } = require('./lib/collection');
const { setupAuth } = require('./lib/auth');

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
const SEARCH_LAT = parseFloat(process.env.SEARCH_LAT || '35.055'); // Mt. Hiei ridge
const SEARCH_LON = parseFloat(process.env.SEARCH_LON || '135.82');
const SEARCH_ZOOM = parseInt(process.env.SEARCH_ZOOM || '12', 10);
const SEARCH_AREA_NAME = process.env.SEARCH_AREA_NAME || '比叡山周辺 / Mt. Hiei area';

// Optional anonymous group-chat link (e.g. a LINE OpenChat) for real-time
// coordination. Surfaced in the UI when set.
const GROUP_CHAT_URL = process.env.GROUP_CHAT_URL || '';

fs.mkdirSync(GPX_DIR, { recursive: true });
store.init(DATA_DIR);
const messages = collection(DATA_DIR, 'messages');

// ---- App ------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // correct client IPs behind a host's proxy (rate limiting)

// We load Leaflet + GSI tiles from CDNs, so we relax CSP rather than enumerate
// every origin. Other helmet protections stay on.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

// Passwordless magic-link auth (no-op until SMTP is configured).
const auth = setupAuth(app, { dataDir: DATA_DIR });

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// Bound the bandwidth-heavy endpoints per IP so traffic can't run up the bill.
// Generous enough for real use: a single 3D view pulls ~40-60 tiles.
const tileLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 2000, standardHeaders: true, legacyHeaders: false });
const readLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });

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

// Format an ISO timestamp as a YYYY-MM-DD date in Japan time (the searches are
// in Japan; GPX times are usually UTC, so the local date can differ by a day).
function jstDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(d);
  } catch (_) {
    return iso.slice(0, 10);
  }
}

// Parse a GPX buffer with @tmcw/togeojson and return the first track timestamp
// as a JST date. We deliberately do NOT read the GPX <name>, which can carry the
// uploader's activity title / handle (personal info). Returns '' if no time.
function extractGpxDate(buf) {
  try {
    const dom = new DOMParser({ onError: () => {} }).parseFromString(buf.toString('utf8'), 'text/xml');
    const geo = togeojson.gpx(dom);
    for (const f of geo.features || []) {
      const p = f.properties || {};
      let time = '';
      if (p.time) time = p.time;
      else if (p.coordinateProperties && p.coordinateProperties.times) {
        const flat = [p.coordinateProperties.times].flat(Infinity).filter(Boolean);
        if (flat.length) time = flat[0];
      }
      if (time) return jstDate(time);
    }
  } catch (_) {}
  return '';
}

// ---- API ------------------------------------------------------------------

// Health check for the hosting platform.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Public config for the frontend (does not leak secrets).
app.get('/api/config', (req, res) => {
  res.json({
    uploadGated: Boolean(UPLOAD_PASSPHRASE),
    maxFileBytes: MAX_FILE_BYTES,
    authEnabled: auth.enabled,
    groupChatUrl: GROUP_CHAT_URL,
    search: {
      lat: SEARCH_LAT,
      lon: SEARCH_LON,
      zoom: SEARCH_ZOOM,
      name: SEARCH_AREA_NAME,
    },
  });
});

app.get('/api/tracks', (req, res) => {
  const admin = isAdmin(req);
  res.json(store.list().map((t) => publicTrack(t, admin)));
});

app.get('/api/tracks/:id/gpx', readLimiter, (req, res) => {
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

  // Trust the GPX for the date only. The GPX name is intentionally ignored to
  // avoid leaking the uploader's info; the label is a neutral one + the date.
  const createdAt = new Date().toISOString();
  const date = extractGpxDate(req.file.buffer) || jstDate(createdAt);
  const kind = req.body.kind === 'planned' ? 'planned' : 'searched';
  // category drives the colour: searcher = red, other (found online) = blue.
  const category = req.body.category === 'other' ? 'other' : 'searcher';
  const rec = {
    id,
    file,
    kind,
    category,
    name: category === 'other' ? 'その他 / Other' : '捜索 / Search',
    date,
    email: clampStr(req.body.email, 120),
    notes: clampStr(req.body.notes, 1000),
    color: null, // colour is decided client-side by our colour code
    createdAt,
  };
  // Attach a verified owner when the uploader is signed in (enables contact).
  const owner = auth.getUser(req);
  if (owner) rec.ownerId = owner.id;
  if (kind === 'planned') {
    rec.status = 'open'; // open -> claimed -> completed
    rec.claimedBy = '';
    rec.claimedAt = '';
    // Only admins can mark a planned route as officially "recommended".
    rec.recommended = isAdmin(req) && isTrue(req.body.recommended);
  }
  store.add(rec);
  res.status(201).json(publicTrack(rec, true));
});

// Strip internal fields before sending tracks to clients. Email is only
// included for admin requests (so it isn't scraped from the public list).
function publicTrack(t, includeEmail) {
  const { ownerId, claimedById, email, ...rest } = t;
  const out = { ...rest, contactable: Boolean(ownerId || claimedById) };
  if (includeEmail && email) out.email = email;
  return out;
}

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
  const u = auth.getUser(req);
  const by = clampStr(req.body.by, 80) || (u && u.nickname);
  if (!by) return res.status(400).json({ error: 'Please provide a name.' });
  const patch = { status: 'claimed', claimedBy: by, claimedAt: new Date().toISOString() };
  if (u) patch.claimedById = u.id;
  res.json(publicTrack(store.update(t.id, patch)));
});

app.post('/api/tracks/:id/release', (req, res) => {
  const t = plannedOnly(req, res);
  if (!t) return;
  res.json(publicTrack(store.update(t.id, { status: 'open', claimedBy: '', claimedAt: '', claimedById: '' })));
});

app.post('/api/tracks/:id/complete', (req, res) => {
  const t = plannedOnly(req, res);
  if (!t) return;
  const u = auth.getUser(req);
  const by = clampStr(req.body.by, 80) || (u && u.nickname) || t.claimedBy;
  res.json(publicTrack(store.update(t.id, { status: 'completed', completedBy: by, completedAt: new Date().toISOString() })));
});

// ---- Per-route message threads (contact / team up) ------------------------
const msgLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

function baseUrl(req) {
  const pub = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  return pub || req.protocol + '://' + req.get('host');
}

app.get('/api/tracks/:id/messages', auth.requireUser, (req, res) => {
  const t = store.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const thread = messages
    .filter((m) => m.trackId === t.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .map((m) => ({ id: m.id, fromNick: m.fromNick, body: m.body, createdAt: m.createdAt, mine: m.fromId === req.user.id }));
  res.json({ track: { id: t.id, name: t.name }, messages: thread });
});

app.post('/api/tracks/:id/messages', msgLimiter, auth.requireUser, async (req, res) => {
  const t = store.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const body = clampStr(req.body && req.body.body, 1000).trim();
  if (!body) return res.status(400).json({ error: 'Empty message.' });

  const msg = messages.add({
    id: crypto.randomUUID(),
    trackId: t.id,
    fromId: req.user.id,
    fromNick: req.user.nickname || 'someone',
    body,
    createdAt: new Date().toISOString(),
  });

  // Email nudge to the route's owner/claimer (no addresses or message body
  // exposed to anyone). Best-effort; never block the request.
  const stakeholders = new Set([t.ownerId, t.claimedById].filter(Boolean));
  stakeholders.delete(req.user.id);
  for (const uid of stakeholders) {
    const u = auth.users.get(uid);
    if (!u || !u.email) continue;
    auth
      .sendMail(
        u.email,
        '新しいメッセージ / New message — 捜索マップ',
        (req.user.nickname || 'A volunteer') + ' さんがルート「' + t.name + '」にメッセージを送りました。\n' +
          'A volunteer messaged you about route "' + t.name + '".\n\n' +
          'ログインして確認 / Sign in to read:\n' + baseUrl(req) + '/\n'
      )
      .catch(() => {});
  }
  res.status(201).json({ id: msg.id, fromNick: msg.fromNick, body: msg.body, createdAt: msg.createdAt, mine: true });
});

app.get('/api/inbox', auth.requireUser, (req, res) => {
  const me = req.user.id;
  const myTrackIds = new Set(store.list().filter((t) => t.ownerId === me || t.claimedById === me).map((t) => t.id));
  messages.filter((m) => m.fromId === me).forEach((m) => myTrackIds.add(m.trackId));
  const threads = [];
  for (const tid of myTrackIds) {
    const t = store.get(tid);
    if (!t) continue;
    const thread = messages.filter((m) => m.trackId === tid).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    if (!thread.length) continue;
    const last = thread[thread.length - 1];
    threads.push({ trackId: tid, name: t.name, count: thread.length, lastBody: last.body, lastAt: last.createdAt, lastNick: last.fromNick });
  }
  threads.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  res.json({ threads });
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

app.get('/api/gsi/:layer/:z/:x/:y', tileLimiter, async (req, res) => {
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
// no-cache = browsers may store but must revalidate (cheap 304s), so a normal
// reload always picks up the latest HTML/JS/CSS during active development.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

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

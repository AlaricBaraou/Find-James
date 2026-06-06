'use strict';

// ===========================================================================
// Upload + display only. Base maps: GSI (Geospatial Information Authority of
// Japan) tiles. Tracks are uploaded as GPX and drawn on the map.
// ===========================================================================
const ATTR =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル GSI Japan</a>';

const TILES = [
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', name: '標準 Standard', max: 18 },
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', name: '淡色 Pale', max: 18 },
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/relief/{z}/{x}/{y}.png', name: '色別標高 Relief', max: 15 },
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', name: '写真 Satellite', max: 18 },
];

// Our colour code. For now every track is red; later we can branch by
// status/age/team here in one place.
const TRACK_COLORS = { default: '#e60026' };
function colorFor(t) { return (t && t.color) || TRACK_COLORS.default; }

const map = L.map('map', { zoomControl: true }).setView([35.055, 135.82], 12); // Mt. Hiei

const baseLayers = {};
TILES.forEach((t, i) => {
  const layer = L.tileLayer(t.url, { maxZoom: 18, maxNativeZoom: t.max, attribution: ATTR });
  baseLayers[t.name] = layer;
  if (i === 0) layer.addTo(map);
});
L.control.layers(baseLayers, {}, { collapsed: true, position: 'topright' }).addTo(map);

const group = L.featureGroup().addTo(map);
let fitPending = true;

// Admin mode (delete buttons) via URL hash: #admin=YOUR_TOKEN
let adminToken = null;
(function () {
  const m = (location.hash || '').match(/admin=([^&]+)/);
  if (m) adminToken = decodeURIComponent(m[1]);
})();

// ---- Helpers --------------------------------------------------------------
function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) Object.assign(node, props);
  (children || []).forEach((c) =>
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
  );
  return node;
}

function buildPopup(t) {
  const wrap = el('div', {}, []);
  wrap.appendChild(el('div', { className: 'pname' }, [t.name || 'Untitled']));
  if (t.date) wrap.appendChild(el('div', { className: 'pmeta' }, [t.date]));
  if (t.notes) wrap.appendChild(el('div', {}, [t.notes]));
  // Email is only present in admin mode (#admin=...).
  if (t.email) {
    wrap.appendChild(el('div', { className: 'pmeta' }, [
      '✉ ', el('a', { href: 'mailto:' + t.email }, [t.email]),
    ]));
  }
  return wrap;
}

function makeGpxLayer(t, color) {
  const gpx = new L.GPX('/api/tracks/' + t.id + '/gpx', {
    async: true,
    polyline_options: { color: color, weight: 4, opacity: 0.75 },
    marker_options: { startIconUrl: '', endIconUrl: '', shadowUrl: '' },
  });
  gpx.bindPopup(buildPopup(t));
  gpx.on('loaded', () => {
    gpx.addTo(group);
    if (fitPending) {
      try { map.fitBounds(group.getBounds().pad(0.15)); } catch (_) {}
    }
  });
  return gpx;
}

function listItem(t, color, gpxLayer) {
  const cb = el('input', { type: 'checkbox', checked: true });
  cb.addEventListener('change', () => {
    if (cb.checked) gpxLayer.addTo(group);
    else group.removeLayer(gpxLayer);
  });

  const dot = el('span', { className: 'dot' });
  dot.style.background = color;

  const name = el('span', { className: 'name' }, [t.name || 'Untitled']);
  const sub = el('span', { className: 'date' }, [t.date || '']);
  const meta = el('div', { className: 'meta' }, [name, sub]);
  meta.addEventListener('click', () => {
    try { map.fitBounds(gpxLayer.getBounds().pad(0.2)); } catch (_) {}
  });

  const item = el('li', { className: 'track-item' }, [cb, dot, meta]);

  if (adminToken) {
    const del = el('button', { className: 'del', title: 'Delete', textContent: '✕' });
    del.addEventListener('click', async () => {
      if (!confirm('Delete "' + (t.name || 'this track') + '"?')) return;
      const res = await fetch('/api/tracks/' + t.id, { method: 'DELETE', headers: { 'x-admin-token': adminToken } });
      if (res.ok) { group.removeLayer(gpxLayer); loadTracks(); }
      else alert('Delete failed (' + res.status + ')');
    });
    item.appendChild(del);
  }
  return item;
}

function addTrack(t) {
  const color = colorFor(t);
  const gpx = makeGpxLayer(t, color);
  document.getElementById('track-list').appendChild(listItem(t, color, gpx));
}

async function loadTracks() {
  const headers = {};
  if (adminToken) headers['x-admin-token'] = adminToken; // include emails in admin mode
  const res = await fetch('/api/tracks', { headers });
  const tracks = await res.json();
  document.getElementById('track-list').innerHTML = '';
  group.clearLayers();
  document.getElementById('count').textContent = tracks.length;
  tracks.forEach(addTrack);
}

// ---- Config (search-area framing + optional upload passphrase) -------------
let uploadGated = false;
async function loadConfig() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    uploadGated = cfg.uploadGated;
    if (uploadGated) document.getElementById('passphrase-field').hidden = false;
    if (cfg.search && Number.isFinite(cfg.search.lat) && Number.isFinite(cfg.search.lon)) {
      if (fitPending) map.setView([cfg.search.lat, cfg.search.lon], cfg.search.zoom || 12);
      if (cfg.search.name) {
        const lbl = document.getElementById('area-label');
        if (lbl) lbl.textContent = '📍 ' + cfg.search.name;
      }
    }
  } catch (_) {}
}

// ---- Upload form ----------------------------------------------------------
const form = document.getElementById('upload-form');
const msg = document.getElementById('upload-msg');
const btn = document.getElementById('upload-btn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = ''; msg.className = 'msg';
  btn.disabled = true;
  try {
    const data = new FormData(form);
    const headers = {};
    if (adminToken) headers['x-admin-token'] = adminToken;
    const res = await fetch('/api/tracks', { method: 'POST', body: data, headers });
    if (res.ok) {
      msg.textContent = 'アップロード完了 / Uploaded ✓'; msg.className = 'msg ok';
      form.reset();
      fitPending = false;
      loadTracks();
    } else {
      const err = await res.json().catch(() => ({}));
      msg.textContent = err.error || 'Upload failed (' + res.status + ')'; msg.className = 'msg err';
    }
  } catch (_) {
    msg.textContent = 'Network error. Please retry.'; msg.className = 'msg err';
  } finally {
    btn.disabled = false;
  }
});

// ---- 3D view: hand the current map bounds to the terrain viewer ------------
document.getElementById('btn-3d').addEventListener('click', (e) => {
  e.preventDefault();
  const b = map.getBounds();
  const q = 'w=' + b.getWest().toFixed(5) + '&s=' + b.getSouth().toFixed(5) +
            '&e=' + b.getEast().toFixed(5) + '&n=' + b.getNorth().toFixed(5);
  window.open('/terrain.html?' + q, '_blank', 'noopener');
});

// ---- Mobile panel toggle + go ---------------------------------------------
document.getElementById('panel-toggle').addEventListener('click', () => {
  document.body.classList.toggle('panel-open');
});

loadConfig().then(loadTracks);

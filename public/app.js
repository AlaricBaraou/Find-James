'use strict';

// ===========================================================================
// Upload + display only. Base maps: GSI (Geospatial Information Authority of
// Japan) tiles. Tracks are uploaded as GPX and drawn on the map.
// ===========================================================================
const ATTR =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル GSI Japan</a>';

const TILES = [
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', name: '写真 Satellite', max: 18, default: true },
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', name: '標準 Standard', max: 18 },
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', name: '淡色 Pale', max: 18 },
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/relief/{z}/{x}/{y}.png', name: '色別標高 Relief', max: 15 },
];

// Our colour code: red = search-team track, blue = other (found online).
const TRACK_COLORS = { searcher: '#e60026', other: '#1e6fff' };
function colorFor(t) { return (t && t.color) || TRACK_COLORS[t && t.category] || TRACK_COLORS.searcher; }

const map = L.map('map', { zoomControl: true }).setView([35.055, 135.82], 12); // Mt. Hiei

const baseLayers = {};
TILES.forEach((t) => {
  const layer = L.tileLayer(t.url, { maxZoom: 18, maxNativeZoom: t.max, attribution: ATTR });
  baseLayers[t.name] = layer;
  if (t.default) layer.addTo(map);
});
L.control.layers(baseLayers, {}, { collapsed: true, position: 'topright' }).addTo(map);

const group = L.featureGroup().addTo(map);
let fitPending = true;

// Public reports place the last confirmed sighting around Yamashina Station /
// Yamashina area on May 29. This is an approximate public marker, not an exact
// police-confirmed trail coordinate.
const LAST_SEEN = {
  lat: 34.99234,
  lon: 135.81708,
  date: '2026-05-29',
  label: 'Last seen / 最終目撃',
};
L.marker([LAST_SEEN.lat, LAST_SEEN.lon], {
  icon: L.divIcon({
    className: 'last-seen-marker',
    html: '<span class="pin"></span><span class="label">' + LAST_SEEN.label + '<br>' + LAST_SEEN.date + '</span>',
    iconSize: [154, 42],
    iconAnchor: [12, 36],
  }),
})
  .bindPopup(
    '<strong>最終目撃情報 / Last reported sighting</strong><br>' +
    '2026年5月29日 / May 29, 2026<br>' +
    '山科駅周辺 / Yamashina Station area<br>' +
    '<span class="pmeta">報道・CCTV情報に基づく概略位置です。Approximate public marker based on reporting/CCTV references.</span>'
  )
  .addTo(map);

// Approximate public reporting map of the area already searched by police.
// Source image: Newsweek / Google Maps screenshot. Treat as approximate context,
// not an authoritative operational boundary.
const POLICE_SEARCHED_AREA = [
  [34.9934, 135.8051],
  [34.9951, 135.8014],
  [35.0002, 135.7978],
  [35.0065, 135.7990],
  [35.0112, 135.8047],
  [35.0140, 135.8120],
  [35.0142, 135.8212],
  [35.0106, 135.8286],
  [35.0040, 135.8325],
  [34.9971, 135.8312],
  [34.9929, 135.8242],
  [34.9915, 135.8150],
  [34.9920, 135.8088],
];
L.polygon(POLICE_SEARCHED_AREA, {
  color: '#ff6b35',
  weight: 3,
  opacity: 0.95,
  fillColor: '#ff6b35',
  fillOpacity: 0.14,
  dashArray: '8,6',
})
  .bindTooltip('警察捜索済み範囲（概略） / Police searched area (approx.)', {
    permanent: false,
    direction: 'top',
    className: 'police-search-tooltip',
  })
  .bindPopup(
    '<strong>警察捜索済み範囲（概略） / Police searched area (approx.)</strong><br>' +
    'Newsweek掲載画像をもとにした目安です。<br>' +
    'Approximate area based on a publicly reported Newsweek map image.'
  )
  .addTo(map);

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
  // When a source link is provided, it replaces the generic name as the title.
  // Only http(s) URLs become clickable links (guards against javascript:/data:).
  if (t.source && /^https?:\/\//i.test(t.source)) {
    wrap.appendChild(el('div', { className: 'pname' }, [
      el('a', { href: t.source, target: '_blank', rel: 'noopener noreferrer' }, ['🔗 ' + t.source]),
    ]));
  } else if (t.source) {
    wrap.appendChild(el('div', { className: 'pname' }, [t.source]));
  } else {
    wrap.appendChild(el('div', { className: 'pname' }, [t.name || 'Untitled']));
  }
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

// ---- 3D view ---------------------------------------------------------------
document.getElementById('btn-3d').addEventListener('click', (e) => {
  e.preventDefault();
  window.location.href = '/terrain.html';
});

// ---- Mobile panel toggle + go ---------------------------------------------
document.getElementById('panel-toggle').addEventListener('click', () => {
  document.body.classList.toggle('panel-open');
});

// ---- Missing-person banner ------------------------------------------------
const missingToggle = document.getElementById('missing-toggle');
const missingDetails = document.getElementById('missing-details');
const missingClose = document.getElementById('missing-close');

function setMissingOpen(open) {
  missingDetails.hidden = !open;
  missingToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}

missingToggle.addEventListener('click', () => {
  setMissingOpen(missingDetails.hidden);
});
missingClose.addEventListener('click', () => {
  setMissingOpen(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !missingDetails.hidden) setMissingOpen(false);
});

loadConfig().then(loadTracks);

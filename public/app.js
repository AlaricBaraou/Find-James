'use strict';

// ===========================================================================
// Base maps: GSI (Geospatial Information Authority of Japan) tiles
// ===========================================================================
const ATTR =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル GSI Japan</a>';

const TILES = [
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', name: '標準 Standard', max: 18 },
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', name: '淡色 Pale', max: 18 },
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/relief/{z}/{x}/{y}.png', name: '色別標高 Relief', max: 15 },
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', name: '写真 Satellite', max: 18 },
];

const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#469990', '#f032e6', '#9a6324', '#000075', '#808000',
  '#42d4f4', '#bfef45', '#fabed4', '#dcbeff', '#aaffc3',
];

const map = L.map('map', { zoomControl: true }).setView([35.0116, 135.7681], 11);

const baseLayers = {};
TILES.forEach((t, i) => {
  const layer = L.tileLayer(t.url, { maxZoom: 18, maxNativeZoom: t.max, attribution: ATTR });
  baseLayers[t.name] = layer;
  if (i === 0) layer.addTo(map);
});
L.control.layers(baseLayers, {}, { collapsed: true, position: 'topright' }).addTo(map);

const group = L.featureGroup().addTo(map); // searched + planned route layers
let fitPending = true;

// Admin mode via URL hash: #admin=YOUR_TOKEN
let adminToken = null;
(function () {
  const m = (location.hash || '').match(/admin=([^&]+)/);
  if (m) adminToken = decodeURIComponent(m[1]);
})();

// Remember the searcher's name across claims/uploads.
function rememberName(n) { try { localStorage.setItem('searcherName', n); } catch (_) {} }
function recalledName() { try { return localStorage.getItem('searcherName') || ''; } catch (_) { return ''; } }

// ===========================================================================
// Helpers
// ===========================================================================
function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) Object.assign(node, props);
  (children || []).forEach((c) =>
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
  );
  return node;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])
  );
}

function coordsToGpx(coords, name) {
  // coords: array of [lon, lat, (ele)]
  const pts = coords
    .map((c) => {
      const ele = c[2] != null ? '<ele>' + c[2] + '</ele>' : '';
      return '<trkpt lat="' + c[1] + '" lon="' + c[0] + '">' + ele + '</trkpt>';
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<gpx version="1.1" creator="search-map" xmlns="http://www.topografix.com/GPX/1/1">' +
    '<trk><name>' + escapeXml(name) + '</name><trkseg>' + pts + '</trkseg></trk></gpx>'
  );
}

function styleFor(t, color) {
  if (t.kind === 'planned') {
    if (t.status === 'completed') return { color: t.color || '#3cb44b', weight: 4, opacity: 0.55 };
    if (t.status === 'claimed') return { color: '#4363d8', weight: 5, opacity: 0.95, dashArray: '6,8' };
    return { color: t.color || '#f5a623', weight: t.recommended ? 6 : 4, opacity: 0.95, dashArray: '6,8' };
  }
  return { color: color, weight: 4, opacity: 0.75 };
}

function statusLabel(t) {
  if (t.kind !== 'planned') return '';
  if (t.status === 'completed') return '✓ 完了 done' + (t.completedBy ? ' · ' + t.completedBy : '');
  if (t.status === 'claimed') return '担当 claimed · ' + (t.claimedBy || '?');
  return '未割当 open';
}

// ===========================================================================
// Rendering tracks
// ===========================================================================
function buildPopup(t) {
  const wrap = el('div', {}, []);
  const title = (t.recommended ? '★ ' : '') + (t.name || 'Untitled');
  wrap.appendChild(el('div', { className: 'pname' }, [title]));
  const bits = [];
  if (t.kind === 'planned') bits.push(statusLabel(t));
  if (t.date) bits.push(t.date);
  if (t.uploader) bits.push(t.uploader);
  if (bits.filter(Boolean).length) wrap.appendChild(el('div', { className: 'pmeta' }, [bits.filter(Boolean).join(' · ')]));
  if (t.notes) wrap.appendChild(el('div', {}, [t.notes]));
  return wrap;
}

function makeGpxLayer(t, color) {
  const gpx = new L.GPX('/api/tracks/' + t.id + '/gpx', {
    async: true,
    polyline_options: styleFor(t, color),
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

function listItem(t, color, gpxLayer, opts) {
  const cb = el('input', { type: 'checkbox', checked: true });
  cb.addEventListener('change', () => {
    if (cb.checked) gpxLayer.addTo(group);
    else group.removeLayer(gpxLayer);
  });

  const dot = el('span', { className: 'dot' });
  dot.style.background = styleFor(t, color).color;
  if (t.kind === 'planned') dot.classList.add('planned');

  const nameTxt = (t.recommended ? '★ ' : '') + (t.name || 'Untitled');
  const name = el('span', { className: 'name' }, [nameTxt]);
  const sub = el('span', { className: 'date' }, [
    [t.kind === 'planned' ? statusLabel(t) : t.date, t.uploader].filter(Boolean).join(' · '),
  ]);
  const meta = el('div', { className: 'meta' }, [name, sub]);
  meta.addEventListener('click', () => {
    try { map.fitBounds(gpxLayer.getBounds().pad(0.2)); } catch (_) {}
  });

  const item = el('li', { className: 'track-item' + (t.recommended ? ' recommended' : '') }, [cb, dot, meta]);

  if (opts && opts.planned) appendPlannedActions(item, t);

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

function appendPlannedActions(item, t) {
  const box = el('div', { className: 'claim-actions' });
  async function post(action, body) {
    const res = await fetch('/api/tracks/' + t.id + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (res.ok) loadTracks();
    else {
      const e = await res.json().catch(() => ({}));
      alert(e.error || (action + ' failed'));
    }
  }
  if (t.status === 'open') {
    const b = el('button', { className: 'claim', textContent: '担当する / Claim' });
    b.addEventListener('click', () => {
      const by = prompt('お名前 / Your name:', recalledName());
      if (by) { rememberName(by); post('claim', { by }); }
    });
    box.appendChild(b);
  } else if (t.status === 'claimed') {
    const done = el('button', { className: 'done', textContent: '完了 / Done' });
    done.addEventListener('click', () => post('complete', { by: t.claimedBy }));
    const rel = el('button', { className: 'release', textContent: '解除 / Release' });
    rel.addEventListener('click', () => post('release', {}));
    box.appendChild(done); box.appendChild(rel);
  }
  if (box.childNodes.length) item.appendChild(box);
}

function addTrack(t, idx) {
  const color = t.color || PALETTE[idx % PALETTE.length];
  const gpx = makeGpxLayer(t, color);
  const planned = t.kind === 'planned';
  const list = document.getElementById(planned ? 'planned-list' : 'track-list');
  list.appendChild(listItem(t, color, gpx, { planned }));
}

async function loadTracks() {
  const res = await fetch('/api/tracks');
  const tracks = await res.json();
  document.getElementById('track-list').innerHTML = '';
  document.getElementById('planned-list').innerHTML = '';
  group.clearLayers();
  document.getElementById('count').textContent = tracks.filter((t) => t.kind !== 'planned').length;
  tracks.forEach(addTrack);
}

// ===========================================================================
// Upload form
// ===========================================================================
let uploadGated = false;
async function loadConfig() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    uploadGated = cfg.uploadGated;
    if (uploadGated) document.getElementById('passphrase-field').hidden = false;
    if (cfg.search && Number.isFinite(cfg.search.lat) && Number.isFinite(cfg.search.lon)) {
      // Frame the configured search area, unless tracks have already auto-fit.
      if (fitPending) map.setView([cfg.search.lat, cfg.search.lon], cfg.search.zoom || 12);
      if (cfg.search.name) {
        const h1 = document.querySelector('#panel header h1 span');
        if (h1) h1.textContent = cfg.search.name;
      }
    }
  } catch (_) {}
}
if (adminToken) document.getElementById('recommended-field').hidden = false;

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
      const color = form.color.value;
      form.reset();
      form.color.value = color;
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

// ===========================================================================
// Route planner (click waypoints -> snap to trails via BRouter -> save)
// ===========================================================================
const planner = {
  active: false,
  waypoints: [],   // L.LatLng
  markers: [],     // L.CircleMarker
  preview: null,   // L.Polyline
  resolved: [],    // [[lon,lat,ele?], ...] final route geometry
};

const plannerBar = document.getElementById('planner-bar');
const planStatus = document.getElementById('plan-status');

function setPlanStatus(txt) { planStatus.textContent = txt; }

function enterPlanner() {
  planner.active = true;
  plannerBar.hidden = false;
  document.body.classList.add('planning');
  map.getContainer().style.cursor = 'crosshair';
  setPlanStatus('地図をクリックして点を追加 / Click the map to add points');
}

function exitPlanner() {
  planner.active = false;
  plannerBar.hidden = true;
  document.body.classList.remove('planning');
  map.getContainer().style.cursor = '';
  clearPlanner();
}

function clearPlanner() {
  planner.waypoints = [];
  planner.markers.forEach((m) => map.removeLayer(m));
  planner.markers = [];
  if (planner.preview) { map.removeLayer(planner.preview); planner.preview = null; }
  planner.resolved = [];
  if (planner.active) setPlanStatus('地図をクリックして点を追加 / Click the map to add points');
}

map.on('click', (e) => {
  if (!planner.active) return;
  planner.waypoints.push(e.latlng);
  const m = L.circleMarker(e.latlng, { radius: 5, color: '#ff00aa', weight: 2, fillOpacity: 1 }).addTo(map);
  planner.markers.push(m);
  recomputeRoute();
});

async function snapToTrails(latlngs) {
  const lonlats = latlngs.map((p) => p.lng.toFixed(6) + ',' + p.lat.toFixed(6)).join('|');
  const url =
    'https://brouter.de/brouter?lonlats=' + lonlats +
    '&profile=hiking-beta&alternativeidx=0&format=geojson';
  const res = await fetch(url);
  if (!res.ok) throw new Error('BRouter ' + res.status);
  const gj = await res.json();
  const coords = gj.features && gj.features[0] && gj.features[0].geometry.coordinates;
  if (!coords || !coords.length) throw new Error('no route');
  return coords; // [[lon,lat,(ele)], ...]
}

function drawPreview(latlngsForLine, resolvedCoords) {
  if (planner.preview) map.removeLayer(planner.preview);
  planner.preview = L.polyline(latlngsForLine, {
    color: '#ff00aa', weight: 4, opacity: 0.9, dashArray: '4,6',
  }).addTo(map);
  planner.resolved = resolvedCoords;
  // distance
  let d = 0;
  for (let i = 1; i < latlngsForLine.length; i++) d += latlngsForLine[i - 1].distanceTo(latlngsForLine[i]);
  setPlanStatus((d / 1000).toFixed(2) + ' km · ' + planner.waypoints.length + ' pts');
}

let recomputeSeq = 0;
async function recomputeRoute() {
  if (planner.waypoints.length < 2) {
    if (planner.preview) { map.removeLayer(planner.preview); planner.preview = null; }
    planner.resolved = planner.waypoints.map((p) => [p.lng, p.lat]);
    return;
  }
  const snap = document.getElementById('snap-trails').checked;
  const seq = ++recomputeSeq;
  if (!snap) {
    drawPreview(planner.waypoints.slice(), planner.waypoints.map((p) => [p.lng, p.lat]));
    return;
  }
  setPlanStatus('trail探索中… / routing…');
  try {
    const coords = await snapToTrails(planner.waypoints);
    if (seq !== recomputeSeq) return; // a newer request superseded this one
    const latlngs = coords.map((c) => L.latLng(c[1], c[0]));
    drawPreview(latlngs, coords);
  } catch (err) {
    if (seq !== recomputeSeq) return;
    // Fall back to straight segments so planning still works off-trail / offline.
    drawPreview(planner.waypoints.slice(), planner.waypoints.map((p) => [p.lng, p.lat]));
    setPlanStatus('trail探索失敗→直線 / routing failed, straight line');
  }
}

document.getElementById('btn-plan').addEventListener('click', () => {
  if (planner.active) exitPlanner(); else enterPlanner();
});
document.getElementById('plan-cancel').addEventListener('click', exitPlanner);
document.getElementById('plan-clear').addEventListener('click', clearPlanner);
document.getElementById('plan-undo').addEventListener('click', () => {
  planner.waypoints.pop();
  const m = planner.markers.pop();
  if (m) map.removeLayer(m);
  recomputeRoute();
});
document.getElementById('snap-trails').addEventListener('change', recomputeRoute);

document.getElementById('plan-save').addEventListener('click', async () => {
  if (planner.resolved.length < 2) { alert('2点以上をクリックしてください / Add at least 2 points.'); return; }
  const name = prompt('ルート名 / Route name:', '');
  if (!name) return;
  const gpx = coordsToGpx(planner.resolved, name);
  const data = new FormData();
  data.append('kind', 'planned');
  data.append('name', name);
  data.append('color', '#f5a623');
  data.append('gpx', new Blob([gpx], { type: 'application/gpx+xml' }), 'route.gpx');
  const headers = {};
  if (adminToken) {
    headers['x-admin-token'] = adminToken;
    if (confirm('★ 推奨ルートにしますか？ / Mark as recommended?')) data.append('recommended', 'true');
  }
  if (uploadGated) {
    const pass = prompt('合言葉 / Passphrase:');
    if (pass) data.append('passphrase', pass);
  }
  setPlanStatus('保存中… / saving…');
  const res = await fetch('/api/tracks', { method: 'POST', body: data, headers });
  if (res.ok) { exitPlanner(); fitPending = false; loadTracks(); }
  else {
    const e = await res.json().catch(() => ({}));
    alert(e.error || 'Save failed'); setPlanStatus('保存失敗 / save failed');
  }
});

// ===========================================================================
// 3D view: hand the current map bounds to the terrain viewer
// ===========================================================================
document.getElementById('btn-3d').addEventListener('click', (e) => {
  e.preventDefault();
  const b = map.getBounds();
  const q = 'w=' + b.getWest().toFixed(5) + '&s=' + b.getSouth().toFixed(5) +
            '&e=' + b.getEast().toFixed(5) + '&n=' + b.getNorth().toFixed(5);
  window.open('/terrain.html?' + q, '_blank', 'noopener');
});

// ===========================================================================
// Mobile panel toggle + go
// ===========================================================================
document.getElementById('panel-toggle').addEventListener('click', () => {
  document.body.classList.toggle('panel-open');
});

loadConfig();
loadTracks();

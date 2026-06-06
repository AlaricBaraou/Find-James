'use strict';

// ---- Base maps: GSI (Geospatial Information Authority of Japan) tiles -------
const ATTR =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル GSI Japan</a>';

const TILES = [
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', name: '標準 Standard', max: 18 },
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', name: '淡色 Pale', max: 18 },
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/relief/{z}/{x}/{y}.png', name: '色別標高 Relief', max: 15 },
  { url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', name: '写真 Satellite', max: 18 },
];

// Distinguishable default colors when an uploader did not pick one.
const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#469990', '#f032e6', '#9a6324', '#000075', '#808000',
  '#e6194b', '#42d4f4', '#bfef45', '#fabed4', '#dcbeff',
];

// Default view: Kyoto. The map auto-fits to uploaded tracks once they load.
const map = L.map('map', { zoomControl: true }).setView([35.0116, 135.7681], 11);

const baseLayers = {};
TILES.forEach((t, i) => {
  const layer = L.tileLayer(t.url, { maxZoom: 18, maxNativeZoom: t.max, attribution: ATTR });
  baseLayers[t.name] = layer;
  if (i === 0) layer.addTo(map);
});
L.control.layers(baseLayers, {}, { collapsed: true, position: 'topright' }).addTo(map);

const group = L.featureGroup().addTo(map);

// ---- Admin mode (delete buttons) via URL hash: #admin=YOUR_TOKEN -----------
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
  const bits = [];
  if (t.date) bits.push(t.date);
  if (t.uploader) bits.push(t.uploader);
  if (bits.length) wrap.appendChild(el('div', { className: 'pmeta' }, [bits.join(' · ')]));
  if (t.notes) wrap.appendChild(el('div', {}, [t.notes]));
  return wrap;
}

function buildListItem(t, color, gpxLayer) {
  const cb = el('input', { type: 'checkbox', checked: true });
  cb.addEventListener('change', () => {
    if (cb.checked) gpxLayer.addTo(group);
    else group.removeLayer(gpxLayer);
  });

  const dot = el('span', { className: 'dot' });
  dot.style.background = color;

  const name = el('span', { className: 'name' }, [t.name || 'Untitled']);
  const date = el('span', { className: 'date' }, [
    [t.date, t.uploader].filter(Boolean).join(' · '),
  ]);
  const meta = el('div', { className: 'meta' }, [name, date]);
  meta.addEventListener('click', () => {
    try {
      map.fitBounds(gpxLayer.getBounds().pad(0.2));
    } catch (_) {}
  });

  const item = el('li', { className: 'track-item' }, [cb, dot, meta]);

  if (adminToken) {
    const del = el('button', { className: 'del', title: 'Delete', textContent: '✕' });
    del.addEventListener('click', async () => {
      if (!confirm('Delete "' + (t.name || 'this track') + '"?')) return;
      const res = await fetch('/api/tracks/' + t.id, {
        method: 'DELETE',
        headers: { 'x-admin-token': adminToken },
      });
      if (res.ok) {
        group.removeLayer(gpxLayer);
        item.remove();
        const c = document.getElementById('count');
        c.textContent = Math.max(0, parseInt(c.textContent, 10) - 1);
      } else {
        alert('Delete failed (' + res.status + ')');
      }
    });
    item.appendChild(del);
  }
  return item;
}

let fitPending = true;

function addTrack(t, idx) {
  const color = t.color || PALETTE[idx % PALETTE.length];
  const gpx = new L.GPX('/api/tracks/' + t.id + '/gpx', {
    async: true,
    polyline_options: { color: color, weight: 4, opacity: 0.75 },
    // Hide leaflet-gpx's default start/end markers (avoids missing-icon errors).
    marker_options: { startIconUrl: '', endIconUrl: '', shadowUrl: '' },
  });
  gpx.bindPopup(buildPopup(t));
  gpx.on('loaded', () => {
    gpx.addTo(group);
    if (fitPending) {
      try {
        map.fitBounds(group.getBounds().pad(0.15));
      } catch (_) {}
    }
  });
  document.getElementById('track-list').appendChild(buildListItem(t, color, gpx));
}

async function loadTracks() {
  const res = await fetch('/api/tracks');
  const tracks = await res.json();
  document.getElementById('track-list').innerHTML = '';
  group.clearLayers();
  document.getElementById('count').textContent = tracks.length;
  // Only auto-fit on the very first load so we don't yank the map after uploads.
  tracks.forEach(addTrack);
}

// ---- Upload form ----------------------------------------------------------
let uploadGated = false;

async function loadConfig() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    uploadGated = cfg.uploadGated;
    if (uploadGated) document.getElementById('passphrase-field').hidden = false;
  } catch (_) {}
}

const form = document.getElementById('upload-form');
const msg = document.getElementById('upload-msg');
const btn = document.getElementById('upload-btn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = '';
  msg.className = 'msg';
  btn.disabled = true;
  try {
    const data = new FormData(form);
    const res = await fetch('/api/tracks', { method: 'POST', body: data });
    if (res.ok) {
      const rec = await res.json();
      msg.textContent = 'アップロード完了 / Uploaded ✓';
      msg.className = 'msg ok';
      // Keep the chosen color & passphrase; clear the rest.
      const color = form.color.value;
      const pass = uploadGated ? form.passphrase.value : '';
      form.reset();
      form.color.value = color;
      if (uploadGated) form.passphrase.value = pass;
      fitPending = false; // don't snap the map away from where the user is looking
      addTrack(rec, parseInt(document.getElementById('count').textContent, 10));
      const c = document.getElementById('count');
      c.textContent = parseInt(c.textContent, 10) + 1;
    } else {
      const err = await res.json().catch(() => ({}));
      msg.textContent = err.error || 'Upload failed (' + res.status + ')';
      msg.className = 'msg err';
    }
  } catch (err) {
    msg.textContent = 'Network error. Please retry.';
    msg.className = 'msg err';
  } finally {
    btn.disabled = false;
  }
});

// ---- Mobile panel toggle --------------------------------------------------
document.getElementById('panel-toggle').addEventListener('click', () => {
  document.body.classList.toggle('panel-open');
});

// ---- Go --------------------------------------------------------------------
loadConfig();
// fitPending stays true through the initial load so the map auto-fits to all
// tracks as their GPX data arrives. The upload handler sets it false so new
// uploads don't yank the map away from where the user is looking.
loadTracks();

'use strict';

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ===========================================================================
// Build a 3D terrain mesh from GSI DEM tiles, drape GSI imagery over it, and
// overlay the search tracks. Tiles are fetched through our same-origin proxy
// (/api/gsi/...) so DEM fetch() and canvas textures are not blocked by CORS.
//
// NOTE: this needs the server to reach GSI (cyberjapandata.gsi.go.jp). It is
// experimental and best-tuned in a real browser.
// ===========================================================================

const R = 6378137; // spherical mercator radius
const DEG = Math.PI / 180;
const statusEl = document.getElementById('status');
function setStatus(t, err) { statusEl.textContent = t; statusEl.className = err ? 'err' : ''; }

// ---- Fixed 3D bounds -------------------------------------------------------
// Keep the 3D terrain extent stable so tile count and coverage are predictable.
// Add ?dynamic=1&w=...&s=...&e=...&n=... only for debugging viewport-specific
// terrain slices.
const qp = new URLSearchParams(location.search);
let west = 135.77;
let east = 135.88;
let south = 34.985;
let north = 35.085;
if (qp.get('dynamic') === '1') {
  const qw = parseFloat(qp.get('w'));
  const qs = parseFloat(qp.get('s'));
  const qe = parseFloat(qp.get('e'));
  const qn = parseFloat(qp.get('n'));
  if ([qw, qs, qe, qn].every(Number.isFinite)) {
    west = qw; south = qs; east = qe; north = qn;
  }
}
// Add extra north/south context so the 3D slab does not cut off nearby ridges/tracks.
{
  const padLat = Math.max(0.012, (north - south) * 0.28);
  south -= padLat;
  north += padLat;
}
// Guard against absurdly large boxes (keep tile counts sane).
if (east - west > 0.6) { const c = (east + west) / 2; west = c - 0.3; east = c + 0.3; }
if (north - south > 0.5) { const c = (north + south) / 2; south = c - 0.25; north = c + 0.25; }

// ---- Mercator + tile math --------------------------------------------------
const lon2x = (lon) => R * lon * DEG;
const lat2y = (lat) => R * Math.log(Math.tan(Math.PI / 4 + lat * DEG / 2));
const lon2tile = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2tile = (lat, z) => {
  const r = lat * DEG;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const tileMercSize = (z) => (2 * Math.PI * R) / 2 ** z;
const mercXofTile = (tx, z) => -Math.PI * R + tx * tileMercSize(z);
const mercYofTile = (ty, z) => Math.PI * R - ty * tileMercSize(z);

const centerMercX = lon2x((west + east) / 2);
const centerMercY = lat2y((south + north) / 2);

// ===========================================================================
// DEM (elevation)
// ===========================================================================
const DEM_ZOOM = 14; // DEM10B, ~10 m, nationwide coverage
const demTiles = new Map(); // "x_y" -> Float32Array(256*256), NaN = nodata

function parseDem(text) {
  const grid = new Float32Array(256 * 256);
  const rows = text.trim().split('\n');
  for (let y = 0; y < 256; y++) {
    const cols = (rows[y] || '').split(',');
    for (let x = 0; x < 256; x++) {
      const v = cols[x];
      grid[y * 256 + x] = v === undefined || v === 'e' || v === '' ? NaN : parseFloat(v);
    }
  }
  return grid;
}

async function loadDem() {
  const txMin = Math.floor(lon2tile(west, DEM_ZOOM));
  const txMax = Math.floor(lon2tile(east, DEM_ZOOM));
  const tyMin = Math.floor(lat2tile(north, DEM_ZOOM));
  const tyMax = Math.floor(lat2tile(south, DEM_ZOOM));
  const jobs = [];
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let ty = tyMin; ty <= tyMax; ty++) {
      jobs.push(
        fetch(`/api/gsi/dem/${DEM_ZOOM}/${tx}/${ty}`)
          .then((r) => (r.ok ? r.text() : null))
          .then((t) => { if (t) demTiles.set(tx + '_' + ty, parseDem(t)); })
          .catch(() => {})
      );
    }
  }
  await Promise.all(jobs);
  return demTiles.size > 0;
}

function demPixel(px, py) {
  const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
  const grid = demTiles.get(tx + '_' + ty);
  if (!grid) return NaN;
  const lx = px - tx * 256, ly = py - ty * 256;
  return grid[ly * 256 + lx];
}

function elevAt(lon, lat) {
  const gx = lon2tile(lon, DEM_ZOOM) * 256;
  const gy = lat2tile(lat, DEM_ZOOM) * 256;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const v = [demPixel(x0, y0), demPixel(x0 + 1, y0), demPixel(x0, y0 + 1), demPixel(x0 + 1, y0 + 1)];
  const known = v.filter((n) => !Number.isNaN(n));
  if (!known.length) return 0;
  const mean = known.reduce((a, b) => a + b, 0) / known.length;
  const g = (n) => (Number.isNaN(n) ? mean : n);
  return (g(v[0]) * (1 - fx) + g(v[1]) * fx) * (1 - fy) + (g(v[2]) * (1 - fx) + g(v[3]) * fx) * fy;
}

// ===========================================================================
// Imagery texture (draped over the mesh)
// ===========================================================================
function pickTexZoom() {
  for (let z = 16; z >= 12; z--) {
    const nx = Math.floor(lon2tile(east, z)) - Math.floor(lon2tile(west, z)) + 1;
    const ny = Math.floor(lat2tile(south, z)) - Math.floor(lat2tile(north, z)) + 1;
    if (nx <= 6 && ny <= 6) return z;
  }
  return 12;
}

let texExtent = null; // mercator bounds of the imagery canvas

async function buildTexture(layer) {
  const z = pickTexZoom();
  const txMin = Math.floor(lon2tile(west, z));
  const txMax = Math.floor(lon2tile(east, z));
  const tyMin = Math.floor(lat2tile(north, z));
  const tyMax = Math.floor(lat2tile(south, z));
  const nx = txMax - txMin + 1, ny = tyMax - tyMin + 1;
  const canvas = document.createElement('canvas');
  canvas.width = nx * 256;
  canvas.height = ny * 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#33373f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const jobs = [];
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let ty = tyMin; ty <= tyMax; ty++) {
      jobs.push(
        new Promise((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => { ctx.drawImage(img, (tx - txMin) * 256, (ty - tyMin) * 256); resolve(); };
          img.onerror = () => resolve();
          img.src = `/api/gsi/${layer}/${z}/${tx}/${ty}`;
        })
      );
    }
  }
  await Promise.all(jobs);

  texExtent = {
    left: mercXofTile(txMin, z),
    right: mercXofTile(txMax + 1, z),
    top: mercYofTile(tyMin, z),
    bottom: mercYofTile(tyMax + 1, z),
  };
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ===========================================================================
// Scene
// ===========================================================================
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);
scene.fog = new THREE.Fog(0x0b0e14, 4000, 16000);

const worldWidth = lon2x(east) - lon2x(west);
const worldDepth = lat2y(north) - lat2y(south);
const worldSize = Math.max(worldWidth, worldDepth);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 1, Math.max(60000, worldSize * 8));
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495; // don't go under the ground

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(-1, 1.4, -0.8);
scene.add(sun);

let exag = 1.7;
let terrainMesh = null;
let baseElev = null; // Float32Array of per-vertex elevations (pre-exaggeration)
let segX = 0, segY = 0;

function uvFor(mercX, mercY) {
  const u = (mercX - texExtent.left) / (texExtent.right - texExtent.left);
  const v = (mercY - texExtent.bottom) / (texExtent.top - texExtent.bottom);
  return [u, v];
}

function buildTerrain(texture) {
  // Mesh resolution: aim ~ one vertex per 35 m, capped.
  segX = Math.min(220, Math.max(32, Math.round(worldWidth / 35)));
  segY = Math.min(220, Math.max(32, Math.round(worldDepth / 35)));
  const geo = new THREE.PlaneGeometry(worldWidth, worldDepth, segX, segY);
  geo.rotateX(-Math.PI / 2); // lie flat in XZ; +Z initially south

  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  baseElev = new Float32Array(pos.count);

  for (let j = 0; j <= segY; j++) {
    for (let i = 0; i <= segX; i++) {
      const idx = j * (segX + 1) + i;
      const lon = west + (east - west) * (i / segX);
      const lat = north - (north - south) * (j / segY);
      const mercX = lon2x(lon), mercY = lat2y(lat);
      baseElev[idx] = elevAt(lon, lat);
      pos.setX(idx, mercX - centerMercX);
      pos.setZ(idx, -(mercY - centerMercY));
      pos.setY(idx, baseElev[idx] * exag);
      const [u, v] = uvFor(mercX, mercY);
      uv.setXY(idx, u, v);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    map: texture || null,
    color: texture ? 0xffffff : 0x6b7280,
    roughness: 1,
    metalness: 0,
  });
  terrainMesh = new THREE.Mesh(geo, mat);
  scene.add(terrainMesh);
}

function applyExag() {
  if (!terrainMesh || !baseElev) return;
  const pos = terrainMesh.geometry.attributes.position;
  for (let k = 0; k < pos.count; k++) pos.setY(k, baseElev[k] * exag);
  pos.needsUpdate = true;
  terrainMesh.geometry.computeVertexNormals();
  updateTrackHeights();
}

// ---- World position helper for a lon/lat ----------------------------------
function worldPos(lon, lat, lift) {
  return new THREE.Vector3(
    lon2x(lon) - centerMercX,
    elevAt(lon, lat) * exag + (lift || 0),
    -(lat2y(lat) - centerMercY)
  );
}

// ===========================================================================
// Tracks overlay
// ===========================================================================
const TRACK_RADIUS = Math.max(6, Math.min(28, worldSize / 850));
const TRACK_LIFT = Math.max(7, TRACK_RADIUS * 1.15);
const DASH_SIZE = Math.max(70, worldSize / 120);
const DASH_GAP = DASH_SIZE * 0.75;
const trackObjs = []; // { mesh, pts: [[lon,lat]], planned, color }
const TRACK_COLORS = { searcher: '#e60026', other: '#1e6fff' };

function parseGpx(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const out = [];
  doc.querySelectorAll('trkpt, rtept').forEach((p) => {
    const lat = parseFloat(p.getAttribute('lat'));
    const lon = parseFloat(p.getAttribute('lon'));
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.push([lon, lat]);
  });
  return out;
}

function trackColor(t) {
  return new THREE.Color((t && t.color) || TRACK_COLORS[t && t.category] || TRACK_COLORS.searcher);
}

async function loadTracks() {
  let tracks = [];
  try { tracks = await (await fetch('/api/tracks')).json(); } catch (_) { return; }
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    try {
      const xml = await (await fetch('/api/tracks/' + t.id + '/gpx')).text();
      const pts = parseGpx(xml);
      if (pts.length < 2) continue;
      const planned = t.kind === 'planned';
      const color = trackColor(t);
      const obj = { mesh: null, pts, planned, color };
      setTrackHeights(obj);
      trackObjs.push(obj);
    } catch (_) {}
  }
}

function disposeObject(obj) {
  obj.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
  });
}

function lineCurvePath(points) {
  const path = new THREE.CurvePath();
  for (let i = 1; i < points.length; i++) {
    path.add(new THREE.LineCurve3(points[i - 1], points[i]));
  }
  return path;
}

function cylinderBetween(a, b, radius, material) {
  const delta = b.clone().sub(a);
  const len = delta.length();
  if (len < 0.01) return null;
  const geo = new THREE.CylinderGeometry(radius, radius, len, 8, 1, false);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  return mesh;
}

function buildTrackMesh(points, color, planned) {
  const mat = new THREE.MeshBasicMaterial({
    color,
    depthTest: true,
    depthWrite: false,
  });
  if (!planned) {
    const path = lineCurvePath(points);
    const segments = Math.max(16, Math.min(900, points.length * 4));
    return new THREE.Mesh(new THREE.TubeGeometry(path, segments, TRACK_RADIUS, 8, false), mat);
  }

  const group = new THREE.Group();
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1];
    const end = points[i];
    const seg = end.clone().sub(start);
    const len = seg.length();
    if (len < 0.01) continue;
    const dir = seg.clone().normalize();
    for (let at = 0; at < len; at += DASH_SIZE + DASH_GAP) {
      const a = start.clone().addScaledVector(dir, at);
      const b = start.clone().addScaledVector(dir, Math.min(at + DASH_SIZE, len));
      const dash = cylinderBetween(a, b, TRACK_RADIUS, mat);
      if (dash) group.add(dash);
    }
  }
  return group;
}

function setTrackHeights(obj) {
  const points = [];
  for (let k = 0; k < obj.pts.length; k++) {
    points.push(worldPos(obj.pts[k][0], obj.pts[k][1], TRACK_LIFT));
  }
  if (obj.mesh) {
    scene.remove(obj.mesh);
    disposeObject(obj.mesh);
  }
  obj.mesh = buildTrackMesh(points, obj.color, obj.planned);
  scene.add(obj.mesh);
}

function updateTrackHeights() { trackObjs.forEach(setTrackHeights); }

// ===========================================================================
// Camera framing + loop
// ===========================================================================
function frameCamera() {
  let radius = worldSize * 0.75;
  if (terrainMesh) {
    terrainMesh.geometry.computeBoundingSphere();
    if (terrainMesh.geometry.boundingSphere) radius = Math.max(radius, terrainMesh.geometry.boundingSphere.radius);
  }
  camera.near = Math.max(0.5, radius / 12000);
  camera.far = Math.max(60000, radius * 12);
  scene.fog.near = Math.max(radius * 1.6, 4000);
  scene.fog.far = Math.max(radius * 7, 16000);
  controls.target.set(0, 0, 0);
  controls.minDistance = Math.max(20, radius * 0.03);
  controls.maxDistance = radius * 6;
  camera.position.set(0, radius * 0.82, radius * 1.38);
  camera.updateProjectionMatrix();
  controls.update();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

document.getElementById('exag').addEventListener('input', (e) => {
  exag = parseFloat(e.target.value);
  document.getElementById('exag-val').textContent = exag.toFixed(1);
  applyExag();
});

document.getElementById('surface').addEventListener('change', async (e) => {
  setStatus('表面を切替中… / switching surface…');
  const tex = await buildTexture(e.target.value);
  if (terrainMesh) {
    terrainMesh.material.map = tex;
    terrainMesh.material.color.set(0xffffff);
    terrainMesh.material.needsUpdate = true;
  }
  setStatus('');
});

document.getElementById('toggle').addEventListener('click', () => {
  document.getElementById('hud').classList.toggle('min');
});

// ===========================================================================
// Boot
// ===========================================================================
(async function boot() {
  frameCamera();
  animate();
  setStatus('標高データ取得中… / loading elevation…');
  const haveDem = await loadDem();
  if (!haveDem) {
    setStatus('地形データを取得できません（サーバーのGSI接続が必要）/ terrain data unavailable — server needs outbound access to GSI.', true);
  }
  setStatus('衛星画像取得中… / loading imagery…');
  let tex = null;
  try { tex = await buildTexture('seamlessphoto'); } catch (_) {}
  buildTerrain(tex);
  frameCamera();
  setStatus('トラック描画中… / drawing tracks…');
  await loadTracks();
  setStatus(haveDem ? '' : 'No terrain (flat). Tracks shown.', !haveDem);
})();

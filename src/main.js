// Time Warp — roads positioned so distance from the CBD = drive time.
// The pipeline precomputes an elastic (diffusion-warped) embedding per
// congestion profile; the vertex shader blends those embeddings through the
// day, so the city deforms like a soft sheet. JS only advances the clock.
// Sydney / Melbourne / Brisbane, switchable at runtime.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const WORLD_R = 110; // world units the night-time map roughly spans

// Gaussian day-curve: how strongly each congestion profile applies at hour h.
// Mirrored in the vertex shader — keep in sync.
const PEAKS = { am: [8.25, 1.4], mid: [13.0, 2.8], pm: [17.5, 1.7] };
const gauss = (h, [c, s]) => Math.exp(-0.5 * ((h - c) / s) ** 2);

const params = new URLSearchParams(location.search);
const CITY_SUB = { sydney: 'Sydney', melbourne: 'Melbourne', brisbane: 'Brisbane' };

// ---------------------------------------------------------------- data
async function loadData(city) {
  const [manifest, bin] = await Promise.all([
    fetch(`data/${city}.json`).then((r) => r.json()),
    fetch(`data/${city}.bin`).then((r) => r.arrayBuffer()),
  ]);
  const view = (Type, name) =>
    new Type(bin, manifest.layout[name].offset, manifest.layout[name].length);
  return {
    manifest,
    stripClass: view(Uint8Array, 'stripClass'),
    stripCat: view(Uint8Array, 'stripCat'),
    stripLen: view(Uint16Array, 'stripLen'),
    stripName: view(Uint16Array, 'stripName'),
    stripSuburb: view(Uint16Array, 'stripSuburb'),
    posGeo: view(Int16Array, 'posGeo'),
    pos: ['night', 'am', 'mid', 'pm'].map((n) => view(Int16Array, `pos_${n}`)),
    t: ['night', 'am', 'mid', 'pm'].map((n) => view(Uint16Array, `t_${n}`)),
  };
}

// ------------------------------------------------------------ geometry
// Strips → LineSegments. position = (geoX, geoY, meta) in metres,
// meta = class + 16 × category. aP01 = night/am positions, aP23 = mid/pm,
// aTimes = 4 profile drive-times (for colour).
function buildRoads(d) {
  const { stripClass, stripCat, stripLen, posGeo, pos, t, manifest } = d;
  const S = manifest.posScale;
  let segVerts = 0;
  for (let s = 0; s < stripLen.length; s++) segVerts += (stripLen[s] - 1) * 2;

  const aPos = new Float32Array(segVerts * 3);
  const aP01 = new Float32Array(segVerts * 4);
  const aP23 = new Float32Array(segVerts * 4);
  const aT = new Float32Array(segVerts * 4);

  let v = 0, base = 0;
  for (let s = 0; s < stripLen.length; s++) {
    const n = stripLen[s];
    const meta = stripClass[s] + 16 * stripCat[s];
    for (let i = 0; i < n - 1; i++) {
      for (const j of [base + i, base + i + 1]) {
        aPos[v * 3] = posGeo[j * 2] * S;
        aPos[v * 3 + 1] = posGeo[j * 2 + 1] * S;
        aPos[v * 3 + 2] = meta;
        aP01[v * 4] = pos[0][j * 2] * S;
        aP01[v * 4 + 1] = pos[0][j * 2 + 1] * S;
        aP01[v * 4 + 2] = pos[1][j * 2] * S;
        aP01[v * 4 + 3] = pos[1][j * 2 + 1] * S;
        aP23[v * 4] = pos[2][j * 2] * S;
        aP23[v * 4 + 1] = pos[2][j * 2 + 1] * S;
        aP23[v * 4 + 2] = pos[3][j * 2] * S;
        aP23[v * 4 + 3] = pos[3][j * 2 + 1] * S;
        for (let k = 0; k < 4; k++) aT[v * 4 + k] = t[k][j];
        v++;
      }
    }
    base += n;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(aPos, 3));
  geo.setAttribute('aP01', new THREE.BufferAttribute(aP01, 4));
  geo.setAttribute('aP23', new THREE.BufferAttribute(aP23, 4));
  geo.setAttribute('aTimes', new THREE.BufferAttribute(aT, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), WORLD_R * 6);
  return geo;
}

const vertexShader = /* glsl */ `
  attribute vec4 aP01, aP23, aTimes;
  uniform float uHour, uWarp, uUnit, uSwell, uTime;
  uniform float uBright[8];
  uniform float uCatVis[4];
  varying vec3 vColor;
  varying float vAlpha;

  float g(float h, float c, float s) { float d = h - c; return exp(-0.5 * d * d / (s * s)); }

  void main() {
    int meta = int(position.z + 0.5);
    int cls  = meta - (meta / 16) * 16;
    int cat  = meta / 16;

    float wA = g(uHour, 8.25, 1.4);
    float wM = g(uHour, 13.0, 2.8);
    float wP = g(uHour, 17.5, 1.7);

    // blend the four elastic embeddings, exaggerate beyond free-flow
    vec2 pN = aP01.xy, pA = aP01.zw, pM = aP23.xy, pP = aP23.zw;
    vec2 pBlend = pN + wA * (pA - pN) + wM * (pM - pN) + wP * (pP - pN);
    vec2 pShow = pN + uSwell * (pBlend - pN);
    vec2 q = mix(position.xy, pShow, uWarp);

    // organic micro-undulation, proportional to how displaced this point is
    float swellAmt = length(pShow - pN);
    float rq = max(length(q), 1.0);
    vec2 perp = vec2(-q.y, q.x) / rq;
    q += perp * sin(uTime * 0.55 + (q.x + q.y) * 2.5e-4 + float(cat) * 1.7)
              * 0.04 * swellAmt * uWarp;

    vec3 p = vec3(q.x, 0.0, -q.y) * uUnit;

    // congestion: how much slower than free-flow this point currently is
    float tN = aTimes.x;
    float t = tN + wA * (aTimes.y - tN) + wM * (aTimes.z - tN) + wP * (aTimes.w - tN);
    float ratio = t / max(tN, 1.0);
    float c = clamp((ratio - 1.0) / 1.1, 0.0, 1.0);
    vec3 cool  = vec3(0.16, 0.42, 0.88);
    vec3 amber = vec3(1.00, 0.64, 0.20);
    vec3 ember = vec3(1.00, 0.16, 0.22);
    vec3 col = c < 0.5 ? mix(cool, amber, c * 2.0) : mix(amber, ember, c * 2.0 - 1.0);

    float bright = uBright[cls];
    vColor = col * bright;
    vAlpha = (0.32 + 0.45 * bright) * uCatVis[cat];

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    if (vAlpha < 0.004) discard;
    gl_FragColor = vec4(vColor, vAlpha);
  }
`;

// ----------------------------------------------------------- hud bits
function makeLabel(text, size = 26) {
  const pad = 8;
  const canvas2 = document.createElement('canvas');
  const ctx = canvas2.getContext('2d');
  ctx.font = `300 ${size}px 'Spline Sans Mono', monospace`;
  canvas2.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvas2.height = size + pad * 2;
  const c2 = canvas2.getContext('2d');
  c2.font = `300 ${size}px 'Spline Sans Mono', monospace`;
  c2.fillStyle = 'rgba(232, 228, 216, 0.6)';
  c2.textBaseline = 'middle';
  c2.fillText(text, pad, canvas2.height / 2);
  const tex = new THREE.CanvasTexture(canvas2);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  const h = 3.2;
  sprite.scale.set((h * canvas2.width) / canvas2.height, h, 1);
  return sprite;
}

function buildIsochrones(scale) {
  const group = new THREE.Group();
  const mats = [];
  for (const min of [15, 30, 45, 60, 90, 120]) {
    const r = min * 60 * scale;
    const pts = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r));
    }
    const mat = new THREE.LineBasicMaterial({
      color: 0x39404e, transparent: true, opacity: 0.5, depthWrite: false,
    });
    mats.push(mat);
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));

    const label = makeLabel(`${min} min`);
    const a = Math.PI * 0.78;
    label.position.set(Math.sin(a) * r, 0.5, -Math.cos(a) * r);
    label.material.opacity = 0.55;
    mats.push(label.material);
    group.add(label);
  }
  group.userData.mats = mats;
  return group;
}

// ------------------------------------------------------- one-time setup
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x04060a);

const scene = new THREE.Scene();

// Fixed top-down plan view, pivoting on a point ~1.5 km west of the CBD.
// Zoom is framed per city to the peak extent and never rescales with the
// swell, so the ballooning reads at full size.
const CENTER = new THREE.Vector3(0, 0, 0);
const VIEW_HALF = WORLD_R * 0.82;
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, WORLD_R * 8);
camera.up.set(0, 0, -1); // north up

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enableRotate = false;
controls.screenSpacePanning = true;
controls.zoomToCursor = false;
controls.minZoom = 0.1;
controls.maxZoom = 30;

// brightness per class: motorway, m_link, trunk, t_link, primary, p_link, secondary, s_link
const uniforms = {
  uHour: { value: 7.5 },
  uWarp: { value: 1 },
  uUnit: { value: 1 },
  uTime: { value: 0 },
  uBright: { value: [1.0, 0.4, 0.85, 0.35, 0.62, 0.3, 0.42, 0.25] },
  uCatVis: { value: [1, 1, 0, 0] },
  // Peak displacement is amplified ×2.4 (?swell= to override) so congestion
  // reads as real curvature. The HUD ×N factor stays truthful.
  uSwell: { value: Math.min(4, Math.max(1, parseFloat(params.get('swell')) || 2.4)) },
};
const roadMat = new THREE.ShaderMaterial({
  uniforms, vertexShader, fragmentShader,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
});

const cbdLabel = makeLabel('· CBD', 30);
cbdLabel.position.set(0, 0.8, 0);
scene.add(cbdLabel);

// ------------------------------------------------------------ DOM state
const timeEl = document.getElementById('time-display');
const phaseEl = document.getElementById('phase-display');
const factorEl = document.getElementById('factor-display');
const scrub = document.getElementById('scrub');
const playBtn = document.getElementById('play');
const warpBtn = document.getElementById('warp');
const loaderEl = document.getElementById('loader');
const loaderMsg = document.getElementById('loader-msg');
const cityNameEl = document.getElementById('city-name');
const citySubEl = document.getElementById('city-sub');

// ?h=8.5 starts at 08:30, ?play=0 pauses — handy for sharing a moment.
let hour = Math.min(24, Math.max(0, parseFloat(params.get('h')) || 7.5));
let playing = params.get('play') !== '0';
let warpTarget = 1;
const DAY_SECONDS = 75; // one full day every 75 s
scrub.valueAsNumber = hour * 60;

// Route category filter: M and A signed routes by default (?cats=mabl to override).
const catStr = (params.get('cats') || 'ma').toLowerCase();
const catTargets = ['m', 'a', 'b', 'l'].map((c) => (catStr.includes(c) ? 1 : 0));
uniforms.uCatVis.value = [...catTargets];
document.querySelectorAll('#filters button').forEach((btn) => {
  const i = Number(btn.dataset.cat);
  btn.classList.toggle('active', catTargets[i] === 1);
  btn.addEventListener('click', () => {
    catTargets[i] = catTargets[i] ? 0 : 1;
    btn.classList.toggle('active', catTargets[i] === 1);
  });
});

// --------------------------------------------------------- city state
let data = null;
let uUnit = 1, timeScale = 1;
let meanRatio = { am: 1, mid: 1, pm: 1 };
let catMax = null;
let roads = null, rings = null;
let stripBase = null;

function disposeGroup(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
  scene.remove(g);
}

function frameCity() {
  let peakR = data.manifest.dRef;
  for (let i = 0; i < 4; i++) {
    if (!catTargets[i]) continue;
    const m = catMax[i];
    const rShow = m.rN + uniforms.uSwell.value * (Math.max(m.rA, m.rP) - m.rN);
    peakR = Math.max(peakR, rShow, m.rGeo);
  }
  const userZoom = Math.min(30, Math.max(0.1, parseFloat(params.get('zoom')) || 1));
  camera.zoom = Math.min(1, VIEW_HALF / (peakR * uUnit)) * userZoom;
  camera.updateProjectionMatrix();
}

async function setCity(city) {
  loaderEl.classList.remove('done');
  loaderMsg.textContent = `Plotting ${CITY_SUB[city]}`;
  data = await loadData(city);

  if (roads) disposeGroup(roads);
  if (rings) disposeGroup(rings);

  uUnit = WORLD_R / data.manifest.dRef;
  timeScale = WORLD_R / data.manifest.tRef;
  uniforms.uUnit.value = uUnit;

  // HUD mean ratios
  let sN = 0, sA = 0, sM = 0, sP = 0;
  for (let i = 0; i < data.t[0].length; i += 23) {
    if (data.t[0][i] < 30) continue;
    sN += data.t[0][i]; sA += data.t[1][i]; sM += data.t[2][i]; sP += data.t[3][i];
  }
  meanRatio = { am: sA / sN, mid: sM / sN, pm: sP / sN };

  // per-category reach (metres) for framing
  const S = data.manifest.posScale;
  catMax = Array.from({ length: 4 }, () => ({ rGeo: 0, rN: 0, rA: 0, rP: 0 }));
  {
    let base = 0;
    for (let s = 0; s < data.stripLen.length; s++) {
      const m = catMax[data.stripCat[s]];
      for (let i = base; i < base + data.stripLen[s]; i++) {
        const rg = Math.hypot(data.posGeo[i * 2], data.posGeo[i * 2 + 1]) * S;
        if (rg > m.rGeo) m.rGeo = rg;
        const rn = Math.hypot(data.pos[0][i * 2], data.pos[0][i * 2 + 1]) * S;
        if (rn > m.rN) m.rN = rn;
        const ra = Math.hypot(data.pos[1][i * 2], data.pos[1][i * 2 + 1]) * S;
        if (ra > m.rA) m.rA = ra;
        const rp = Math.hypot(data.pos[3][i * 2], data.pos[3][i * 2 + 1]) * S;
        if (rp > m.rP) m.rP = rp;
      }
      base += data.stripLen[s];
    }
  }

  roads = new THREE.LineSegments(buildRoads(data), roadMat);
  if (params.get('debug') === 'parts') roads.visible = false;
  scene.add(roads);
  rings = buildIsochrones(timeScale);
  scene.add(rings);

  CENTER.set(-1500 * uUnit, 0, 0);
  camera.position.set(CENTER.x, WORLD_R * 4, CENTER.z);
  camera.lookAt(CENTER);
  controls.target.copy(CENTER);
  frameCity();

  // particles: rebuild strip offsets and reseed
  stripBase = new Uint32Array(data.stripLen.length);
  let b = 0;
  for (let s = 0; s < data.stripLen.length; s++) { stripBase[s] = b; b += data.stripLen[s]; }
  candidatesKey = '';
  refreshCandidates(catTargets);
  for (const p of parts) { respawn(p); p.life = Math.random() * 4; }
  partAlpha.fill(0);

  // hover: re-allocate caches
  hoverPx = new Float32Array(data.manifest.vertexCount * 2);
  hoverBB = new Float32Array(data.stripLen.length * 4);
  hoverKey = '';
  tooltip.style.display = 'none';

  // chrome
  cityNameEl.textContent = data.manifest.label;
  citySubEl.textContent = CITY_SUB[city];
  document.querySelectorAll('#cities button').forEach((btn) =>
    btn.classList.toggle('active', btn.dataset.city === city)
  );
  const url = new URL(location);
  if (city === 'sydney') url.searchParams.delete('city');
  else url.searchParams.set('city', city);
  history.replaceState(null, '', url);

  loaderEl.classList.add('done');
}

document.querySelectorAll('#cities button').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!btn.classList.contains('active')) setCity(btn.dataset.city);
  });
});

// --------------------------------------------------------- flow particles
// Motes advected along the warped roads at time-lapse speed; they slow on
// congested segments, so the peaks read as crawling streams.
const N_PART = 2600;
const CLASS_WEIGHT = [4, 1.5, 3, 1, 2, 0.8, 1, 0.6];
const SPEED_KMH = [95, 60, 80, 50, 60, 45, 50, 40];
let candidates = [], candidatesKey = '';
function refreshCandidates(targets) {
  const key = targets.join('');
  if (key === candidatesKey) return;
  candidatesKey = key;
  candidates = [];
  for (let s = 0; s < data.stripLen.length; s++) {
    if (!targets[data.stripCat[s]] || data.stripLen[s] < 2) continue;
    const n = Math.ceil(CLASS_WEIGHT[data.stripClass[s]]);
    for (let k = 0; k < n; k++) candidates.push(s);
  }
}

// CPU mirror of the shader's position blend (sans wobble), metres.
function vertexXY(i, wA, wM, wP, warp, swell, out) {
  const S2 = data.manifest.posScale;
  const gx = data.posGeo[i * 2] * S2, gy = data.posGeo[i * 2 + 1] * S2;
  const nx = data.pos[0][i * 2] * S2, ny = data.pos[0][i * 2 + 1] * S2;
  const ax = data.pos[1][i * 2] * S2, ay = data.pos[1][i * 2 + 1] * S2;
  const mx = data.pos[2][i * 2] * S2, my = data.pos[2][i * 2 + 1] * S2;
  const px = data.pos[3][i * 2] * S2, py = data.pos[3][i * 2 + 1] * S2;
  const bx = nx + wA * (ax - nx) + wM * (mx - nx) + wP * (px - nx);
  const by = ny + wA * (ay - ny) + wM * (my - ny) + wP * (py - ny);
  const sx = nx + swell * (bx - nx), sy = ny + swell * (by - ny);
  out.x = gx + (sx - gx) * warp;
  out.y = gy + (sy - gy) * warp;
}

const parts = [];
function place(p) {
  const s = candidates[(Math.random() * candidates.length) | 0];
  p.s = s;
  p.seg = (Math.random() * (data.stripLen[s] - 1)) | 0;
  p.frac = Math.random();
  p.cat = data.stripCat[s];
  p.cls = data.stripClass[s];
  p.dir = Math.random() < 0.5 ? -1 : 1;
}
function respawn(p) {
  place(p);
  p.maxLife = 4 + Math.random() * 6;
  p.life = 0;
}
for (let i = 0; i < N_PART; i++) parts.push({ s: 0, seg: 0, frac: 0, life: 99, maxLife: 1, cat: 0, cls: 0, dir: 1 });

const partPos = new Float32Array(N_PART * 3);
const partAlpha = new Float32Array(N_PART);
const partGeo = new THREE.BufferGeometry();
partGeo.setAttribute('position', new THREE.BufferAttribute(partPos, 3));
partGeo.setAttribute('aAlpha', new THREE.BufferAttribute(partAlpha, 1));
partGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), WORLD_R * 6);
const partMat = new THREE.ShaderMaterial({
  uniforms: { uPx: { value: 2.6 * Math.min(devicePixelRatio, 2) } },
  vertexShader: /* glsl */ `
    attribute float aAlpha;
    uniform float uPx;
    varying float vA;
    void main() {
      vA = aAlpha;
      gl_PointSize = uPx;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    varying float vA;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      float a = vA * smoothstep(0.5, 0.12, d);
      if (a < 0.004) discard;
      gl_FragColor = vec4(vec3(1.0, 0.92, 0.78), a);
    }
  `,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
});
scene.add(new THREE.Points(partGeo, partMat));

const _pa = { x: 0, y: 0 }, _pb = { x: 0, y: 0 };
function updateParticles(dt) {
  refreshCandidates(catTargets);
  const wA = gauss(hour, PEAKS.am);
  const wM = gauss(hour, PEAKS.mid);
  const wP = gauss(hour, PEAKS.pm);
  const warp = uniforms.uWarp.value;
  const swell = uniforms.uSwell.value;
  // time-lapse-ish speed: fast enough to read as flow, slow enough to track
  const lapse = (86400 / DAY_SECONDS) * 0.12;
  for (let i = 0; i < N_PART; i++) {
    const p = parts[i];
    p.life += dt;
    if (p.life > p.maxLife || !catTargets[p.cat]) { respawn(p); continue; }
    const base = stripBase[p.s];
    const ia = base + p.seg, ib = ia + 1;
    vertexXY(ia, wA, wM, wP, warp, swell, _pa);
    vertexXY(ib, wA, wM, wP, warp, swell, _pb);
    const L = Math.max(20, Math.hypot(_pb.x - _pa.x, _pb.y - _pa.y));
    // local congestion: how much this segment's time gradient exceeds free-flow
    const dtN = Math.abs(data.t[0][ib] - data.t[0][ia]);
    const tcur = (j) =>
      data.t[0][j] + wA * (data.t[1][j] - data.t[0][j]) +
      wM * (data.t[2][j] - data.t[0][j]) + wP * (data.t[3][j] - data.t[0][j]);
    const ratio = dtN > 0.5
      ? Math.min(4, Math.max(1, Math.abs(tcur(ib) - tcur(ia)) / dtN))
      : 1;
    const v = ((SPEED_KMH[p.cls] / 3.6) * lapse) / ratio;
    p.frac += (p.dir * v * dt) / L;
    while (p.frac > 1 || p.frac < 0) {
      p.seg += p.dir;
      if (p.seg < 0 || p.seg >= data.stripLen[p.s] - 1) { place(p); break; } // hop
      p.frac += p.frac > 1 ? -1 : 1;
    }
    const f = Math.min(1, Math.max(0, p.frac));
    partPos[i * 3] = (_pa.x + f * (_pb.x - _pa.x)) * uUnit;
    partPos[i * 3 + 1] = 0.4;
    partPos[i * 3 + 2] = -(_pa.y + f * (_pb.y - _pa.y)) * uUnit;
    const fade = Math.min(1, Math.min(p.life, p.maxLife - p.life) / 1.0);
    partAlpha[i] = 0.5 * fade * uniforms.uCatVis.value[p.cat] * warp;
  }
  partGeo.attributes.position.needsUpdate = true;
  partGeo.attributes.aAlpha.needsUpdate = true;
}

// --------------------------------------------------------- hover inspector
// Time is frozen while paused, so drive times are stable — hovering a road
// shows its name, suburb, and the current drive time to the CBD.
const tooltip = document.getElementById('tooltip');
const tipRoad = tooltip.querySelector('.road');
const tipMeta = tooltip.querySelector('.meta');
const hintEl = document.getElementById('hint');
const CLASS_LABEL = [
  'Motorway', 'Motorway ramp', 'Trunk road', 'Trunk ramp',
  'Primary road', 'Primary ramp', 'Secondary road', 'Secondary ramp',
];

let hoverPx = null, hoverBB = null, hoverKey = '';
function buildHoverCache() {
  const key = `${hour.toFixed(3)}|${uniforms.uWarp.value.toFixed(2)}|${catTargets.join('')}`;
  if (key === hoverKey) return;
  hoverKey = key;
  const wA = gauss(hour, PEAKS.am), wM = gauss(hour, PEAKS.mid), wP = gauss(hour, PEAKS.pm);
  const warp = uniforms.uWarp.value, swell = uniforms.uSwell.value;
  let base = 0;
  for (let s = 0; s < data.stripLen.length; s++) {
    const n = data.stripLen[s];
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (let i = base; i < base + n; i++) {
      vertexXY(i, wA, wM, wP, warp, swell, _pa);
      hoverPx[i * 2] = _pa.x;
      hoverPx[i * 2 + 1] = _pa.y;
      if (_pa.x < minx) minx = _pa.x;
      if (_pa.x > maxx) maxx = _pa.x;
      if (_pa.y < miny) miny = _pa.y;
      if (_pa.y > maxy) maxy = _pa.y;
    }
    hoverBB[s * 4] = minx; hoverBB[s * 4 + 1] = miny;
    hoverBB[s * 4 + 2] = maxx; hoverBB[s * 4 + 3] = maxy;
    base += n;
  }
}

const _unproj = new THREE.Vector3();
function pickRoad(clientX, clientY) {
  buildHoverCache();
  _unproj.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1, 0);
  _unproj.unproject(camera);
  const mx = _unproj.x / uUnit, my = -_unproj.z / uUnit; // metres
  const worldPerPx = (camera.right - camera.left) / (camera.zoom * innerWidth);
  const tol = (12 * worldPerPx) / uUnit;

  let best = null, bestD = tol;
  let base = 0;
  for (let s = 0; s < data.stripLen.length; s++) {
    const n = data.stripLen[s];
    if (catTargets[data.stripCat[s]] &&
        mx >= hoverBB[s * 4] - tol && my >= hoverBB[s * 4 + 1] - tol &&
        mx <= hoverBB[s * 4 + 2] + tol && my <= hoverBB[s * 4 + 3] + tol) {
      for (let i = base; i < base + n - 1; i++) {
        const ax = hoverPx[i * 2], ay = hoverPx[i * 2 + 1];
        const bx = hoverPx[i * 2 + 2], by = hoverPx[i * 2 + 3];
        const dx = bx - ax, dy = by - ay;
        const L2 = dx * dx + dy * dy;
        const u = L2 > 0 ? Math.min(1, Math.max(0, ((mx - ax) * dx + (my - ay) * dy) / L2)) : 0;
        const d = Math.hypot(mx - (ax + u * dx), my - (ay + u * dy));
        if (d < bestD) { bestD = d; best = { s, i, u }; }
      }
    }
    base += n;
  }
  return best;
}

let hintShown = false, hintTimer = 0;
function showHint() {
  if (hintShown) return;
  hintShown = true;
  hintEl.classList.add('show');
  hintTimer = setTimeout(() => hintEl.classList.remove('show'), 5000);
}
function dismissHint() {
  hintEl.classList.remove('show');
  clearTimeout(hintTimer);
}

canvas.addEventListener('pointermove', (ev) => {
  if (playing || !data || ev.buttons !== 0) { tooltip.style.display = 'none'; return; }
  const hit = pickRoad(ev.clientX, ev.clientY);
  if (!hit) { tooltip.style.display = 'none'; return; }
  dismissHint();
  const { s, i, u } = hit;
  const wA = gauss(hour, PEAKS.am), wM = gauss(hour, PEAKS.mid), wP = gauss(hour, PEAKS.pm);
  const tcur = (j) =>
    data.t[0][j] + wA * (data.t[1][j] - data.t[0][j]) +
    wM * (data.t[2][j] - data.t[0][j]) + wP * (data.t[3][j] - data.t[0][j]);
  const mins = (tcur(i) + u * (tcur(i + 1) - tcur(i))) / 60;
  const name = data.manifest.names[data.stripName[s]] || CLASS_LABEL[data.stripClass[s]];
  const suburb = data.manifest.suburbs[data.stripSuburb[s]];
  tipRoad.textContent = name;
  tipMeta.innerHTML = `${suburb ? suburb + ' · ' : ''}<b>≈ ${mins < 9.5 ? mins.toFixed(1) : Math.round(mins)} min</b> to CBD`;
  tooltip.style.display = 'block';
  tooltip.style.left = `${Math.min(ev.clientX + 16, innerWidth - 300)}px`;
  tooltip.style.top = `${Math.min(ev.clientY + 16, innerHeight - 80)}px`;
});
canvas.addEventListener('pointerleave', () => { tooltip.style.display = 'none'; });

// ------------------------------------------------------------ controls
// Pausing freezes time, which makes roads inspectable: the cursor becomes a
// crosshair and a hint surfaces once — the interface teaches itself.
function onPlayState() {
  playBtn.textContent = playing ? 'Pause' : 'Play';
  playBtn.classList.toggle('active', playing);
  canvas.style.cursor = playing ? '' : 'crosshair';
  if (playing) {
    tooltip.style.display = 'none';
    dismissHint();
  } else {
    showHint();
  }
}
playBtn.addEventListener('click', () => {
  playing = !playing;
  onPlayState();
});
warpBtn.addEventListener('click', () => {
  warpTarget = warpTarget === 1 ? 0 : 1;
  warpBtn.textContent = warpTarget === 1 ? 'Time-warp' : 'Geographic';
  warpBtn.classList.toggle('active', warpTarget === 1);
});
scrub.addEventListener('input', () => { hour = scrub.valueAsNumber / 60; });

function phaseFor(h) {
  if (h < 5) return ['Night', '#5a6376'];
  if (h < 6.5) return ['First light', '#8a93a6'];
  if (h < 9.75) return ['Morning peak', '#ff4f40'];
  if (h < 15.5) return ['Midday', '#ffb347'];
  if (h < 16.5) return ['Building', '#ffb347'];
  if (h < 19.25) return ['Evening peak', '#ff4f40'];
  if (h < 22) return ['Winding down', '#8a93a6'];
  return ['Night', '#5a6376'];
}

function updateHud() {
  const hh = String(Math.floor(hour) % 24).padStart(2, '0');
  const mm = String(Math.floor((hour % 1) * 60)).padStart(2, '0');
  timeEl.textContent = `${hh}:${mm}`;
  const [label, color] = phaseFor(hour);
  phaseEl.textContent = label;
  phaseEl.style.color = color;
  const f =
    1 +
    gauss(hour, PEAKS.am) * (meanRatio.am - 1) +
    gauss(hour, PEAKS.mid) * (meanRatio.mid - 1) +
    gauss(hour, PEAKS.pm) * (meanRatio.pm - 1);
  factorEl.innerHTML = `network <b>×${f.toFixed(2)}</b> free-flow`;
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  const aspect = w / h;
  camera.left = -VIEW_HALF * aspect;
  camera.right = VIEW_HALF * aspect;
  camera.top = VIEW_HALF;
  camera.bottom = -VIEW_HALF;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ----------------------------------------------------------------- boot
const startCity = ['sydney', 'melbourne', 'brisbane'].includes(params.get('city'))
  ? params.get('city')
  : 'sydney';
await setCity(startCity);
onPlayState();

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (playing) {
    hour = (hour + (dt * 24) / DAY_SECONDS) % 24;
    scrub.valueAsNumber = hour * 60;
  }
  uniforms.uHour.value = hour;
  uniforms.uTime.value = clock.elapsedTime;
  uniforms.uWarp.value += (warpTarget - uniforms.uWarp.value) * Math.min(1, dt * 4);
  for (let i = 0; i < 4; i++) {
    const cv = uniforms.uCatVis.value;
    cv[i] += (catTargets[i] - cv[i]) * Math.min(1, dt * 6);
  }
  // isochrone rings only mean something in time-space
  const w = uniforms.uWarp.value;
  for (const m of rings.userData.mats) m.opacity = m.isSpriteMaterial ? 0.55 * w : 0.5 * w;
  updateParticles(dt);
  updateHud();
  controls.update();
  renderer.render(scene, camera);
});

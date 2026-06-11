// Sydney Time Warp — roads positioned so distance from the CBD = drive time.
// The pipeline precomputes an elastic (diffusion-warped) embedding per
// congestion profile; the vertex shader blends those embeddings through the
// day, so the city deforms like a soft sheet. JS only advances the clock.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const WORLD_R = 110; // world units the night-time map roughly spans

// Gaussian day-curve: how strongly each congestion profile applies at hour h.
// Mirrored in the vertex shader — keep in sync.
const PEAKS = { am: [8.25, 1.4], mid: [13.0, 2.8], pm: [17.5, 1.7] };
const gauss = (h, [c, s]) => Math.exp(-0.5 * ((h - c) / s) ** 2);

const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------- data
async function loadData() {
  const [manifest, bin] = await Promise.all([
    fetch('data/manifest.json').then((r) => r.json()),
    fetch('data/sydney.bin').then((r) => r.arrayBuffer()),
  ]);
  const view = (Type, name) =>
    new Type(bin, manifest.layout[name].offset, manifest.layout[name].length);
  return {
    manifest,
    stripClass: view(Uint8Array, 'stripClass'),
    stripCat: view(Uint8Array, 'stripCat'),
    stripLen: view(Uint16Array, 'stripLen'),
    posGeo: view(Int16Array, 'posGeo'),
    pos: ['night', 'am', 'mid', 'pm'].map((n) => view(Int16Array, `pos_${n}`)),
    t: ['night', 'am', 'mid', 'pm'].map((n) => view(Uint16Array, `t_${n}`)),
  };
}

// ------------------------------------------------------------ geometry
// Strips → LineSegments. position = (geoX, geoY, meta) in metres,
// meta = class + 16 × category. aP01 = night/am positions, aP23 = mid/pm,
// aTimes = 4 profile drive-times (for colour).
function buildRoads(data) {
  const { stripClass, stripCat, stripLen, posGeo, pos, t, manifest } = data;
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
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `300 ${size}px 'Spline Sans Mono', monospace`;
  canvas.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvas.height = size + pad * 2;
  const c2 = canvas.getContext('2d');
  c2.font = `300 ${size}px 'Spline Sans Mono', monospace`;
  c2.fillStyle = 'rgba(232, 228, 216, 0.6)';
  c2.textBaseline = 'middle';
  c2.fillText(text, pad, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  const h = 3.2;
  sprite.scale.set((h * canvas.width) / canvas.height, h, 1);
  return sprite;
}

function buildIsochrones(timeScale) {
  const group = new THREE.Group();
  const mats = [];
  for (const min of [15, 30, 45, 60, 90, 120]) {
    const r = min * 60 * timeScale;
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
    const a = Math.PI * 0.78; // labels up the NE radial
    label.position.set(Math.sin(a) * r, 0.5, -Math.cos(a) * r);
    label.material.opacity = 0.55;
    mats.push(label.material);
    group.add(label);
  }
  group.userData.mats = mats;
  return group;
}

// ----------------------------------------------------------------- app
const data = await loadData();
document.getElementById('loader-msg').textContent =
  `Plotting ${data.manifest.vertexCount.toLocaleString()} points`;

const S = data.manifest.posScale;
const uUnit = WORLD_R / data.manifest.dRef;   // world units per metre
const timeScale = WORLD_R / data.manifest.tRef; // world units per second (rings)

// Mean profile ratios for the HUD "×N free-flow" readout.
let sN = 0, sA = 0, sM = 0, sP = 0;
for (let i = 0; i < data.t[0].length; i += 23) {
  if (data.t[0][i] < 30) continue;
  sN += data.t[0][i]; sA += data.t[1][i]; sM += data.t[2][i]; sP += data.t[3][i];
}
const meanRatio = { am: sA / sN, mid: sM / sN, pm: sP / sN };

// Per-category reach (metres) under each profile, for the static framing.
const catMax = Array.from({ length: 4 }, () => ({ rGeo: 0, rN: 0, rA: 0, rP: 0 }));
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

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x04060a);

const scene = new THREE.Scene();

// Fixed top-down plan view, pivoting on a point ~1.5 km west of the CBD.
// The zoom is static (set once, below, to frame the peak extent): the camera
// never rescales with the swell, so the ballooning reads at full size.
const CENTER = new THREE.Vector3(-1500 * uUnit, 0, 0);
const VIEW_HALF = WORLD_R * 0.82; // vertical half-extent of the frustum
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, WORLD_R * 8);
camera.position.set(CENTER.x, WORLD_R * 4, CENTER.z);
camera.up.set(0, 0, -1); // north up
camera.lookAt(CENTER);

const controls = new OrbitControls(camera, canvas);
controls.target.copy(CENTER);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enableRotate = false; // plan view stays plan view
controls.screenSpacePanning = true;
controls.zoomToCursor = false; // zoom always pivots on the centre
controls.minZoom = 0.1;
controls.maxZoom = 30;

// brightness per class: motorway, m_link, trunk, t_link, primary, p_link, secondary, s_link
const uniforms = {
  uHour: { value: 7.5 },
  uWarp: { value: 1 },
  uUnit: { value: uUnit },
  uTime: { value: 0 },
  uBright: { value: [1.0, 0.4, 0.85, 0.35, 0.62, 0.3, 0.42, 0.25] },
  uCatVis: { value: [1, 1, 0, 0] }, // M and A routes on by default
  // Peak displacement is amplified ×2.4 (?swell= to override) so congestion
  // reads as real curvature. The HUD ×N factor stays truthful.
  uSwell: { value: Math.min(4, Math.max(1, parseFloat(params.get('swell')) || 2.4)) },
};
const roads = new THREE.LineSegments(
  buildRoads(data),
  new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  })
);
scene.add(roads);

const rings = buildIsochrones(timeScale);
scene.add(rings);

// CBD marker
const cbd = makeLabel('· CBD', 30);
cbd.position.set(0, 0.8, 0);
scene.add(cbd);

// ------------------------------------------------------------ controls
const timeEl = document.getElementById('time-display');
const phaseEl = document.getElementById('phase-display');
const factorEl = document.getElementById('factor-display');
const scrub = document.getElementById('scrub');
const playBtn = document.getElementById('play');
const warpBtn = document.getElementById('warp');

// ?h=8.5 starts at 08:30, ?play=0 pauses — handy for sharing a moment.
let hour = Math.min(24, Math.max(0, parseFloat(params.get('h')) || 7.5));
let playing = params.get('play') !== '0';
let warpTarget = 1;
const DAY_SECONDS = 75; // one full day every 75 s
scrub.valueAsNumber = hour * 60;
playBtn.textContent = playing ? 'Pause' : 'Play';
playBtn.classList.toggle('active', playing);

playBtn.addEventListener('click', () => {
  playing = !playing;
  playBtn.textContent = playing ? 'Pause' : 'Play';
  playBtn.classList.toggle('active', playing);
});
warpBtn.addEventListener('click', () => {
  warpTarget = warpTarget === 1 ? 0 : 1;
  warpBtn.textContent = warpTarget === 1 ? 'Time-warp' : 'Geographic';
  warpBtn.classList.toggle('active', warpTarget === 1);
});
scrub.addEventListener('input', () => { hour = scrub.valueAsNumber / 60; });

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

// Static framing: fit the peak (swollen) extent of the categories visible at
// load. Set once — day-cycle growth then plays out on screen at full size.
// ?zoom= multiplies on top (handy for close inspection).
{
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
  updateHud();
  controls.update();
  renderer.render(scene, camera);
});

document.getElementById('loader').classList.add('done');

// Sydney Time Warp — roads positioned so distance from the CBD = drive time.
// All warping happens in the vertex shader; JS only advances the clock.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const WORLD_R = 110; // world units the night-time map roughly spans

// Gaussian day-curve: how strongly each congestion profile applies at hour h.
// Mirrored in the vertex shader — keep in sync.
const PEAKS = { am: [8.25, 1.4], mid: [13.0, 2.8], pm: [17.5, 1.7] };
const gauss = (h, [c, s]) => Math.exp(-0.5 * ((h - c) / s) ** 2);

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
    theta: view(Float32Array, 'theta'),
    distGeo: view(Uint16Array, 'distGeo'),
    tN: view(Uint16Array, 't_night'),
    tA: view(Uint16Array, 't_am'),
    tM: view(Uint16Array, 't_mid'),
    tP: view(Uint16Array, 't_pm'),
    coastStripLen: view(Uint16Array, 'coastStripLen'),
    coastTheta: view(Float32Array, 'coastTheta'),
    coastDist: view(Uint16Array, 'coastDist'),
    coastT: ['night', 'am', 'mid', 'pm'].map((n) => view(Uint16Array, `coastT_${n}`)),
  };
}

function percentile(arr, p, stride = 37) {
  const sample = [];
  for (let i = 0; i < arr.length; i += stride) sample.push(arr[i]);
  sample.sort((a, b) => a - b);
  return sample[Math.floor(sample.length * p)];
}

// ------------------------------------------------------------ geometry
// Turns strip arrays into LineSegments geometry.
// position = (theta, distance in metres, meta) where meta = class + 16 × category.
function buildStrips({ stripLen, theta, dist, times, meta, distUnit }) {
  let segVerts = 0;
  for (let s = 0; s < stripLen.length; s++) segVerts += (stripLen[s] - 1) * 2;

  const pos = new Float32Array(segVerts * 3);
  const tAttr = new Float32Array(segVerts * 4);

  let v = 0, base = 0;
  for (let s = 0; s < stripLen.length; s++) {
    const n = stripLen[s], m = meta ? meta(s) : 0;
    for (let i = 0; i < n - 1; i++) {
      for (const j of [base + i, base + i + 1]) {
        pos[v * 3] = theta[j];
        pos[v * 3 + 1] = dist[j] * distUnit;
        pos[v * 3 + 2] = m;
        for (let k = 0; k < 4; k++) tAttr[v * 4 + k] = times[k][j];
        v++;
      }
    }
    base += n;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aTimes', new THREE.BufferAttribute(tAttr, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), WORLD_R * 4);
  return geo;
}

const vertexShader = /* glsl */ `
  attribute vec4 aTimes;
  uniform float uHour, uWarp, uGeoScale, uTimeScale;
  uniform float uBright[8];
  uniform float uCatVis[4];
  varying vec3 vColor;
  varying float vAlpha;

  float g(float h, float c, float s) { float d = h - c; return exp(-0.5 * d * d / (s * s)); }

  void main() {
    float theta = position.x;
    float dist  = position.y;
    int   meta  = int(position.z + 0.5);
    int   cls   = meta - (meta / 16) * 16;
    int   cat   = meta / 16;

    float tN = aTimes.x, tA = aTimes.y, tM = aTimes.z, tP = aTimes.w;
    float wA = g(uHour, 8.25, 1.4);
    float wM = g(uHour, 13.0, 2.8);
    float wP = g(uHour, 17.5, 1.7);
    float t = tN + wA * (tA - tN) + wM * (tM - tN) + wP * (tP - tN);

    float r = mix(dist * uGeoScale, t * uTimeScale, uWarp);
    vec3 p = vec3(sin(theta) * r, 0.0, -cos(theta) * r);

    #ifdef FLAT_COAST
      vColor = vec3(0.42, 0.46, 0.52);
      vAlpha = 0.22;
    #else
      // congestion: how much slower than free-flow this point currently is
      float ratio = t / max(tN, 1.0);
      float c = clamp((ratio - 1.0) / 1.1, 0.0, 1.0);
      vec3 cool  = vec3(0.16, 0.42, 0.88);
      vec3 amber = vec3(1.00, 0.64, 0.20);
      vec3 ember = vec3(1.00, 0.16, 0.22);
      vec3 col = c < 0.5 ? mix(cool, amber, c * 2.0) : mix(amber, ember, c * 2.0 - 1.0);

      float bright = uBright[cls];
      vColor = col * bright;
      vAlpha = (0.32 + 0.45 * bright) * uCatVis[cat];
    #endif

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

// Scales: night-time map spans ~WORLD_R; geographic map matches it in size.
const tRef = percentile(data.tN, 0.995);
const dRef = percentile(data.distGeo, 0.995) * data.manifest.distUnit;
const timeScale = WORLD_R / tRef;
const geoScale = WORLD_R / dRef;

// Mean profile ratios for the HUD "×N free-flow" readout.
let sN = 0, sA = 0, sM = 0, sP = 0, count = 0;
for (let i = 0; i < data.tN.length; i += 23) {
  if (data.tN[i] < 30) continue;
  sN += data.tN[i]; sA += data.tA[i]; sM += data.tM[i]; sP += data.tP[i]; count++;
}
const meanRatio = { am: sA / sN, mid: sM / sN, pm: sP / sN };

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x04060a);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x04060a, WORLD_R * 2.4, WORLD_R * 5.5);

const camera = new THREE.PerspectiveCamera(46, 1, 1, WORLD_R * 12);
// Sydney's network mass sits west of the CBD (the coast is east) — aim there.
const CENTER = new THREE.Vector3(-WORLD_R * 0.3, 0, -WORLD_R * 0.05);
camera.position.set(CENTER.x, WORLD_R * 1.55, CENTER.z + WORLD_R * 0.95);

const controls = new OrbitControls(camera, canvas);
controls.target.copy(CENTER);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = 1.42;
controls.minDistance = WORLD_R * 0.25;
controls.maxDistance = WORLD_R * 4;

// brightness per class: motorway, m_link, trunk, t_link, primary, p_link, secondary, s_link
const uniforms = {
  uHour: { value: 7.5 },
  uWarp: { value: 1 },
  uGeoScale: { value: geoScale },
  uTimeScale: { value: timeScale },
  uBright: { value: [1.0, 0.4, 0.85, 0.35, 0.62, 0.3, 0.42, 0.25] },
  uCatVis: { value: [1, 1, 0, 0] }, // M and A routes on by default
};
const roadGeo = buildStrips({
  stripLen: data.stripLen,
  theta: data.theta,
  dist: data.distGeo,
  times: [data.tN, data.tA, data.tM, data.tP],
  meta: (s) => data.stripClass[s] + 16 * data.stripCat[s],
  distUnit: data.manifest.distUnit,
});
const roads = new THREE.LineSegments(
  roadGeo,
  new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  })
);
scene.add(roads);

// Land/water border, warped with the network — faint gray geographic anchor.
const coast = new THREE.LineSegments(
  buildStrips({
    stripLen: data.coastStripLen,
    theta: data.coastTheta,
    dist: data.coastDist,
    times: data.coastT,
    meta: null,
    distUnit: data.manifest.distUnit,
  }),
  new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader,
    defines: { FLAT_COAST: 1 },
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  })
);
scene.add(coast);

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
const params = new URLSearchParams(location.search);
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
  camera.aspect = w / h;
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

// Builds the visualisation dataset from the raw Overpass response.
//
// 1. Split OSM ways into edges at junction nodes (nodes shared by ≥2 ways).
// 2. Dijkstra from the junction nearest the CBD under 4 congestion profiles
//    (night free-flow, AM peak, midday, PM peak). Congestion = per-road-class
//    travel-time multipliers, modelled on TfNSW traffic volume patterns.
// 3. For every geometry vertex on a reachable edge, emit: bearing from CBD,
//    geographic distance, and drive-time seconds under each profile.
//    Intermediate vertices get min(tA + along, tB + remaining) — the true
//    shortest time assuming entry via either endpoint.
//
// Output: data/sydney.bin (struct-of-arrays binary) + data/manifest.json.

import { readFile, writeFile } from 'node:fs/promises';

const CBD = { lat: -33.8688, lon: 151.2093 }; // Sydney Town Hall, near enough

const CLASSES = [
  'motorway', 'motorway_link', 'trunk', 'trunk_link',
  'primary', 'primary_link', 'secondary', 'secondary_link',
];
const CLASS_INDEX = new Map(CLASSES.map((c, i) => [c, i]));

// Free-flow speed, km/h, by class index.
const SPEED = [95, 60, 80, 50, 60, 45, 50, 40];

// Travel-time multipliers per profile, by class index. Motorways and arterials
// degrade most in the peaks; the PM peak hits surface streets slightly harder.
const PROFILES = {
  night: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
  am:    [2.1, 1.8, 2.0, 1.7, 1.95, 1.6, 1.75, 1.5],
  mid:   [1.3, 1.2, 1.25, 1.2, 1.25, 1.15, 1.2, 1.15],
  pm:    [2.0, 1.75, 1.9, 1.65, 1.9, 1.6, 1.85, 1.55],
};
const PROFILE_NAMES = ['night', 'am', 'mid', 'pm'];

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const M_PER_DEG_LAT = 111320;
const mPerDegLon = M_PER_DEG_LAT * Math.cos(rad(CBD.lat));

function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Local planar offset from CBD in metres (east, north).
function planar(p) {
  return {
    x: (p.lon - CBD.lon) * mPerDegLon,
    y: (p.lat - CBD.lat) * M_PER_DEG_LAT,
  };
}

console.log('Loading raw data...');
const raw = JSON.parse(
  await readFile(new URL('../data/raw/sydney-roads.json', import.meta.url), 'utf8')
);
const ways = raw.elements.filter(
  (e) => e.type === 'way' && e.nodes && e.geometry && CLASS_INDEX.has(e.tags?.highway)
);
console.log(`${ways.length} usable ways`);

// --- 1. Find junctions: nodes used by ≥2 ways, plus every way's endpoints ---
const nodeUse = new Map();
for (const w of ways)
  for (const id of w.nodes) nodeUse.set(id, (nodeUse.get(id) || 0) + 1);

const isJunction = (w, i) =>
  i === 0 || i === w.nodes.length - 1 || nodeUse.get(w.nodes[i]) >= 2;

// --- 2. Split ways into edges between junctions ---
// Edge: { a, b: junction node ids, cls, len, pts: [{lat,lon}...], cum: [m...] }
const edges = [];
const junctionPos = new Map(); // node id -> {lat, lon}

for (const w of ways) {
  const cls = CLASS_INDEX.get(w.tags.highway);
  let start = 0;
  for (let i = 1; i < w.nodes.length; i++) {
    if (!isJunction(w, i)) continue;
    const pts = w.geometry.slice(start, i + 1);
    if (pts.length >= 2) {
      const cum = [0];
      for (let j = 1; j < pts.length; j++)
        cum.push(cum[j - 1] + haversine(pts[j - 1], pts[j]));
      const len = cum[cum.length - 1];
      if (len > 0) {
        const a = w.nodes[start], b = w.nodes[i];
        edges.push({ a, b, cls, len, pts, cum });
        junctionPos.set(a, pts[0]);
        junctionPos.set(b, pts[pts.length - 1]);
      }
    }
    start = i;
  }
}
console.log(`${edges.length} edges, ${junctionPos.size} junctions`);

// --- 3. Adjacency + Dijkstra (binary heap) per profile ---
const ids = [...junctionPos.keys()];
const idx = new Map(ids.map((id, i) => [id, i]));
const N = ids.length;
const adj = Array.from({ length: N }, () => []);
for (let e = 0; e < edges.length; e++) {
  const { a, b } = edges[e];
  adj[idx.get(a)].push({ to: idx.get(b), e });
  adj[idx.get(b)].push({ to: idx.get(a), e });
}

let srcIdx = 0, srcBest = Infinity;
for (let i = 0; i < N; i++) {
  const d = haversine(junctionPos.get(ids[i]), CBD);
  if (d < srcBest) { srcBest = d; srcIdx = i; }
}
console.log(`Source junction ${ids[srcIdx]}, ${Math.round(srcBest)} m from CBD`);

function dijkstra(mult) {
  const dist = new Float64Array(N).fill(Infinity);
  dist[srcIdx] = 0;
  // binary min-heap of [time, node]
  const heap = [[0, srcIdx]];
  const swap = (i, j) => { const t = heap[i]; heap[i] = heap[j]; heap[j] = t; };
  const push = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      swap(i, p); i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        swap(i, m); i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [t, u] = pop();
    if (t > dist[u]) continue;
    for (const { to, e } of adj[u]) {
      const edge = edges[e];
      const w = (edge.len / (SPEED[edge.cls] / 3.6)) * mult[edge.cls];
      if (t + w < dist[to]) { dist[to] = t + w; push([t + w, to]); }
    }
  }
  return dist;
}

const times = {};
for (const name of PROFILE_NAMES) {
  console.log(`Dijkstra: ${name}`);
  times[name] = dijkstra(PROFILES[name]);
}

// --- 4. Emit per-vertex records for reachable edges ---
const reachable = (e) =>
  isFinite(times.night[idx.get(e.a)]) && isFinite(times.night[idx.get(e.b)]);

const kept = edges.filter(reachable);
const totalVerts = kept.reduce((s, e) => s + e.pts.length, 0);
console.log(`${kept.length} reachable edges, ${totalVerts} vertices`);

const stripClass = new Uint8Array(kept.length);
const stripLen = new Uint16Array(kept.length);
const theta = new Float32Array(totalVerts);
const distGeo = new Uint16Array(totalVerts); // metres / 4
const tArr = PROFILE_NAMES.map(() => new Uint16Array(totalVerts)); // seconds

let v = 0, maxT = 0, maxD = 0;
kept.forEach((e, s) => {
  stripClass[s] = e.cls;
  stripLen[s] = e.pts.length;
  const ia = idx.get(e.a), ib = idx.get(e.b);
  for (let j = 0; j < e.pts.length; j++) {
    const p = planar(e.pts[j]);
    theta[v] = Math.atan2(p.x, p.y); // bearing: 0 = north, clockwise
    const d = Math.hypot(p.x, p.y);
    distGeo[v] = Math.min(65535, Math.round(d / 4));
    maxD = Math.max(maxD, d);
    for (let k = 0; k < PROFILE_NAMES.length; k++) {
      const name = PROFILE_NAMES[k];
      const tau = (e.len / (SPEED[e.cls] / 3.6)) * PROFILES[name][e.cls];
      const along = e.len > 0 ? e.cum[j] / e.len : 0;
      const t = Math.min(
        times[name][ia] + tau * along,
        times[name][ib] + tau * (1 - along)
      );
      tArr[k][v] = Math.min(65535, Math.round(t));
      maxT = Math.max(maxT, t);
    }
    v++;
  }
});

// --- 5. Write binary (sections, each aligned) + manifest ---
const sections = [
  ['stripClass', stripClass],
  ['stripLen', stripLen],
  ['theta', theta],
  ['distGeo', distGeo],
  ...PROFILE_NAMES.map((n, k) => [`t_${n}`, tArr[k]]),
];
const align = (n) => Math.ceil(n / 4) * 4;
let offset = 0;
const layout = {};
for (const [name, arr] of sections) {
  layout[name] = { offset, length: arr.length };
  offset = align(offset + arr.byteLength);
}
const buf = Buffer.alloc(offset);
for (const [name, arr] of sections)
  Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).copy(buf, layout[name].offset);

await writeFile(new URL('../data/sydney.bin', import.meta.url), buf);

const manifest = {
  generated: new Date().toISOString(),
  source: 'OpenStreetMap via Overpass API (ODbL)',
  cbd: CBD,
  classes: CLASSES,
  profiles: PROFILE_NAMES,
  stripCount: kept.length,
  vertexCount: totalVerts,
  distUnit: 4,            // distGeo is metres / 4
  maxDistance: Math.round(maxD),
  maxTime: Math.round(maxT), // seconds
  layout,
  byteLength: offset,
};
await writeFile(
  new URL('../data/manifest.json', import.meta.url),
  JSON.stringify(manifest, null, 2)
);

console.log(`Wrote data/sydney.bin (${(offset / 1e6).toFixed(1)} MB)`);
console.log(`Max drive time ${(maxT / 60).toFixed(0)} min, max distance ${(maxD / 1000).toFixed(0)} km`);

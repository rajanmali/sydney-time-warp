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

// Peak travel-time multipliers per profile, by class index. These are the
// *ceiling* for each class; the multiplier actually applied to an edge is
// scaled by where it sits (ring distance from the CBD) and which corridor it
// belongs to, so congestion balloons specific corridors instead of inflating
// the whole map uniformly.
const PROFILES = {
  night: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
  am:    [2.4, 2.0, 2.3, 1.9, 2.25, 1.8, 2.0, 1.7],
  mid:   [1.35, 1.25, 1.3, 1.25, 1.3, 1.2, 1.25, 1.2],
  pm:    [2.3, 1.95, 2.2, 1.85, 2.2, 1.8, 2.1, 1.75],
};
const PROFILE_NAMES = ['night', 'am', 'mid', 'pm'];

// NSW route categories from OSM ref tags: M (motorways), A (arterials),
// B (regional), and everything unsigned.
const CATEGORIES = ['M', 'A', 'B', 'other'];
function categoryOf(tags) {
  const ref = tags.ref || '';
  if (/\bM\d/.test(ref)) return 0;
  if (/\bA\d/.test(ref)) return 1;
  if (/\bB\d/.test(ref)) return 2;
  if (tags.highway.startsWith('motorway')) return 0; // unsigned motorway ramps etc.
  return 3;
}

// Where congestion bites: a ring profile peaking in the 6–18 km middle
// suburbs, easing off in the compact core and the metro fringe.
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const ringFactor = (dKm) =>
  0.3 + 0.7 * (smooth(1.5, 6, dKm) * (1 - smooth(18, 45, dKm)));

// Deterministic per-corridor variation so parallel routes degrade
// differently — this is what makes the warp lumpy rather than concentric.
function corridorFactor(tags, id) {
  const key = tags.ref || tags.name || String(id);
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 0.7 + 0.6 * (((h >>> 0) % 1000) / 1000);
}

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
// Edge: { a, b: junction node ids, cls, cat, len, pts, cum,
//         tt: per-profile traversal seconds with spatial congestion applied }
const edges = [];
const junctionPos = new Map(); // node id -> {lat, lon}

for (const w of ways) {
  const cls = CLASS_INDEX.get(w.tags.highway);
  const cat = categoryOf(w.tags);
  const corridor = corridorFactor(w.tags, w.id);
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
        const mid = pts[Math.floor(pts.length / 2)];
        const spatial = ringFactor(haversine(mid, CBD) / 1000) * corridor;
        const freeFlow = len / (SPEED[cls] / 3.6);
        const tt = PROFILE_NAMES.map((n) => {
          const mult = Math.max(1, 1 + (PROFILES[n][cls] - 1) * spatial);
          return freeFlow * mult;
        });
        edges.push({ a, b, cls, cat, len, pts, cum, tt });
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

function dijkstra(profileIdx) {
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
      const w = edges[e].tt[profileIdx];
      if (t + w < dist[to]) { dist[to] = t + w; push([t + w, to]); }
    }
  }
  return dist;
}

const times = {};
PROFILE_NAMES.forEach((name, k) => {
  console.log(`Dijkstra: ${name}`);
  times[name] = dijkstra(k);
});

// --- 4. Emit per-vertex records for reachable edges ---
const reachable = (e) =>
  isFinite(times.night[idx.get(e.a)]) && isFinite(times.night[idx.get(e.b)]);

const kept = edges.filter(reachable);
const totalVerts = kept.reduce((s, e) => s + e.pts.length, 0);
console.log(`${kept.length} reachable edges, ${totalVerts} vertices`);

const stripClass = new Uint8Array(kept.length);
const stripCat = new Uint8Array(kept.length);
const stripLen = new Uint16Array(kept.length);
const theta = new Float32Array(totalVerts);
const distGeo = new Uint16Array(totalVerts); // metres / 4
const tArr = PROFILE_NAMES.map(() => new Uint16Array(totalVerts)); // seconds

let v = 0, maxT = 0, maxD = 0;
kept.forEach((e, s) => {
  stripClass[s] = e.cls;
  stripCat[s] = e.cat;
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
      const tau = e.tt[k];
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

// --- 5. Coastline: warp it with the roads so the land border balloons too ---
// Each coast vertex borrows the drive times of its nearest road junction
// (plus a small access penalty), so the shoreline deforms coherently with
// the network around it.
const coastRaw = JSON.parse(
  await readFile(new URL('../data/raw/sydney-coast.json', import.meta.url), 'utf8')
);
const coastWays = coastRaw.elements.filter((e) => e.type === 'way' && e.geometry);

// grid index over junctions, planar metres, 1.5 km cells
const CELL = 1500;
const grid = new Map();
const cellKey = (cx, cy) => cx * 100000 + cy;
for (const [id, p] of junctionPos) {
  if (!isFinite(times.night[idx.get(id)])) continue;
  const q = planar(p);
  const k = cellKey(Math.floor(q.x / CELL), Math.floor(q.y / CELL));
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push({ id, x: q.x, y: q.y });
}
function nearestJunction(q) {
  const cx = Math.floor(q.x / CELL), cy = Math.floor(q.y / CELL);
  let best = null, bestD = Infinity;
  for (let ring = 0; ring <= 5; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        for (const j of grid.get(cellKey(cx + dx, cy + dy)) || []) {
          const d = Math.hypot(j.x - q.x, j.y - q.y);
          if (d < bestD) { bestD = d; best = j; }
        }
      }
    }
    if (best && bestD < ring * CELL) break; // can't be beaten by farther rings
  }
  return best ? { id: best.id, d: bestD } : null;
}

const COAST_MIN_SPACING = 120; // metres — simplify dense coastline geometry
const coastStrips = [];
for (const w of coastWays) {
  const pts = [];
  let last = null;
  for (const g of w.geometry) {
    if (!last || haversine(last, g) >= COAST_MIN_SPACING) { pts.push(g); last = g; }
  }
  const end = w.geometry[w.geometry.length - 1];
  if (last !== end) pts.push(end);
  if (pts.length >= 2) coastStrips.push(pts);
}
const coastVerts = coastStrips.reduce((s, p) => s + p.length, 0);
console.log(`${coastStrips.length} coast strips, ${coastVerts} vertices`);

const coastStripLen = new Uint16Array(coastStrips.length);
const coastTheta = new Float32Array(coastVerts);
const coastDist = new Uint16Array(coastVerts);
const coastT = PROFILE_NAMES.map(() => new Uint16Array(coastVerts));

let cv = 0;
coastStrips.forEach((pts, s) => {
  coastStripLen[s] = pts.length;
  for (const g of pts) {
    const q = planar(g);
    coastTheta[cv] = Math.atan2(q.x, q.y);
    const dGeo = Math.hypot(q.x, q.y);
    coastDist[cv] = Math.min(65535, Math.round(dGeo / 4));
    const near = nearestJunction(q);
    for (let k = 0; k < PROFILE_NAMES.length; k++) {
      const name = PROFILE_NAMES[k];
      // access penalty at suburban speed; pseudo-time fallback far from roads
      const t = near
        ? times[name][idx.get(near.id)] + near.d / (40 / 3.6)
        : dGeo / (55 / 3.6);
      coastT[k][cv] = Math.min(65535, Math.round(t));
    }
    cv++;
  }
});

// --- 6. Write binary (sections, each aligned) + manifest ---
const sections = [
  ['stripClass', stripClass],
  ['stripCat', stripCat],
  ['stripLen', stripLen],
  ['theta', theta],
  ['distGeo', distGeo],
  ...PROFILE_NAMES.map((n, k) => [`t_${n}`, tArr[k]]),
  ['coastStripLen', coastStripLen],
  ['coastTheta', coastTheta],
  ['coastDist', coastDist],
  ...PROFILE_NAMES.map((n, k) => [`coastT_${n}`, coastT[k]]),
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
  categories: CATEGORIES,
  profiles: PROFILE_NAMES,
  stripCount: kept.length,
  vertexCount: totalVerts,
  coastStripCount: coastStrips.length,
  coastVertexCount: coastVerts,
  distUnit: 4,            // distGeo/coastDist are metres / 4
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

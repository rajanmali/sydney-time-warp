// Builds the visualisation dataset from the raw Overpass response.
//
// 1. Snap nodes to a 75 m cluster grid (merges dual carriageways), split OSM
//    ways into edges between junction clusters, dedupe parallel edges, and
//    glue every edge endpoint to its junction's centroid.
// 2. Dijkstra from the CBD under 4 congestion profiles (night free-flow,
//    AM peak, midday, PM peak). Congestion = per-edge multipliers: class
//    ceiling × ring profile × per-corridor factor.
// 3. Elastic embedding per profile (Laplacian / diffusion-based warping):
//    each junction gets a radial target (bearing preserved, radius = drive
//    time × reference speed), then the *displacement field* is diffused over
//    the graph so neighbouring junctions deform together — a soft elastic
//    sheet, not rigid scaling. Intermediate vertices interpolate endpoint
//    displacements with a smoothstep, giving rounded organic curves.
//
// Output: data/sydney.bin (struct-of-arrays binary) + data/manifest.json.
// Per vertex: geographic position, warped position under each profile
// (both int16, metres/8), drive-time seconds under each profile (colour).

import { readFile, writeFile } from 'node:fs/promises';

const CBD = { lat: -33.8688, lon: 151.2093 }; // Sydney Town Hall, near enough

const CLASSES = [
  'motorway', 'motorway_link', 'trunk', 'trunk_link',
  'primary', 'primary_link', 'secondary', 'secondary_link',
];
const CLASS_INDEX = new Map(CLASSES.map((c, i) => [c, i]));

// Free-flow speed, km/h, by class index.
const SPEED = [95, 60, 80, 50, 60, 45, 50, 40];

// Peak travel-time multipliers per profile, by class index — the *ceiling*
// for each class; the multiplier applied to an edge is scaled by ring
// position and corridor, so peaks balloon corridors, not the whole map.
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
  return 0.55 + 0.9 * (((h >>> 0) % 1000) / 1000);
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

// --- 1. Cluster nodes onto a ~75 m grid ---
const SNAP = 75; // metres
const nodePos = new Map(); // node id -> {lat, lon}
for (const w of ways)
  w.nodes.forEach((id, i) => { if (!nodePos.has(id)) nodePos.set(id, w.geometry[i]); });

const clusterCache = new Map(); // node id -> cluster key
function clusterOf(id) {
  let c = clusterCache.get(id);
  if (c === undefined) {
    const q = planar(nodePos.get(id));
    c = `${Math.round(q.x / SNAP)}_${Math.round(q.y / SNAP)}`;
    clusterCache.set(id, c);
  }
  return c;
}

// Cluster usage: once per way visit (consecutive nodes in the same cluster
// count as a single visit). A cluster visited ≥2 times is a junction.
const clusterUse = new Map();
for (const w of ways) {
  let prev = null;
  for (const id of w.nodes) {
    const c = clusterOf(id);
    if (c !== prev) clusterUse.set(c, (clusterUse.get(c) || 0) + 1);
    prev = c;
  }
}

// --- 2. Split ways into edges between junction clusters, dedupe parallels ---
const edges = []; // { a, b, cls, cat, corridor, pts, cum, len, tt }
const seenEdge = new Set();
let duplicates = 0;

for (const w of ways) {
  const cls = CLASS_INDEX.get(w.tags.highway);
  const cat = categoryOf(w.tags);
  const corridor = corridorFactor(w.tags, w.id);
  let start = 0;
  let prevC = clusterOf(w.nodes[0]);
  for (let i = 1; i < w.nodes.length; i++) {
    const cI = clusterOf(w.nodes[i]);
    const isLast = i === w.nodes.length - 1;
    const entering = cI !== prevC && clusterUse.get(cI) >= 2;
    prevC = cI;
    if (!entering && !isLast) continue;

    const a = clusterOf(w.nodes[start]), b = cI;
    const pts = w.geometry.slice(start, i + 1).map((p) => ({ ...p }));
    start = i;
    if (a === b || pts.length < 2) continue;

    const key = a < b ? `${a}|${b}|${cls}` : `${b}|${a}|${cls}`;
    if (seenEdge.has(key)) { duplicates++; continue; } // opposite carriageway
    seenEdge.add(key);

    edges.push({ a, b, cls, cat, corridor, pts, cum: null, len: 0, tt: null });
  }
}

// Glue edge endpoints to junction centroids so intersections meet exactly —
// no kinks or gaps where the cluster merge left endpoints ~tens of metres apart.
const centroid = new Map(); // cluster -> {lat, lon, n}
for (const e of edges) {
  for (const [c, p] of [[e.a, e.pts[0]], [e.b, e.pts[e.pts.length - 1]]]) {
    const acc = centroid.get(c) || { lat: 0, lon: 0, n: 0 };
    acc.lat += p.lat; acc.lon += p.lon; acc.n++;
    centroid.set(c, acc);
  }
}
const junctionPos = new Map(); // cluster -> {lat, lon}
for (const [c, acc] of centroid)
  junctionPos.set(c, { lat: acc.lat / acc.n, lon: acc.lon / acc.n });

const kept0 = [];
for (const e of edges) {
  e.pts[0] = { ...junctionPos.get(e.a) };
  e.pts[e.pts.length - 1] = { ...junctionPos.get(e.b) };
  const cum = [0];
  for (let j = 1; j < e.pts.length; j++)
    cum.push(cum[j - 1] + haversine(e.pts[j - 1], e.pts[j]));
  e.cum = cum;
  e.len = cum[cum.length - 1];
  if (e.len === 0) continue;

  const mid = e.pts[Math.floor(e.pts.length / 2)];
  const spatial = ringFactor(haversine(mid, CBD) / 1000) * e.corridor;
  const freeFlow = e.len / (SPEED[e.cls] / 3.6);
  e.tt = PROFILE_NAMES.map((n) => {
    const mult = Math.max(1, 1 + (PROFILES[n][e.cls] - 1) * spatial);
    return freeFlow * mult;
  });
  kept0.push(e);
}
edges.length = 0;
edges.push(...kept0);
console.log(
  `${edges.length} edges, ${junctionPos.size} junctions ` +
  `(${duplicates} parallel carriageway edges merged)`
);

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

// --- 4. Elastic embedding per profile (diffusion-warped displacement field) ---
// Reference speed maps seconds → metres so the night layout matches geography
// in scale: V = dRef / tRef (99.5th-percentile distance / night drive time).
const jPlanar = ids.map((id) => planar(junctionPos.get(id)));
const reachableJ = [];
for (let i = 0; i < N; i++) if (isFinite(times.night[i])) reachableJ.push(i);

const pct = (arr, p) => {
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.floor(s.length * p)];
};
const tRef = pct(reachableJ.map((i) => times.night[i]), 0.995);
const dRef = pct(reachableJ.map((i) => Math.hypot(jPlanar[i].x, jPlanar[i].y)), 0.995);
const V = dRef / tRef; // m/s
console.log(`tRef ${(tRef / 60).toFixed(1)} min, dRef ${(dRef / 1000).toFixed(1)} km, V ${(V * 3.6).toFixed(0)} km/h`);

// neighbour lists over junction indices (reachable only)
const nbr = Array.from({ length: N }, () => []);
for (const e of edges) {
  const ia = idx.get(e.a), ib = idx.get(e.b);
  if (isFinite(times.night[ia]) && isFinite(times.night[ib])) {
    nbr[ia].push(ib);
    nbr[ib].push(ia);
  }
}

// Per profile: radial target → displacement → diffuse over the graph.
// 30 Jacobi iterations, λ=0.5: deformation propagates locally like a field.
const DIFFUSE_ITERS = 30, LAMBDA = 0.5;
const jPos = {}; // profile -> Float64Array(2N) warped junction positions (metres)
for (const name of PROFILE_NAMES) {
  const dx = new Float64Array(N), dy = new Float64Array(N);
  for (const i of reachableJ) {
    const g = jPlanar[i];
    const r = Math.hypot(g.x, g.y);
    const t = times[name][i];
    if (r < 1) { dx[i] = 0; dy[i] = 0; continue; } // CBD anchor
    const target = (t * V) / r;
    dx[i] = g.x * target - g.x;
    dy[i] = g.y * target - g.y;
  }
  const nx = new Float64Array(N), ny = new Float64Array(N);
  for (let it = 0; it < DIFFUSE_ITERS; it++) {
    for (const i of reachableJ) {
      const nb = nbr[i];
      if (nb.length === 0) { nx[i] = dx[i]; ny[i] = dy[i]; continue; }
      let sx = 0, sy = 0;
      for (const j of nb) { sx += dx[j]; sy += dy[j]; }
      nx[i] = dx[i] + LAMBDA * (sx / nb.length - dx[i]);
      ny[i] = dy[i] + LAMBDA * (sy / nb.length - dy[i]);
    }
    dx.set(nx); dy.set(ny);
    dx[srcIdx] = 0; dy[srcIdx] = 0; // keep the CBD pinned
  }
  const P = new Float64Array(2 * N);
  for (const i of reachableJ) {
    P[2 * i] = jPlanar[i].x + dx[i];
    P[2 * i + 1] = jPlanar[i].y + dy[i];
  }
  jPos[name] = P;
  console.log(`Elastic embedding: ${name}`);
}

// --- 5. Emit per-vertex records for reachable edges ---
const reachable = (e) =>
  isFinite(times.night[idx.get(e.a)]) && isFinite(times.night[idx.get(e.b)]);
const kept = edges.filter(reachable);
const totalVerts = kept.reduce((s, e) => s + e.pts.length, 0);
console.log(`${kept.length} reachable edges, ${totalVerts} vertices`);

const POS_SCALE = 8; // int16 stores metres / 8
const stripClass = new Uint8Array(kept.length);
const stripCat = new Uint8Array(kept.length);
const stripLen = new Uint16Array(kept.length);
const posGeo = new Int16Array(totalVerts * 2);
const posArr = PROFILE_NAMES.map(() => new Int16Array(totalVerts * 2));
const tArr = PROFILE_NAMES.map(() => new Uint16Array(totalVerts)); // seconds

const q16 = (m) => Math.max(-32767, Math.min(32767, Math.round(m / POS_SCALE)));

let v = 0, maxT = 0, maxD = 0;
kept.forEach((e, s) => {
  stripClass[s] = e.cls;
  stripCat[s] = e.cat;
  stripLen[s] = e.pts.length;
  const ia = idx.get(e.a), ib = idx.get(e.b);
  for (let j = 0; j < e.pts.length; j++) {
    const g = planar(e.pts[j]);
    posGeo[v * 2] = q16(g.x);
    posGeo[v * 2 + 1] = q16(g.y);
    maxD = Math.max(maxD, Math.hypot(g.x, g.y));

    const f = e.len > 0 ? e.cum[j] / e.len : 0;
    const sf = f * f * (3 - 2 * f); // smoothstep — rounded near junctions
    for (let k = 0; k < PROFILE_NAMES.length; k++) {
      const name = PROFILE_NAMES[k];
      const P = jPos[name];
      // displacement interpolated between endpoint junctions
      const dax = P[2 * ia] - jPlanar[ia].x, day = P[2 * ia + 1] - jPlanar[ia].y;
      const dbx = P[2 * ib] - jPlanar[ib].x, dby = P[2 * ib + 1] - jPlanar[ib].y;
      posArr[k][v * 2] = q16(g.x + dax + sf * (dbx - dax));
      posArr[k][v * 2 + 1] = q16(g.y + day + sf * (dby - day));

      // drive time at this point, for colour
      const tau = e.tt[k];
      const t = Math.min(times[name][ia] + tau * f, times[name][ib] + tau * (1 - f));
      tArr[k][v] = Math.min(65535, Math.round(t));
      maxT = Math.max(maxT, t);
    }
    v++;
  }
});

// --- 6. Write binary (sections, each aligned) + manifest ---
const sections = [
  ['stripClass', stripClass],
  ['stripCat', stripCat],
  ['stripLen', stripLen],
  ['posGeo', posGeo],
  ...PROFILE_NAMES.map((n, k) => [`pos_${n}`, posArr[k]]),
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
  categories: CATEGORIES,
  profiles: PROFILE_NAMES,
  stripCount: kept.length,
  vertexCount: totalVerts,
  posScale: POS_SCALE,       // positions are metres / POS_SCALE in int16
  tRef: Math.round(tRef),    // seconds; isochrone ring scale
  dRef: Math.round(dRef),    // metres; world-unit scale
  refSpeed: V,               // m/s mapping time → space
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

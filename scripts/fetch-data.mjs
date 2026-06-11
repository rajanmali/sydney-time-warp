// Downloads Sydney's main road network (motorway → secondary, incl. links)
// and the coastline from the OpenStreetMap Overpass API.
//
// Bounding box covers the Sydney metro area: Penrith to the coast,
// Hornsby down to Campbelltown/Sutherland.
//
// Existing raw files are kept (delete data/raw/* to force a refetch).

import { mkdir, writeFile, access } from 'node:fs/promises';

const BBOX = '-34.15,150.60,-33.55,151.35'; // south, west, north, east

const QUERIES = {
  'sydney-roads.json': `
[out:json][timeout:300];
way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link)$"](${BBOX});
out geom;
`,
  'sydney-coast.json': `
[out:json][timeout:300];
way["natural"="coastline"](${BBOX});
out geom;
`,
};

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOverpass(query) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const wait = 30000 * attempt;
      console.log(`Retry ${attempt} in ${wait / 1000}s...`);
      await sleep(wait);
    }
    for (const endpoint of ENDPOINTS) {
      console.log(`Querying ${endpoint} ...`);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'sydney-time-warp/1.0 (github.com/rajanmali/sydney-time-warp)',
            Accept: 'application/json',
          },
          body: 'data=' + encodeURIComponent(query),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return await res.json();
      } catch (err) {
        console.warn(`  failed: ${err.message}`);
        lastErr = err;
      }
    }
  }
  throw lastErr;
}

await mkdir(new URL('../data/raw/', import.meta.url), { recursive: true });
for (const [file, query] of Object.entries(QUERIES)) {
  const out = new URL(`../data/raw/${file}`, import.meta.url);
  const exists = await access(out).then(() => true, () => false);
  if (exists) {
    console.log(`${file} already present, skipping`);
    continue;
  }
  const data = await fetchOverpass(query);
  const ways = data.elements.filter((e) => e.type === 'way');
  console.log(`Received ${ways.length} ways (${data.elements.length} elements)`);
  await writeFile(out, JSON.stringify(data));
  console.log(`Saved to ${out.pathname}`);
  await sleep(3000); // be polite to Overpass between queries
}

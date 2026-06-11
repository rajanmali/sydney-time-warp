// Downloads Sydney's main road network (motorway → secondary, incl. links)
// from the OpenStreetMap Overpass API and saves the raw JSON response.
//
// Bounding box covers the Sydney metro area: Penrith to the coast,
// Hornsby down to Campbelltown/Sutherland.

import { mkdir, writeFile } from 'node:fs/promises';

const BBOX = '-34.15,150.60,-33.55,151.35'; // south, west, north, east

const QUERY = `
[out:json][timeout:300];
way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link)$"](${BBOX});
out geom;
`;

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOverpass() {
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
          body: 'data=' + encodeURIComponent(QUERY),
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

const data = await fetchOverpass();
const ways = data.elements.filter((e) => e.type === 'way');
console.log(`Received ${ways.length} ways (${data.elements.length} elements)`);

await mkdir(new URL('../data/raw/', import.meta.url), { recursive: true });
const out = new URL('../data/raw/sydney-roads.json', import.meta.url);
await writeFile(out, JSON.stringify(data));
console.log(`Saved to ${out.pathname}`);

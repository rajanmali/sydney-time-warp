// Downloads each city's main road network (motorway → secondary, incl. links)
// and its suburb/place nodes from the OpenStreetMap Overpass API.
//
// Existing raw files are kept (delete data/raw/* to force a refetch).
// Usage: node scripts/fetch-data.mjs [city ...]   (default: all cities)

import { mkdir, writeFile, access } from 'node:fs/promises';
import { CITIES } from './cities.mjs';

const queriesFor = (bbox) => ({
  roads: `
[out:json][timeout:300];
way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link)$"](${bbox});
out geom;
`,
  places: `
[out:json][timeout:120];
node["place"~"^(suburb|neighbourhood|town)$"](${bbox});
out;
`,
});

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

const wanted = process.argv.slice(2);
const cities = wanted.length ? wanted : Object.keys(CITIES);

await mkdir(new URL('../data/raw/', import.meta.url), { recursive: true });
for (const city of cities) {
  const cfg = CITIES[city];
  if (!cfg) { console.error(`Unknown city: ${city}`); process.exit(1); }
  const queries = queriesFor(cfg.bbox);
  for (const [kind, query] of Object.entries(queries)) {
    const file = `${city}-${kind}.json`;
    const out = new URL(`../data/raw/${file}`, import.meta.url);
    const exists = await access(out).then(() => true, () => false);
    if (exists) {
      console.log(`${file} already present, skipping`);
      continue;
    }
    const data = await fetchOverpass(query);
    console.log(`${file}: ${data.elements.length} elements`);
    await writeFile(out, JSON.stringify(data));
    await sleep(3000); // be polite to Overpass between queries
  }
}

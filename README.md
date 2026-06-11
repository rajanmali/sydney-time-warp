# Sydney Time Warp

**A day in Sydney, warped so that distance ≈ drive time.**

Every road vertex is positioned at `radius = drive time from the CBD` along its true
bearing — so the map *is* an isochrone. Drive times swell in the morning and evening
rush hour, then contract at night, and the whole city breathes.

**Live: <https://rajanmali.github.io/sydney-time-warp/>**

| Midday | Evening peak |
|---|---|
| ![Midday](assets/midday.png) | ![Evening peak](assets/evening-peak.png) |

Inspired by [the Manhattan original](https://x.com/cosmic_yolo_bot/status/2064610059313905781).

## How it works

```
OpenStreetMap (Overpass API)
  └─ 35k ways: motorway → secondary, Sydney metro bbox
       └─ scripts/build-data.mjs
            ├─ split ways into 38k edges at 32k junctions
            ├─ Dijkstra from the CBD × 4 congestion profiles
            │    (night free-flow · AM peak · midday · PM peak)
            └─ data/sydney.bin — per vertex: bearing, geo distance,
               4 drive-time anchors (2.9 MB, struct-of-arrays)
                 └─ src/main.js (Three.js)
                      vertex shader blends the 4 anchors with Gaussian
                      day-curve weights → radius = driveTime × scale.
                      The day cycle never touches a buffer: 100% GPU.
```

- **Colour** = congestion (current drive time ÷ free-flow): blue → amber → ember.
- **Brightness** = road class (motorways brightest).
- **Rings** = 15/30/45/60/90/120-minute isochrones — circles, by construction.
- Toggle **Time-warp / Geographic** to morph between the two layouts.

## Congestion model

A static page can't call authenticated live-traffic APIs, so congestion is modelled as
per-road-class travel-time multipliers applied before Dijkstra, with shapes informed by
[TfNSW traffic volume patterns](https://opendata.transport.nsw.gov.au/data/dataset/nsw-roads-traffic-volume-counts-api):

| Class | Night | AM peak | Midday | PM peak |
|---|---|---|---|---|
| Motorway | ×1.0 | ×2.1 | ×1.3 | ×2.0 |
| Trunk | ×1.0 | ×2.0 | ×1.25 | ×1.9 |
| Primary | ×1.0 | ×1.95 | ×1.25 | ×1.9 |
| Secondary | ×1.0 | ×1.75 | ×1.2 | ×1.85 |

The graph is undirected (one-way streets ignored) — fine for a visualisation,
wrong for a router.

## Develop

No dependencies, no bundler. Three.js comes from a CDN import map.

```bash
npm run fetch   # download raw OSM data from Overpass → data/raw/
npm run build   # raw data → data/sydney.bin + data/manifest.json
npm run serve   # http://localhost:8000
```

## Data sources

- Road geometry: [OpenStreetMap](https://www.openstreetmap.org/copyright) via the
  [Overpass API](https://overpass-api.de/) — © OpenStreetMap contributors, ODbL.
- Congestion shape: [Transport for NSW Open Data Hub](https://opendata.transport.nsw.gov.au/) —
  [Traffic Volume Viewer](https://www.transport.nsw.gov.au/operations/roads-and-waterways/corporate-publications/statistics/traffic-statistics/traffic-volume).

## Licence

Code: [MIT](LICENSE). Map data: © OpenStreetMap contributors,
[ODbL](https://opendatacommons.org/licenses/odbl/).

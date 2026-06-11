# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**Sydney Time Warp** — a Three.js visualisation of Sydney's road network where each
vertex's distance from the CBD is proportional to its *drive time* from the CBD,
not its geographic distance. As the time-of-day animates, rush hour congestion makes
the map swell outward (morning/evening peaks) and contract at night.

Inspired by the "A day in Manhattan, warped so that distance ≈ drive time" visualisation.

## Architecture

Two halves: an **offline data pipeline** (Node, no dependencies) and a **static web app**
(Three.js via CDN import map, no build step). The processed data is committed so GitHub
Pages can serve everything statically.

```
scripts/
  fetch-data.mjs   Downloads Sydney road geometry (motorway→secondary) from the
                   OpenStreetMap Overpass API into data/raw/ (gitignored).
  build-data.mjs   Builds a road graph (split ways at junctions), runs Dijkstra from
                   the CBD under 4 congestion profiles (night / AM peak / midday /
                   PM peak), then writes per-vertex records to data/sydney.bin
                   + data/manifest.json.
data/
  raw/             Raw Overpass response (gitignored — refetch with npm run fetch).
  sydney.bin       Binary per-vertex data: bearing from CBD, geographic distance,
                   and drive-time seconds under each of the 4 profiles.
  manifest.json    Road strip offsets, classes, counts, scaling metadata.
src/
  main.js          Three.js scene. All warping happens in a vertex shader: per-vertex
                   attributes (theta, geo distance, 4 drive times) + uniforms (hour,
                   warp amount) → position. Animation is GPU-only; JS just ticks hour.
index.html         Entry point, import map for three.js, UI chrome (clock, slider).
```

### Key design decisions

- **Drive times are precomputed, not live.** TfNSW's live APIs need auth keys, which a
  static page can't hold. Congestion is modelled as per-road-class travel-time
  multipliers (informed by TfNSW traffic volume patterns) applied before Dijkstra.
- **4 profiles + client-side blending.** Storing 24 hourly times per vertex is ~5× the
  data for little visual gain. The shader blends night/AM/midday/PM anchors with
  Gaussian weights centred on 8:15, 13:00 and 17:30.
- **Drive times only computed at junction nodes**; intermediate geometry vertices get
  times interpolated along their edge by distance fraction.
- **The graph is undirected** (one-way streets ignored) — acceptable for a visualisation.

## Commands

```bash
npm run fetch    # Download raw OSM data from Overpass (writes data/raw/)
npm run build    # Process raw data → data/sydney.bin + data/manifest.json
npm run serve    # Serve the site locally (python http.server on :8000)
```

No test suite, no linter, no bundler. The site is plain ES modules served statically.

## Git workflow

- `main` = production (GitHub Pages serves from here). Never commit directly.
- `dev` = default working branch. Never commit directly.
- Every change gets its own branch off `dev`: `feature/`, `fix/`, `chore/`, `docs/`,
  `refactor/`, `test/`, `style/`, `perf/` — merged into `dev` via PR.
- `hotfix/` branches off `main`, merges into both `main` and `dev`.
- `release/vX.Y.Z` branches off `dev`, merges into `main` via PR.

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
  fetch-data.mjs   Downloads Sydney road geometry (motorway→secondary) and the
                   coastline from the OpenStreetMap Overpass API into data/raw/
                   (gitignored; existing raw files are skipped, delete to refetch).
  build-data.mjs   Builds a road graph (split ways at junctions), runs Dijkstra from
                   the CBD under 4 congestion profiles (night / AM peak / midday /
                   PM peak), then writes per-vertex records to data/sydney.bin
                   + data/manifest.json. Also tags strips with NSW route categories
                   (M/A/B/other from OSM ref tags) and emits coastline strips whose
                   vertices borrow drive times from their nearest road junction.
data/
  raw/             Raw Overpass responses (gitignored — refetch with npm run fetch).
  sydney.bin       Binary struct-of-arrays: road + coast strips; per vertex bearing
                   from CBD, geographic distance, 4 drive-time anchors.
  manifest.json    Section offsets, classes, categories, counts, scaling metadata.
src/
  main.js          Three.js scene. All warping happens in a vertex shader: per-vertex
                   attributes (theta, geo distance, 4 drive times) + uniforms (hour,
                   warp amount, category visibility) → position. Animation is
                   GPU-only; JS just ticks hour. Fixed top-down OrthographicCamera
                   (rotation disabled). URL params: ?h= start hour, ?play=0, ?cats=.
index.html         Entry point, import map for three.js, UI chrome (clock, slider,
                   route filters, legend).
```

### Key design decisions

- **Drive times are precomputed, not live.** TfNSW's live APIs need auth keys, which a
  static page can't hold. Congestion is modelled before Dijkstra.
- **Congestion is spatially varying**, not uniform per class: each edge's multiplier =
  class ceiling × ring profile (peaks 6–18 km from the CBD) × deterministic
  per-corridor hash (0.7–1.3). This is what makes peaks *balloon* specific corridors
  instead of scaling the whole map.
- **4 profiles + client-side blending.** Storing 24 hourly times per vertex is ~5× the
  data for little visual gain. The shader blends night/AM/midday/PM anchors with
  Gaussian weights centred on 8:15, 13:00 and 17:30.
- **Drive times only computed at junction nodes**; intermediate geometry vertices get
  times interpolated along their edge by distance fraction.
- **Strip meta packing**: position.z = class + 16 × category; the shader decodes both.
  Category visibility (M/A/B/other filter) is a uCatVis uniform — no rebuilds.
- **Dual carriageways are merged in the pipeline**: nodes snap to a 75 m cluster
  grid; junction detection, the graph and edge dedupe operate on clusters, so both
  carriageways share drive times and only one path is drawn.
- **Peak swell is exaggerated**: the shader shows tN + uSwell·(t − tN) with
  uSwell = 2.4 (?swell= overrides, 1–4) so congestion reads as curvature. Night
  layout and the HUD slowdown factor stay truthful.
- **The camera never rescales with the swell** (a breathing auto-fit was tried and
  removed — it cancelled the size change that is the visualisation). camera.zoom is
  set once at load to frame the peak extent of the visible categories; the pivot is
  fixed ~1.5 km west of the CBD and zoomToCursor is off.
- **Coastline data exists but is not rendered** — it drew jagged artifacts where
  coast vertices fell back to pseudo-times (removed in v1.2.0; pipeline still emits
  the sections).
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

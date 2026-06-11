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
  build-data.mjs   Snaps nodes to 75 m clusters (merging dual carriageways), splits
                   ways into edges between junction clusters with endpoints glued to
                   centroids, runs Dijkstra from the CBD under 4 congestion profiles,
                   then computes an *elastic embedding* per profile: radial targets
                   at junctions, displacement field diffused over the graph (30
                   Jacobi iterations, λ=0.5, CBD pinned). Writes per-vertex
                   geographic + 4 warped positions + 4 drive times to data/sydney.bin
                   + data/manifest.json. Strips carry NSW route categories
                   (M/A/B/other from OSM ref tags).
data/
  raw/             Raw Overpass responses (gitignored — refetch with npm run fetch).
  sydney.bin       Binary struct-of-arrays: road + coast strips; per vertex bearing
                   from CBD, geographic distance, 4 drive-time anchors.
  manifest.json    Section offsets, classes, categories, counts, scaling metadata.
src/
  main.js          Three.js scene. The vertex shader blends the 4 precomputed
                   elastic embeddings with Gaussian day-curve weights (+ swell
                   extrapolation + subtle undulation) — the day cycle is GPU-only.
                   Flow particles are advected on the CPU (mirror of the shader
                   blend), slowed by local congestion. Fixed top-down
                   OrthographicCamera (rotation disabled). URL params: ?h= start
                   hour, ?play=0, ?cats=, ?swell=, ?zoom=, ?debug=parts.
index.html         Entry point, import map for three.js, UI chrome (clock, slider,
                   route filters, legend).
```

### Key design decisions

- **Drive times are precomputed, not live.** TfNSW's live APIs need auth keys, which a
  static page can't hold. Congestion is modelled before Dijkstra.
- **Congestion is spatially varying**, not uniform per class: each edge's multiplier =
  class ceiling × ring profile (peaks 6–18 km from the CBD) × deterministic
  per-corridor hash (0.55–1.45). This is what makes peaks *balloon* specific corridors
  instead of scaling the whole map.
- **The warp is an elastic embedding, not a per-vertex radial map**: junction radial
  targets are diffused as a displacement field over the graph, so neighbours deform
  together (smooth, organic, field-like) and intersections stay glued. A per-vertex
  radial warp was tried first — it shears adjacent vertices apart and looks jagged.
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

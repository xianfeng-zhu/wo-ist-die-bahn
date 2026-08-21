# Repository Guidelines

## Project Overview

Live map of Berlin S-Bahn, U-Bahn, and tram vehicles. A static SPA (no backend): the browser polls VBB's HAFAS endpoint (`fahrinfo.vbb.de/gate`) directly every 20 s, renders vehicles as line-colored badges that animate smoothly along track shapes. Buses, regional, and express trains are excluded by a server-side product mask plus a client-side line-name gate. English UI; German station/direction names as delivered by the API.

## Architecture & Data Flow

```
poll() — every 20s (exponential backoff ×2 up to 60s) —▶ fetchVehicles(BERLIN_BBOX, 2000, signal, !TEST_ALL)
  POST https://fahrinfo.vbb.de/gate?rnd=<Date.now()>   (HAFAS JourneyGeoPos, rect in microdegrees, PROD mask 7)
  └▶ parseRadar → transformJourney (cls gate + strict line-name gate) → Vehicle[]
render(): filterVehicles(filters) → reconcile markers → updateSegment (AnimState anchored at
  current animated position, arrival = Date.now() + timeDiffMs(schedule))
rAF loop (dt clamped ≤100ms): advanceAnimation (forward-only, accel-limited velocity toward
  schedule-paced target) → marker.setLngLat; on arrival → chain to the FOLLOWING stop
  (keeps moving until fresh data); debug target paths rebuilt ≤ every 500ms
Track shapes: public/routes.json → lineShapes[line] (GeoJSON [lon,lat] → [lat,lon]);
  buildSegmentPath slices the shape between projected from/to (direction-aware), straight-line fallback
```

Import graph: `main.ts → {hci.ts, vehicle.ts, motion.ts, track.ts, line-colors.ts, style.css, maplibre-gl}`; `hci.ts → vehicle.ts`; `track.ts → motion.ts`; `vehicle.ts`, `motion.ts`, `line-colors.ts` are pure leaves.

## Key Directories

- `src/` — all app code; tests colocated (`src/<module>.test.ts`)
- `public/` — static assets served as-is: `stations.json` + `routes.json` (GTFS-derived, generated), `maplibre-gl-worker.mjs` + `maplibre-gl-shared.mjs` (vendored MapLibre build artifacts — Vite does not emit the worker)
- `scripts/` — `prepare-data.mjs`: one-off GTFS + linienfarben → static assets + `src/line-colors.ts`
- `docs/plans/` — design doc and implementation plan (historical; the plan's Leaflet stack was superseded by MapLibre GL)

## Development Commands

```sh
npm install              # npm only (package-lock.json)
npm run dev              # Vite dev server → http://localhost:5173 (binds IPv6; use `localhost`, not 127.0.0.1)
npm run build            # tsc --noEmit && vite build  (TS check + production build to dist/)
npm test                 # vitest run (single pass, no watch)
npm run preview          # serve the built dist/
npm run prepare:data     # regenerate stations.json/routes.json/line-colors.ts from GTFS (rarely needed)
```

Debug mode: append `?all=1` to disable the strict product gate (keeps every returned vehicle, e.g. FEX, with inferred product — useful for testing).

## Code Conventions & Common Patterns

- **Language/style**: TypeScript strict (`strict: true`), ES2022 target, no path aliases. ESM with `.js` extension in relative imports (`import {x} from './motion.js'`). No eslint/prettier config in the repo — match existing formatting. No framework; vanilla TS + MapLibre GL.
- **Naming**: `PascalCase` types/interfaces (no `I` prefix), `camelCase` functions/variables, `UPPER_SNAKE` constants. Types carry docs that state invariants (read them — e.g. `AnimState`, `Vehicle.stops`).
- **Error handling**: data transforms return `null`/undefined for missing data (never throw); `parseRadar` throws on HAFAS `err != 'OK'`; network failures drive the poll backoff state machine (`live | stale | offline`); static-layer fetches use `try/catch` + `console.warn`. Never add try/catch around animation math.
- **Async**: no async/await in the hot path. Polling is a recursive `setTimeout` chain with a fresh `AbortController` (15 s timeout) per poll; animation is a single rAF chain with `dt = Math.min(now - lastFrame, 100)`.
- **State management**: module-level mutable `Map`s (`animStates`, `markers`) + a `vehicles` array; map view persisted to `localStorage['liveberlin.mapview']` (validated on load, saved on `moveend`). No DI, no stores.
- **Animation invariants (do not break)**: progress is forward-only (never decreases; ease to a hold when data lags); velocity is acceleration-limited (`ANIM = {speedFactor: 1, maxAccel: 0.01, maxDecel: 0.01}` in `main.ts`); segment duration comes from `timeDiffMs` on stop-time *differences* — HAFAS absolute times are ~24 h stale for night services, so never anchor to absolute stop times; on each poll, re-anchor from the current animated position keeping velocity (never jump); when progress ≥ 1 and more stops remain, chain to the next segment.
- **Product gating (double gate)**: cls bit → product, AND line name must match `LINE_PATTERNS` (`/^S\d{1,2}$/`, `/^U\d{1,2}$/`, `/^M?\d{1,2}$/`) — the name gate exists because FEX passes the cls filter.
- **Timing**: always pass `Date.now()` (not rAF `performance.now()`) to `advanceAnimation` — different time bases.
- **MapLibre gotchas**: `setWorkerUrl('/maplibre-gl-worker.mjs')` must run before `new Map(...)`; `addSource`/`addLayer` only after the map `load` event (e.g. debug targets layers); the debug target stack is `targets-layer` + `anim-paths-layer` + `anim-paths-casing`, toggled together by the Targets checkbox.

## Important Files

| Path | Role |
|---|---|
| `src/main.ts` | Entry point: map init, polling + backoff, marker reconcile, rAF animation loop, filter UI, status bar, debug target layers. No exports. |
| `src/hci.ts` | HAFAS/VBB client: `GATE_URL`, `berlinDateTime`, `buildRadarBody`, `parseRadar`, `fetchVehicles(bbox, maxJny, signal, strictName)` |
| `src/vehicle.ts` | Domain types + `transformJourney` (HAFAS → `Vehicle` with remaining-stops chain), `filterVehicles`, `productFromCls`, `delayFrom`, `LINE_PATTERNS` |
| `src/motion.ts` | Pure animation math: `advanceAnimation`, `pointAlongPath`, `projectOntoPath`, `slicePath`, `berlinEpoch`, `timeDiffMs`, `AnimState` |
| `src/track.ts` | `buildSegmentPath` (shape slicing), `firstStopAhead` (re-anchor gating) |
| `src/line-colors.ts` | Generated line-name → color map |
| `index.html` | Entry: `#map`, `#statusbar`, `#filters`, `#attribution`; loads `/src/main.ts` |
| `vite.config.ts` | Minimal: `build.target: 'es2022'` |

## Runtime/Tooling Preferences

- Node 18+ (Vite 5); npm with `package-lock.json`; no Bun, no pnpm.
- No backend allowed: all API calls go frontend-direct to `fahrinfo.vbb.de/gate` (CORS `*`, user decision). The endpoint is VBB's webapp endpoint, not a public API — keep polling respectful (20 s interval; backoff on failure).
- Map tiles: OSM raster (`tile.openstreetmap.org`, tileSize 256, maxzoom 19).
- MapLibre worker must live in `public/` and be referenced via `setWorkerUrl` before map creation.

## Testing & QA

- **Framework**: Vitest 2, node environment, no globals (`describe/it/expect` imported explicitly), no mocks/spies/fake timers, no coverage thresholds configured. Run with `npm test` (or `npx vitest run`).
- **Style**: one `describe` per function, one `it` per behavior; inline literal fixtures (HAFAS JSON, path arrays) with `as never` casts; assertions `toBe`/`toEqual`/`toMatchObject`/`toBeCloseTo`/`toThrow`.
- **Coverage**: 48 tests (vehicle 18, motion 18, track 7, hci 5). Pure modules (`motion`, `track`, `vehicle`, `hci` parsing) are well tested; **`main.ts` is entirely untested** (map init, markers, render/frame loop, filters, polling/backoff, view persistence) — it would need a DOM environment plus a maplibre-gl mock; `fetchVehicles` network behavior and `line-colors.ts` are also untested.
- **Verification workflow**: `npm run build` (type-checks via `tsc --noEmit`) then `npm test`; UI changes are verified in a real browser against `localhost:5173` (the dev server running), since main.ts has no tests. For headless checks, read DOM state (`window.__lb`-style breadcrumbs or `document.querySelectorAll`) — console event capture is unreliable.

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
  operator forecast, replayed along the track) → marker.setLngLat
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
- **Naming**: `PascalCase` types/interfaces (no `I` prefix), `camelCase` functions/variables, `UPPER_SNAKE` constants. Types carry docs that state invariants (read them — e.g. `AnimState`, `Vehicle.stops`, `Vehicle.toStop`).
- **Error handling**: data transforms return `null`/undefined for missing data (never throw); `parseRadar` throws on HAFAS `err != 'OK'`; network failures drive the poll backoff state machine (`live | stale | offline`); static-layer fetches use `try/catch` + `console.warn`. Never add try/catch around animation math.
- **Async**: no async/await in the hot path. Polling is a recursive `setTimeout` chain with a fresh `AbortController` (15 s timeout) per poll; animation is a single rAF chain with `dt = Math.min(now - lastFrame, 100)`.
- **State management**: module-level mutable `Map`s (`animStates`, `markers`) + a `vehicles` array; map view persisted to `localStorage['liveberlin.mapview']` (validated on load, saved on `moveend`). No DI, no stores.
- **`stopL` is NOT a stop chain (measured, 308/308 journeys)**: `JourneyGeoPos` always returns exactly 4 stopovers — `[origin, previous stop, next stop, destination]`. Only [1] and [2] are adjacent; [0]/[3] can be an hour and half a city away. Never infer the current segment geometrically from this list. Take it from `jny.ani.fLocX[0]` / `ani.tLocX[0]` (indexes into `common.locL`), surfaced as `Vehicle.fromStop` / `Vehicle.toStop`. `ani` also carries the 30 s motion forecast that drives the animation: `mSec` offsets plus `polyG.polyXL` -> `common.polyL[].crdEncYX` (Google encoded polyline, lat before lon). Its point count always equals `mSec`'s (4, 10 s apart) and point[0] is exactly `jny.pos`.
- **Poll interval is 10 s**, matching the official VBB livemap (`_.Livemap.timeout = 10` in their `hafas_webapp_config.js`). `trainPosMode` has only two values (`CALC`, `CALC_REPORT`); `REPORT` alone is rejected and `CALC_REPORT` returns identical positions, so there is no GPS-based mode. The community wrappers (`v6.vbb.transport.rest`, `v6.bvg.transport.rest`) are dead, and gtfs.de's GTFS-RT is CORS-blocked with no VehiclePositions — this endpoint is the best browser-direct source available.
- **One GTFS shape per line is not enough**: `prepare-data.mjs` keeps the longest shape per line name, so branch variants (S1, M5, tram 12, M2) do not match. `updateSegment` checks the forecast against the track (`SHAPE_FIT_LIMIT_M`, 250 m) and follows the forecast points — extended straight to the target — when it does not fit. Without the guard, 22 of 296 vehicles projected 2-7 km off. The 250 m figure is measured, not guessed: residuals are bimodal, with shape-vs-track noise up to ~100 m and branch mismatches from ~300 m. A tighter limit left ~46 vehicles on the boundary, flipping path source between polls and jolting the marker.
- **Animation invariants (do not break)**: motion is a replay of the operator's own forecast (`Vehicle.forecast`: positions at `ani.mSec` offsets), projected onto the GTFS track and evaluated against wall clock — nothing is schedule-paced or invented. Progress never decreases (`alongAt` clamps and forces `alongs` non-decreasing). Past the forecast, coast at the last sample's speed rather than freeze. Anchor each poll on the **reported** position, not the previously drawn one: measured drift is ~9 m median, so being truthful costs no visible jump (max step 12 px over 74k samples). Never re-introduce schedule pacing — it measured 356 m median error, *worse* than not animating at all (197 m).
- **Motion is forward-only across polls too** (`AnimState.drawnAlong`): each poll re-anchors on the reported position, which can sit *behind* what we extrapolated, and snapping back reads as the vehicle reversing. `advanceAlong` holds until the forecast catches up. Measured: 305 reversals / 80 s over 183 vehicles before, 13 after. Do not "simplify" this to a plain `alongAt` call.
- **Coasting expires** (`COAST_GRACE_MS`, 5 s past the last forecast sample). Before this, a 45 s outage left 251 of 276 markers still gliding on a stale prediction. Coast far enough to cover a late poll, not far enough to invent a journey.
- **The rendered position is forward-only too** (`forwardStep`, `AnimState.heading`). `stepTowards` has no sense of direction, so easing toward a position that sits *behind* the badge dragged it backwards; `drawnAlong` only guarantees monotonic progress along ONE path, and a poll re-projects onto a new one. Measured: 40 reversals per 100 s before, **0** after.
- **A track the forecast could only follow at an absurd speed is the wrong track** (`impliedSpeed`, `SPEED_SANITY_MPS` = 45 m/s). The 250 m fit check passes shapes that take a much longer way round, and ring lines (S41/S42) where projection wraps to the far side. Two vehicles were sustaining 320 and 214 km/h; after the guard, none above 160 km/h.
- **Corrections are rate-limited in POSITION space** (`stepTowards`, `AnimState.renderPos`). `advanceAlong` only smooths progress along one path; each poll can replace the path entirely, and a point projected onto a *new* path can land far from where the badge was drawn — that was a 988 m single-frame jump, seen as the badge blinking out and reappearing ahead. `CATCHUP_MAX_SPEED` (400 m/s) plus the hard `CATCHUP_MAX_STEP` (25 m/frame, for stalled frames) bound it. Measured over 580k frames: max 14 m/frame, none over 25 m, zero reversals. Normal motion is far under the cap, so it lands exactly on target with no lag.
- **Accuracy must be measured mid-poll-cycle.** Sampling right after a poll flatters the animation (frozen positions are perfect then) and understates error. At a controlled 6 s after each poll: drawn median 7-14 m / p90 61-72 m, frozen median 58-68 m / p90 110-129 m, drawn closer for ~82% of vehicles.
- **Product gating (double gate)**: cls bit → product, AND line name must match `LINE_PATTERNS` (`/^S\d{1,2}$/`, `/^U\d{1,2}$/`, `/^M?\d{1,2}$/`) — the name gate exists because FEX passes the cls filter.
- **Timing**: always pass `Date.now()` (not rAF `performance.now()`) to `advanceAnimation` — different time bases.
- **MapLibre gotchas**: `setWorkerUrl('/maplibre-gl-worker.mjs')` must run before `new Map(...)`; `addSource`/`addLayer` only after the map `load` event (e.g. debug targets layers); the debug target stack is `targets-layer` + `anim-paths-layer` + `anim-paths-casing`, toggled together by the Targets checkbox.

## Important Files

| Path | Role |
|---|---|
| `src/main.ts` | Entry point: map init, polling + backoff, marker reconcile, rAF animation loop, filter UI, status bar, debug target layers. No exports. |
| `src/hci.ts` | HAFAS/VBB client: `GATE_URL`, `berlinDateTime`, `buildRadarBody`, `parseRadar`, `fetchVehicles(bbox, maxJny, signal, strictName)` |
| `src/vehicle.ts` | Domain types + `transformJourney` (HAFAS → `Vehicle`, incl. the declared `fromStop`/`toStop` segment), `filterVehicles`, `productFromCls`, `delayFrom`, `shortId`, `LINE_PATTERNS` |
| `src/polyline.ts` | `decodePolyline` (Google encoded polyline, for `common.polyL[].crdEncYX`) |
| `src/motion.ts` | Pure animation math: `advanceAnimation`, `pointAlongPath`, `projectOntoPath`, `slicePath`, `berlinEpoch`, `timeDiffMs`, `AnimState` |
| `src/track.ts` | `buildSegmentPath` (GTFS shape slicing between two points) |
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
- **Layout must fit any realistic window**: `#map` is 100% of the viewport; every overlay is capped with `max-width`/`max-height` against the viewport and scrolls internally. Below `COMPACT_MAX_WIDTH` (720 px — the filter panel needs ~270 px and the status bar ~220 px, so narrower windows would overlap) `body.compact` hides the panel behind `#settings-toggle`. Verified across 14 real device/window sizes and a 29-step resize sweep. Note MapLibre resizes its canvas one frame *after* the container, so measure layout after two `requestAnimationFrame`s, never synchronously.
- **Motion is checked by recording, not by watching.** The debug view has a **Record motion** toggle and **Save log** button (`src/recorder.ts`); analyse the download with `node scripts/analyse-motion.mjs logs/motion-*.ndjson [--vehicle 75416-24]`. Fault detection (`jump`, `reversal`, `overspeed`, `freeze`, `dwell`, `correction`, `appear`, `vanish`) runs on **every animation frame**, because a teleport lasts exactly one frame; the position trace is sampled at 5 Hz (`?traceHz=N`) because storing every frame for every vehicle is ~350 MB per 15 min. Drive it headlessly via `__lb.startRecording()` / `__lb.stopRecording()` / `__lb.saveRecording()`.
- **Never judge speed on a single frame.** `stepTowards` may move 25 m in one frame (1560 m/s) while correcting, and a move that lands just inside the frame budget is not even flagged as correcting. Per-frame speed reported **17198 false overspeeds in 15 min**. Overspeed is therefore measured over `MOTION_LIMITS.speedWindowSec` (10 s), which separates a sub-second re-anchor from real speed; a 3 s window did not. Per-frame faults are caught by `jumpM` instead. After the fix: 24 overspeeds in 100 s, all genuine.
- **Coverage**: 104 tests (vehicle 29, motion 43, recorder 19, polyline 4, track 4, hci 5). `logs/` is gitignored; a 15 min recording is ~98 MB. Pure modules (`motion`, `track`, `vehicle`, `hci` parsing) are well tested; **`main.ts` is entirely untested** (map init, markers, render/frame loop, filters, polling/backoff, view persistence) — it would need a DOM environment plus a maplibre-gl mock; `fetchVehicles` network behavior and `line-colors.ts` are also untested.
- **Verification workflow**: `npm run build` (type-checks via `tsc --noEmit`) then `npm test`; UI changes are verified in a real browser against `localhost:5173` (the dev server running), since main.ts has no tests. For headless checks use the `window.__lb` handle (`{map, animStates, vehicles, lineShapes, logs, byId(jidOrShortId)}`, exposed at the end of `main.ts`); `logs` mirrors the on-screen `#debuglog` panel, which stays hidden until something is logged or read DOM state (`.veh[data-vehicle-id]`, `document.querySelectorAll`) — console event capture is unreliable.

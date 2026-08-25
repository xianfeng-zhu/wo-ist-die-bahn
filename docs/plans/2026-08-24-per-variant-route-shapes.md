# Per-Variant Route Shapes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give every vehicle the track its own route variant actually follows, instead of one longest-shape-per-line-name guess, so animated positions follow real geometry.

**Architecture:** `prepare-data.mjs` already loads every GTFS shape into `shapePts`, then discards all but the longest per line name (`scripts/prepare-data.mjs:153-162`). Stop discarding them: emit all distinct variants per line, simplified with Douglas–Peucker instead of blind decimation. At runtime, pick the variant whose geometry the operator's own forecast points lie on — the forecast is already the discriminator we use in `badFit()`, so it becomes a selector rather than a bail-out. No new network requests: the browser still makes one poll, and the shapes ship as static data.

**Tech Stack:** Node ESM build script (`scripts/*.mjs`), vanilla TypeScript + Vite, Vitest, existing `MotionRecorder` + `scripts/analyse-motion.mjs` for before/after measurement.

---

## Why this, and why not the alternatives

Three options were measured before writing this plan.

**Rejected: `hafas-client` as a dependency.** Its `parse/movement.js` reads only `ani.poly` / `ani.polyline`. Live VBB radar returns neither — it returns `ani.polyG.polyXL: [0]`, an index into `common.polyL[]`. Grepping the library: `polyG`/`polyXL` appear only in test fixtures, never in source. It would silently drop the forecast geometry our whole motion engine runs on. Its VBB profile also points at `/bin/mgate.exe`, which returns **no** CORS headers (`/gate`, which we use, returns `access-control-allow-origin: *`).

**Rejected: per-vehicle `JourneyDetails` at runtime.** It does return the full stop list (24 stops for a U8, against the 4-entry radar summary) and the exact trip polyline, and vehicles sharing a line and direction return byte-identical polylines (`sha1:93b150373a` across three separate S42 trips). But it costs one request per vehicle, and the obvious cache key is unsound: a headsign is not a route. Live U7 shows **six** destinations for a two-terminus line (`Rohrdamm`, `Richard-Wagner-Platz`, `Fehrbelliner Platz`, `Britz-Süd` are short turns), and M5 runs to `Betriebshof Lichtenberg` by two different streets. Keying on the real stop sequence needs the request you were trying to avoid.

**Chosen: fix the build step.** GTFS gives each trip a `shape_id`. We already download, stream and parse those shapes. The information is on disk and free.

### What this should fix

| Symptom | Cause | After |
|---|---|---|
| `SHAPE_FIT_LIMIT_M = 250` exists at all | one shape per line name, so branch variants miss by 300 m–6.5 km | guard should almost never fire |
| `SPEED_SANITY_MPS = 45` exists at all | S41/S42 share one shape, so ring projection wraps | S41 and S42 get their own tracks |
| residuals reach ~100 m on a *correct* track | `decimate()` keeps every Nth point, cutting corners | Douglas–Peucker keeps points where the line bends |
| freezes (4 per 100 s) | path ends at the declared stop | not addressed here — see "Out of scope" |

### Out of scope

- Freezes / long dwells. They need path extension past the declared stop, which is a separate change.
- The commented-out `routes-layer` / `stations-layer` (`// TESTING:` at `src/main.ts:395`, `:428`, `:568`). Leave as the user set them.
- Any change to poll interval, request shape, or `src/hci.ts`.

### Definition of done

Measured with a 100 s recording of the full vehicle set, compared against the current build:

1. `badFit()` fire rate drops below 5% of segment rebuilds (baseline measured in Task 1).
2. Reversals stay at 0 and sustained overspeeds stay at 0.
3. Drift median does not get worse; p90 does not get worse by more than 10 m.
4. `public/routes.json` stays under 250 KB gzipped.
5. `npm test` green, `npm run build` clean.

---

## Task 0: Baseline, so improvement is provable

**Files:**
- Modify: `src/main.ts` (add two counters + debug readout)

**Step 1: Add fire counters next to the existing guards**

In `src/main.ts`, just below `const SHAPE_FIT_LIMIT_M = 250` (line 175), add:

```ts
/** How often the fit/speed guards rejected the GTFS track. Surfaced in the
 *  debug panel: with per-variant shapes these should approach zero. */
export const guardStats = {rebuilds: 0, badFit: 0, tooFast: 0}
```

In `updateSegment`, replace lines 218-233 with:

```ts
  const badFit = () => maxResidualM(path, f.pts) > SHAPE_FIT_LIMIT_M
  const tooFast = () => {
    const a = alongsOnPath(path, f.pts)
    const t = projectOntoPath(path, {lat: path[path.length - 1][0], lon: path[path.length - 1][1]}).along
    return impliedSpeed(f.ms, a, t, path) > SPEED_SANITY_MPS
  }
  guardStats.rebuilds++
  const unfit = badFit()
  const fast = !unfit && tooFast()
  if (unfit) guardStats.badFit++
  if (fast) guardStats.tooFast++
  if (unfit || fast) {
    // Wrong track: either the forecast does not lie on it, or following it
    // would need an impossible speed (a shape that takes the long way round, or
    // a ring line where projection wraps). Follow the forecast points, then
    // continue straight to the target: the forecast alone spans only ~30 s, so a
    // path that stopped there would strand the vehicle short of its stop.
    const last = f.pts[f.pts.length - 1]
    const to: [number, number] = [target.lat, target.lon]
    path = metresBetween(last, to) > 25 ? [...f.pts, to] : [...f.pts]
  }
```

Note the short-circuit: `tooFast()` no longer runs when `badFit()` already failed, so the two counters do not double-count and `alongsOnPath` is not computed needlessly.

**Step 2: Expose it on the debug handle**

Find the `window.__lb` object (around `src/main.ts:650`) and add alongside `get lineShapes()`:

```ts
  get guardStats() { return guardStats },
```

**Step 3: Record the baseline**

Run: `npm run dev`, open `http://localhost:5173/`, start recording from the debug panel, wait 100 s, stop, save.

Then:

```bash
node scripts/analyse-motion.mjs logs/motion-<timestamp>.ndjson
```

Write the numbers into this plan under "Baseline" below, plus `window.__lb.guardStats` read from the browser console.

**Baseline (fill in during execution):**

```
rebuilds: ____   badFit: ____ (__%)   tooFast: ____ (__%)
reversals: ____  overspeed: ____  freezes: ____
drift: median ____ m  p90 ____ m  max ____ m
routes.json: ____ KB raw / ____ KB gz, ____ shapes
```

**Step 4: Commit**

```bash
git add src/main.ts docs/plans/2026-08-24-per-variant-route-shapes.md
git commit -m "test: count how often the shape-fit guards reject the GTFS track"
```

---

## Task 1: Douglas–Peucker simplification

Naive `decimate()` (`scripts/prepare-data.mjs:164-170`) keeps every Nth point regardless of geometry. It wastes points on straight runs and cuts corners on tight curves — a direct cause of the ~100 m residual noise band the 250 m guard was sized around. Douglas–Peucker keeps a point only when dropping it would move the line by more than a tolerance, so it is both smaller and more faithful.

Build-time only. The runtime never simplifies, so there is one copy, in `scripts/`, and no TypeScript version (YAGNI).

**Files:**
- Create: `scripts/simplify.mjs`
- Test: `scripts/simplify.test.mjs`

**Step 1: Write the failing test**

Create `scripts/simplify.test.mjs`:

```js
import {describe, expect, it} from 'vitest'
import {simplifyPath} from './simplify.mjs'

/** metres north of a base latitude, as [lat, lon] */
const north = (m, lon = 13.4) => [52.5 + m / 111320, lon]
/** metres east of a base longitude */
const east = (m, lat = 52.5) => [lat, 13.4 + m / (111320 * Math.cos(lat * Math.PI / 180))]

describe('simplifyPath', () => {
  it('keeps both endpoints', () => {
    const pts = [north(0), north(50), north(100)]
    const out = simplifyPath(pts, 10)
    expect(out[0]).toEqual(pts[0])
    expect(out[out.length - 1]).toEqual(pts[2])
  })

  it('drops a point that sits on the straight line between its neighbours', () => {
    expect(simplifyPath([north(0), north(50), north(100)], 10)).toHaveLength(2)
  })

  it('keeps a point that bends the line by more than the tolerance', () => {
    // a 100 m dog-leg east, far outside a 10 m tolerance
    const pts = [north(0), east(100), north(200)]
    expect(simplifyPath(pts, 10)).toHaveLength(3)
  })

  it('drops a bend smaller than the tolerance', () => {
    const pts = [north(0), [north(100)[0], east(3)[1]], north(200)]
    expect(simplifyPath(pts, 10)).toHaveLength(2)
  })

  it('returns short inputs unchanged', () => {
    expect(simplifyPath([], 10)).toEqual([])
    expect(simplifyPath([north(0)], 10)).toHaveLength(1)
    expect(simplifyPath([north(0), north(9)], 10)).toHaveLength(2)
  })

  it('never moves the line by more than the tolerance', () => {
    // a quarter circle of radius 500 m, 200 points
    const pts = []
    for (let i = 0; i < 200; i++) {
      const a = (i / 199) * Math.PI / 2
      pts.push([52.5 + (500 * Math.sin(a)) / 111320,
                13.4 + (500 * Math.cos(a)) / (111320 * Math.cos(52.5 * Math.PI / 180))])
    }
    const out = simplifyPath(pts, 10)
    expect(out.length).toBeLessThan(pts.length)
    // every original point stays within tolerance of the simplified line
    for (const p of pts) {
      let best = Infinity
      for (let i = 1; i < out.length; i++) best = Math.min(best, distToSegM(p, out[i - 1], out[i]))
      expect(best).toBeLessThanOrEqual(10.001)
    }
  })

  it('handles a path with repeated identical points', () => {
    const out = simplifyPath([north(0), north(0), north(0), north(100)], 10)
    expect(out).toHaveLength(2)
  })
})

// local copy of the metric, so the test does not depend on the implementation's internals
function distToSegM(p, a, b) {
  const k = 111320, kx = k * Math.cos(52.5 * Math.PI / 180)
  const [py, px] = [(p[0] - a[0]) * k, (p[1] - a[1]) * kx]
  const [by, bx] = [(b[0] - a[0]) * k, (b[1] - a[1]) * kx]
  const len2 = by * by + bx * bx
  if (len2 === 0) return Math.hypot(py, px)
  const t = Math.max(0, Math.min(1, (py * by + px * bx) / len2))
  return Math.hypot(py - by * t, px - bx * t)
}
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/simplify.test.mjs`
Expected: FAIL — `Failed to resolve import "./simplify.mjs"`

**Step 3: Write the implementation**

Create `scripts/simplify.mjs`:

```js
// Douglas-Peucker path simplification, in metres.
//
// Replaces blind Nth-point decimation: that wasted points on straight runs and
// cut corners on curves, which is what put GTFS-track residuals in a ~100 m
// noise band. This keeps a point only when dropping it would move the line by
// more than `toleranceM`, so the error is bounded by construction.

const MPD_LAT = 111320

/** Perpendicular distance from `p` to segment `a`-`b`, in metres. */
function distToSegM(p, a, b) {
  const kx = MPD_LAT * Math.cos((a[0] * Math.PI) / 180)
  const py = (p[0] - a[0]) * MPD_LAT
  const px = (p[1] - a[1]) * kx
  const by = (b[0] - a[0]) * MPD_LAT
  const bx = (b[1] - a[1]) * kx
  const len2 = by * by + bx * bx
  if (len2 === 0) return Math.hypot(py, px)
  const t = Math.max(0, Math.min(1, (py * by + px * bx) / len2))
  return Math.hypot(py - by * t, px - bx * t)
}

/**
 * Simplify `pts` (an array of `[lat, lon]`) so no original point is further
 * than `toleranceM` from the result. Endpoints are always kept.
 *
 * Iterative, not recursive: GTFS shapes reach tens of thousands of points and
 * a recursive version can blow the stack on a degenerate input.
 */
export function simplifyPath(pts, toleranceM) {
  if (pts.length <= 2) return pts.slice()
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()
    let worst = -1
    let worstAt = -1
    for (let i = lo + 1; i < hi; i++) {
      const d = distToSegM(pts[i], pts[lo], pts[hi])
      if (d > worst) {
        worst = d
        worstAt = i
      }
    }
    if (worst > toleranceM && worstAt > lo && worstAt < hi) {
      keep[worstAt] = 1
      stack.push([lo, worstAt], [worstAt, hi])
    }
  }
  const out = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i])
  return out
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/simplify.test.mjs`
Expected: PASS, 7 tests

**Step 5: Commit**

```bash
git add scripts/simplify.mjs scripts/simplify.test.mjs
git commit -m "feat: Douglas-Peucker path simplification for build-time shapes"
```

---

## Task 2: Report the shape inventory before changing any output

Payload size is the one real risk here, and it is currently unknown: nobody has counted the distinct shapes per line in the VBB feed. Measure first, in a step that writes nothing.

**Files:**
- Modify: `scripts/prepare-data.mjs` (insert after line 162, before `const decimate`)

**Step 1: Add the report**

Insert after the `lineBest` loop (`scripts/prepare-data.mjs:162`):

```js
  // ---- inventory report: how many distinct variants per line, and at what cost? ----
  // Writes nothing. Payload size is the deciding constraint for per-variant
  // shapes, so measure it before changing any output.
  {
    const perLine = new Map() // shortName -> Set(shapeId)
    for (const [routeId, {shortName}] of railRoutes) {
      for (const t of routeTrips.get(routeId) ?? []) {
        if (!t.shapeId || !shapePts.has(t.shapeId)) continue
        if (!perLine.has(shortName)) perLine.set(shortName, new Set())
        perLine.get(shortName).add(t.shapeId)
      }
    }
    const counts = [...perLine].map(([l, s]) => [l, s.size]).sort((a, b) => b[1] - a[1])
    const totalShapes = counts.reduce((n, [, c]) => n + c, 0)
    let rawPts = 0, simpPts = 0
    for (const s of perLine.values()) {
      for (const id of s) {
        const pts = shapePts.get(id)
        rawPts += pts.length
        simpPts += simplifyPath(pts, 10).length
      }
    }
    console.log(`\n--- shape inventory`)
    console.log(`  distinct shapes across rail lines: ${totalShapes} (vs ${lineBest.size} shipped today)`)
    console.log(`  points: ${rawPts.toLocaleString('en-US')} raw -> ${simpPts.toLocaleString('en-US')} simplified at 10 m`)
    console.log(`  worst lines: ${counts.slice(0, 8).map(([l, c]) => `${l}:${c}`).join('  ')}`)
    console.log(`  median variants per line: ${counts[Math.floor(counts.length / 2)]?.[1]}\n`)
  }
```

Add the import at the top of the file, next to the other imports:

```js
import {simplifyPath} from './simplify.mjs'
```

**Step 2: Run it and read the numbers**

Run: `npm run prepare:data`
Expected: the existing `PASS` gates, plus the new `--- shape inventory` block. Outputs are still written unchanged, so nothing regresses.

**Step 3: Decide the dedupe budget from what it says**

Record the numbers here:

```
distinct shapes: ____   simplified points: ____   worst line: ____ variants
```

Then pick `MAX_VARIANTS_PER_LINE` so the projected payload stays inside the 250 KB gzipped budget. Estimate: today 48 shapes at ≤500 points cost 76 KB gzipped, so budget roughly 150 bytes gzipped per point-heavy shape and confirm against the real gzip in Task 3.

If `distinct shapes` exceeds ~600, add near-duplicate collapsing in Task 3 (below). If it is under ~250, skip the cap entirely and say so.

**Step 4: Commit**

```bash
git add scripts/prepare-data.mjs
git commit -m "chore: report the GTFS shape inventory per line"
```

---

## Task 3: Emit every distinct variant, simplified

**Files:**
- Modify: `scripts/prepare-data.mjs:153-181` (replace `lineBest` + `decimate` + `routeFeatures`)
- Modify: `scripts/prepare-data.mjs:220-244` (sanity gates)

**Step 1: Replace the shape selection**

Replace the `lineBest` loop (lines 153-162) — keep the inventory block from Task 2 — and the `decimate` helper (164-170) and `routeFeatures` loop (172-181) with:

```js
  // ---- routes.json: every distinct variant per line, simplified ----
  // One shape per line NAME was the old behaviour and the root cause of the
  // runtime fit guards: branch variants (S1, M5, tram 12) and the two ring
  // directions (S41/S42) do not share geometry, so projection landed
  // kilometres away. Ship them all; the runtime picks by forecast fit.
  const SIMPLIFY_M = 10
  const MAX_VARIANTS_PER_LINE = 12 // revisit with the Task 2 inventory numbers

  /** Collapse variants whose geometry is effectively the same. */
  const variantKey = pts => {
    const r = ([lat, lon]) => `${lat.toFixed(4)},${lon.toFixed(4)}` // ~11 m
    const mid = pts[Math.floor(pts.length / 2)]
    return `${r(pts[0])}|${r(mid)}|${r(pts[pts.length - 1])}|${pts.length}`
  }

  const lineVariants = new Map() // shortName -> {product, variants: Map(key -> pts)}
  for (const [routeId, {shortName, product}] of railRoutes) {
    for (const t of routeTrips.get(routeId) ?? []) {
      const raw = t.shapeId ? shapePts.get(t.shapeId) : undefined
      if (!raw || raw.length < 2) continue
      const deduped = raw.filter((p, i) => i === 0 || p[0] !== raw[i - 1][0] || p[1] !== raw[i - 1][1])
      if (deduped.length < 2) continue
      const pts = simplifyPath(deduped, SIMPLIFY_M)
      if (!lineVariants.has(shortName)) lineVariants.set(shortName, {product, variants: new Map()})
      const v = lineVariants.get(shortName).variants
      const key = variantKey(pts)
      // keep the longest of any near-duplicate group: it covers the most track
      const cur = v.get(key)
      if (!cur || pts.length > cur.length) v.set(key, pts)
    }
  }

  const routeFeatures = []
  for (const [line, {product, variants}] of [...lineVariants.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // longest first, so the cap keeps the most complete variants
    const kept = [...variants.values()].sort((a, b) => b.length - a.length).slice(0, MAX_VARIANTS_PER_LINE)
    for (const pts of kept) {
      routeFeatures.push({
        type: 'Feature',
        geometry: {type: 'LineString', coordinates: pts.map(([lat, lon]) => [lon, lat])},
        properties: {line, product}
      })
    }
  }
  console.log(`route variants: ${routeFeatures.length} across ${lineVariants.size} lines`)
```

**Step 2: Update the sanity gates**

The `routes 40-60` gate (line 227) now counts variants, not lines, and `lineBest` no longer exists (line 223 uses it). Replace the `checks` block (lines 221-232) with:

```js
  const lineNames = [...new Set(routeFeatures.map(f => f.properties.line))]
  const bad = lineNames.filter(n => /^(RE|RB|FEX|ICE)/.test(n))
  const tramLines = lineNames.filter(n => lineVariants.get(n).product === 'tram')
  const missingU = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9'].filter(n => !lineNames.includes(n))
  const routesBytes = Buffer.byteLength(JSON.stringify({type: 'FeatureCollection', features: routeFeatures}))
  const routesGz = zlib.gzipSync(JSON.stringify({type: 'FeatureCollection', features: routeFeatures})).length
  const checks = [
    ['stations in low thousands', stationFeatures.length >= 500 && stationFeatures.length <= 15000],
    ['lines 40-60', lineNames.length >= 40 && lineNames.length <= 60],
    ['variants more than lines', routeFeatures.length > lineNames.length],
    ['routes.json under 250 KB gzipped', routesGz <= 250 * 1024],
    ['no RE/RB/FEX/ICE routes', bad.length === 0],
    ['S41/S42 present', lineNames.includes('S41') && lineNames.includes('S42')],
    ['U1-U9 present', missingU.length === 0],
    ['trams present (>=10)', tramLines.length >= 10]
  ]
```

Add `import zlib from 'node:zlib'` to the imports, and extend the success log (line 242):

```js
    console.log(`stations: ${stationFeatures.length} · route variants: ${routeFeatures.length} · lineColors: ${colorEntries.length}`)
    console.log(`routes.json: ${(routesBytes / 1024).toFixed(0)} KB raw / ${(routesGz / 1024).toFixed(0)} KB gzipped`)
```

Note `railNames` (line 203) already derives from `routeFeatures.map(f => f.properties.line)`, and a `Set` de-duplicates, so the colour filter needs no change.

**Step 3: Run it**

Run: `npm run prepare:data`
Expected: all gates `PASS`, variant count clearly above 48, and the gzipped size printed and under budget.

If `routes.json under 250 KB gzipped` fails, lower `MAX_VARIANTS_PER_LINE` or raise `SIMPLIFY_M` to 15, and re-run. Do not weaken the gate.

**Step 4: Commit**

```bash
git add scripts/prepare-data.mjs public/routes.json src/line-colors.ts
git commit -m "feat: ship every distinct route variant, simplified to 10 m"
```

---

## Task 4: Pick the variant the forecast lies on

**Files:**
- Modify: `src/motion.ts` (export `maxResidualM`, moved from `main.ts`)
- Modify: `src/track.ts` (`LineShapes` type, `pickShape`, `buildSegmentPath`)
- Modify: `src/main.ts:107,177-181,213,418-427`
- Test: `src/motion.test.ts`, `src/track.test.ts`

**Step 1: Write the failing tests**

`maxResidualM` currently lives in `src/main.ts:177-181` and is untested. It is about to have two callers, so move it to `src/motion.ts` next to the functions it already uses (`metresBetween`, `projectOntoPath`). Append to `src/motion.test.ts`:

```ts
describe('maxResidualM', () => {
  const straight: Array<[number, number]> = [[52.5, 13.4], [52.51, 13.4]]

  it('is zero for points that sit on the path', () => {
    expect(maxResidualM(straight, [[52.505, 13.4]])).toBeCloseTo(0, 6)
  })

  it('reports the worst offset, not the average', () => {
    const east = 13.4 + 100 / (111320 * Math.cos(52.5 * Math.PI / 180))
    expect(maxResidualM(straight, [[52.505, 13.4], [52.506, east]])).toBeCloseTo(100, 0)
  })

  it('is zero for an empty point list', () => {
    expect(maxResidualM(straight, [])).toBe(0)
  })
})
```

Append to `src/track.test.ts`:

```ts
describe('pickShape', () => {
  // two variants of one line: a straight run north, and a branch bending east
  const north: Array<[number, number]> = [[52.50, 13.40], [52.53, 13.40]]
  const east: Array<[number, number]> = [[52.50, 13.40], [52.51, 13.45]]

  it('returns undefined when there are no shapes', () => {
    expect(pickShape(undefined, [[52.5, 13.4]])).toBeUndefined()
    expect(pickShape([], [[52.5, 13.4]])).toBeUndefined()
  })

  it('returns the only shape when there is one', () => {
    expect(pickShape([north], [[52.51, 13.4]])).toBe(north)
  })

  it('picks the variant the forecast points lie on', () => {
    expect(pickShape([north, east], [[52.505, 13.425]])).toBe(east)
    expect(pickShape([north, east], [[52.52, 13.400]])).toBe(north)
  })

  it('falls back to the first shape when the forecast is empty', () => {
    expect(pickShape([north, east], [])).toBe(north)
  })

  it('still returns the best shape even when none fits well', () => {
    // 40 km away: nothing fits, but a caller-side guard decides what to do
    expect(pickShape([north, east], [[52.9, 13.4]])).toBeDefined()
  })
})

describe('buildSegmentPath with variants', () => {
  const north: Array<[number, number]> = [[52.50, 13.40], [52.53, 13.40]]
  const east: Array<[number, number]> = [[52.50, 13.40], [52.51, 13.45]]

  it('slices the variant that matches the forecast', () => {
    const shapes = {U8: [north, east]}
    const path = buildSegmentPath(shapes, 'U8', {lat: 52.502, lon: 13.41}, {lat: 52.509, lon: 13.44}, [[52.505, 13.425]])
    // the branch runs east, so the sliced path must gain longitude
    expect(path[path.length - 1][1]).toBeGreaterThan(13.42)
  })

  it('still works with no forecast hint', () => {
    const shapes = {U8: [north]}
    const path = buildSegmentPath(shapes, 'U8', {lat: 52.505, lon: 13.4}, {lat: 52.52, lon: 13.4})
    expect(path.length).toBeGreaterThanOrEqual(2)
  })

  it('falls back to a straight line for an unknown line', () => {
    expect(buildSegmentPath({}, 'X99', {lat: 1, lon: 2}, {lat: 3, lon: 4}))
      .toEqual([[1, 2], [3, 4]])
  })
})
```

Update the import lines at the top of both test files to include `maxResidualM` and `pickShape`.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/track.test.ts src/motion.test.ts`
Expected: FAIL — `pickShape` and `maxResidualM` are not exported

**Step 3: Implement**

In `src/motion.ts`, add after `metresBetween`:

```ts
/**
 * Worst distance from any point in `pts` to `path`, in metres. Used both to
 * choose between route variants and to reject a track the forecast does not
 * lie on. Worst, not average: one point kilometres off means the wrong track,
 * however well the rest happens to line up.
 */
export function maxResidualM(path: Array<[number, number]>, pts: Array<[number, number]>): number {
  let worst = 0
  for (const pt of pts) worst = Math.max(worst, metresBetween(pt, projectOntoPath(path, {lat: pt[0], lon: pt[1]}).point))
  return worst
}
```

Replace `src/track.ts` entirely:

```ts
import {LatLon, maxResidualM, projectOntoPath, slicePath} from './motion.js'

/** One route variant: an ordered list of lat/lon points. */
export type Shape = Array<[number, number]>

/**
 * Route variants keyed by line name. A line has more than one because branches
 * and short turns do not share geometry, and the two ring directions (S41/S42)
 * run different track. Shipping only one per line was the root cause of the
 * runtime fit guards in main.ts.
 */
export type LineShapes = Record<string, Shape[]>

/**
 * Choose the variant that the operator's forecast points actually lie on.
 *
 * The forecast is the only evidence we have of which branch a vehicle is on:
 * HAFAS names the next stop but not the route taken to reach it, and a headsign
 * does not identify a route (live U7 shows six destinations for a two-terminus
 * line). Returns the best variant regardless of how well it fits; the caller
 * applies its own limit, so the fit threshold stays in one place.
 */
export function pickShape(shapes: Shape[] | undefined, pts: Shape): Shape | undefined {
  if (!shapes || shapes.length === 0) return undefined
  if (shapes.length === 1 || pts.length === 0) return shapes[0]
  let best = shapes[0]
  let bestResidual = Infinity
  for (const shape of shapes) {
    if (shape.length < 2) continue
    const r = maxResidualM(shape, pts)
    if (r < bestResidual) {
      bestResidual = r
      best = shape
    }
  }
  return best
}

/**
 * Build the track path for a vehicle segment: the slice of the line's shape
 * between `from` (the animated position) and `to` (the next stop), handling
 * shape direction. `hint` is the forecast, used to choose between variants.
 * Falls back to a straight line when no shape is usable.
 */
export function buildSegmentPath(
  lineShapes: LineShapes,
  line: string | undefined,
  from: LatLon,
  to: LatLon,
  hint: Shape = []
): Shape {
  const shape = pickShape(line ? lineShapes[line] : undefined, hint)
  if (shape && shape.length >= 2) {
    const a = projectOntoPath(shape, from)
    const b = projectOntoPath(shape, to)
    if (b.along > a.along + 1e-9) {
      return slicePath(shape, a.along, b.along)
    }
    if (a.along > b.along + 1e-9) {
      // shape runs opposite to travel direction: reverse the sliced path so
      // index 0 is the vehicle position
      return slicePath(shape, b.along, a.along).reverse()
    }
  }
  return [[from.lat, from.lon], [to.lat, to.lon]]
}
```

In `src/main.ts`:

- Delete the local `maxResidualM` (lines 177-181) and import it from `./motion.js` instead, extending the existing motion import.
- Pass the forecast at line 213:

```ts
  let path = buildSegmentPath(lineShapes, v.line, start, {lat: target.lat, lon: target.lon}, f.pts)
```

- Change the loader (lines 418-427) to collect a list per line:

```ts
    const routes = await (await fetch('/routes.json')).json()
    lineShapes = {}
    for (const f of routes.features ?? []) {
      const line = f.properties?.line
      const coords = f.geometry?.coordinates
      if (line && Array.isArray(coords) && coords.length >= 2) {
        // GeoJSON [lon, lat] -> [lat, lon]; several variants share a line name
        ;(lineShapes[line] ??= []).push(coords.map((c: [number, number]) => [c[1], c[0]]))
      }
    }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run` then `npm run build`
Expected: all tests PASS, `tsc --noEmit` clean

**Step 5: Commit**

```bash
git add src/motion.ts src/motion.test.ts src/track.ts src/track.test.ts src/main.ts
git commit -m "feat: pick the route variant the operator's forecast lies on"
```

---

## Task 5: Prove it, and only then relax the guards

**Files:**
- Modify: `src/main.ts` (guard comments/constants), `AGENTS.md`

**Step 1: Record and compare**

Run: `npm run dev`, record 100 s of the full vehicle set, save, then:

```bash
node scripts/analyse-motion.mjs logs/motion-<new>.ndjson
```

Read `window.__lb.guardStats` in the browser console. Fill in:

```
              baseline   after
rebuilds      ____       ____
badFit        ____       ____
tooFast       ____       ____
reversals     ____       ____
overspeed     ____       ____
drift median  ____ m     ____ m
drift p90     ____ m     ____ m
routes.json   76 KB gz   ____ KB gz
```

**Step 2: Decide from the numbers, not from hope**

- If `badFit` and `tooFast` are both near zero, **keep both guards** and update their comments to say they are now backstops rather than routine. Do not delete a safety net just because it stopped firing; note the measured rate in the comment.
- If `badFit` is still material, the variant set is incomplete. Do not raise `SHAPE_FIT_LIMIT_M`. Instead re-read the Task 2 inventory: either `MAX_VARIANTS_PER_LINE` is cutting real variants, or `variantKey` is collapsing distinct ones. Fix the build step.
- If drift p90 got worse, stop and investigate before committing. A better track should not move the badge further from the reported position.

**Step 3: Record the invariants**

Add to `AGENTS.md` under the measured-invariants section:

```markdown
- `public/routes.json` holds **several variants per line name**, not one. A line
  has branches and short turns, and the ring directions (S41/S42) run different
  track. `pickShape` chooses by forecast fit — the forecast is the only evidence
  of which branch a vehicle is on, because HAFAS names the next stop but not the
  route to it, and a headsign is not a route (live U7: six destinations, two
  termini).
- Build-time shapes are simplified with Douglas–Peucker at 10 m, not decimated
  to a point count. Nth-point decimation cut corners and put residuals in a
  ~100 m band, which is what `SHAPE_FIT_LIMIT_M` was originally sized around.
```

**Step 4: Commit**

```bash
git add src/main.ts AGENTS.md docs/plans/2026-08-24-per-variant-route-shapes.md
git commit -m "docs: record per-variant shape invariants and the measured guard rates"
```

---

## Task 6: Merge

**Step 1: Full verification**

```bash
npm test && npm run build
```
Expected: all tests PASS, build clean.

**Step 2: Confirm the payload in a real build**

```bash
ls -la dist/ && gzip -c public/routes.json | wc -c
```
Expected: gzipped `routes.json` under 250 KB.

**Step 3: Merge**

REQUIRED SUB-SKILL: use superpowers:finishing-a-development-branch.

---

## Risks

| Risk | Signal | Response |
|---|---|---|
| payload grows too much | Task 2 inventory, gzip gate | raise `SIMPLIFY_M`, lower `MAX_VARIANTS_PER_LINE` |
| `pickShape` picks a plausible-but-wrong variant on a short forecast (~30 s, 4 points) | `badFit` stays high, or drift p90 worsens | tie-break on the declared `toStop` lying on the variant |
| `variantKey` collapses genuinely different variants | `badFit` stays high on specific lines | key on more sample points, or on the full stop set |
| `pickShape` runs per segment rebuild, so per poll per vehicle — up to 12 residual computations against 300 vehicles | frame time in the recorder | cache the chosen variant on `AnimState` and re-pick only when `toStop` changes |
| GTFS refresh changes variant counts | gates fail on `npm run prepare:data` | gates block the write; they never overwrite good assets with bad |

The cache in row 4 is the most likely follow-up. It is deliberately not in the plan: measure first.

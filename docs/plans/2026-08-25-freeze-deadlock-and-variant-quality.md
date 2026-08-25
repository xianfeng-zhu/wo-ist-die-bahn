# Freeze Deadlock and Variant Quality Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop vehicles freezing permanently, and stop shipping route variants that cannot be told apart.

**Architecture:** Two independent causes, fixed separately. (1) `forwardStep` refuses to move a badge against its heading, and the heading only updates when the badge moves — a deadlock with no escape. Time-box the hold. (2) `prepare-data.mjs` ships 365 redundant sub-slices of other variants, and `maxResidualM` measures distance in degree space with a bearing-dependent bias as large as the signal it discriminates on. Prune the redundancy and fix the metric, so variant choice stops flipping between polls.

**Tech Stack:** Vanilla TypeScript + Vite, Vitest, Node ESM build script, `MotionRecorder` + Playwright for the same three-arm A/B used on the previous branch.

---

## Evidence this is built on

Measured on `feat/per-variant-shapes` (this branch's parent), live data, ~330 vehicles.

**The freeze deadlock.** 33.5% of vehicle-samples show a still badge while the operator's forecast says the vehicle is moving. Eight stuck vehicles caught mid-freeze: **all eight had `correcting: true`**, with the gap between drawn and computed position ranging 3 m to **5,697 m**. Vehicles sit at a path *end* only 6.5% of the time and the forecast is *never* exhausted, so "ran out of path" and coasting are both ruled out.

**Variant redundancy.** 365 of 533 shipped variants (68%) lie entirely within 50 m of a longer variant of the same line. On 13 lines, 11 of 12 kept variants are contained in the longest. Pruning them drops ambiguity (choices tied within 0.5 m) from 83% to 53%, cuts candidates-within-1 m from 3 to 2, and shrinks the file from 533 to 179 features.

**Metric bias.** `projectOntoPath` finds the nearest point in degree space, treating 1° lon as 1° lat; at Berlin 1° lon is 0.61 of 1° lat. The residual `maxResidualM` reports overstates true distance by a mean 1.8 m, up to 7.5 m, varying with the segment's bearing. Since 310 of 319 vehicles sit within 5 m of the best fit, the bias is the same order as the signal.

**Dedupe is near-inert.** `corridorKey` samples by *index* fraction; after Douglas–Peucker vertex density tracks curviness, so the sampled point sits a median 574 m from the distance-fraction point. 515 of 530 geometrically identical corridor pairs get different fingerprints. Observed collapse was only 2,179 → 1,801.

**Cap ranks by the wrong quantity.** Point count and length disagree on 14% of pairs. S7's 48 km full-line variant has 117 points and survived at rank 11 of 12 — one slot from being dropped, which would strand its own subsets.

**Gates cannot catch a disaster.** Collapsing every shape to two endpoints passes every gate at 4.7 KB against a real 54 KB.

**Ties are broken, contrary to the comment.** `pickShape` uses a strict `<`, so ties go to the earlier array element, and `prepare-data.mjs` emits descending by point count. 83% of choices are ties, so this is the dominant path, not an edge case.

## Deliberate deviations from the review

- **Not** changing `projectOntoPath`'s degree-space parameterisation. `pointAlongPath` and `slicePath` share those units and all three must agree; changing them is core animation maths for a benefit that lands almost entirely on residual comparison. Instead `maxResidualM` gets its own true-metre metric. The remaining approximation gets documented.
- **Not** adding "snap when the gap is absurd". The time-box alone breaks the deadlock, and snapping would undo the earlier fix that made corrections glide instead of blink. One mechanism, not two.

## Definition of done

1. No vehicle can be held still for longer than `MAX_HOLD_MS` while its forecast says it is moving.
2. "Badge still while forecast moving" falls well below 33.5% of samples.
3. Freezes per 100 s at or below the 8.6 baseline.
4. Reversals stay at 0. Drift median and p90 no worse than the parent branch (5 m / 61 m).
5. `routes.json` shrinks, and `badFit` stays at or below 0.25% of rebuilds.
6. A gate rejects geometry collapsed to endpoints.
7. `npm test` green, `npm run build` clean.

## Out of scope

- `pickShape` hysteresis on `AnimState`. Pruning attacks the same problem at its source; measure before adding state.
- The commented-out `routes-layer` / `stations-layer`.
- NaN hardening beyond one gate (`prepare-data.mjs:129` can produce NaN from a malformed row).

---

## Task 1: Break the freeze deadlock

The highest-value fix and independent of everything else, so it goes first.

**Files:**
- Modify: `src/motion.ts` (`forwardStep`, `AnimState`)
- Modify: `src/main.ts:306-309`
- Test: `src/motion.test.ts`

**Step 1: Write the failing tests**

Replace the `forwardStep` describe block in `src/motion.test.ts` with:

```ts
describe('forwardStep', () => {
  const p0: [number, number] = [52.52, 13.405]
  const north = (m: number): [number, number] => [52.52 + m / 111320, 13.405]

  it('moves forward when the target is ahead', () => {
    const r = forwardStep(p0, north(0.4), [1, 0], 16, 0)
    expect(r.pos[0]).toBeGreaterThan(p0[0])
    expect(r.held).toBe(false)
  })

  it('holds instead of reversing when the target is behind', () => {
    const r = forwardStep(north(10), north(4), [1, 0], 16, 0)
    expect(r.pos).toEqual(north(10))
    expect(r.held).toBe(true)
  })

  it('moves freely when no heading is known yet', () => {
    const r = forwardStep(north(10), north(4), null, 16, 0)
    expect(r.pos[0]).toBeLessThan(north(10)[0])
    expect(r.held).toBe(false)
  })

  it('still rate-limits a forward correction', () => {
    const r = forwardStep(north(0), north(4000), [1, 0], 16, 0)
    expect(metresBetween(north(0), r.pos)).toBeLessThanOrEqual(CATCHUP_MAX_STEP + 1e-6)
  })

  // The deadlock: a held badge does not move, so main.ts never refreshes its
  // heading, so the hold can never end. Measured on live data: 8 of 8 vehicles
  // caught mid-freeze were correcting, with gaps up to 5,697 m.
  it('yields once it has been held for MAX_HOLD_MS', () => {
    const r = forwardStep(north(10), north(4), [1, 0], 16, MAX_HOLD_MS)
    expect(r.pos[0]).toBeLessThan(north(10)[0])
    expect(r.held).toBe(false)
  })

  it('keeps holding while under the limit', () => {
    expect(forwardStep(north(10), north(4), [1, 0], 16, MAX_HOLD_MS - 1).held).toBe(true)
  })

  it('cannot be held indefinitely by a target that stays behind it', () => {
    // replay frames with a target permanently behind: it must move eventually
    let pos = north(10)
    let heldMs = 0
    const heading: [number, number] = [1, 0]
    for (let i = 0; i < 1000; i++) {
      const r = forwardStep(pos, north(4), heading, 16, heldMs)
      heldMs = r.held ? heldMs + 16 : 0
      pos = r.pos
      if (!r.held) break
    }
    expect(pos[0]).toBeLessThan(north(10)[0])
    expect(heldMs).toBeLessThanOrEqual(MAX_HOLD_MS)
  })

  it('reaches a target far behind it rather than staying stuck', () => {
    // the 5,697 m case: it must converge, not deadlock
    let pos = north(6000)
    let heldMs = 0
    let heading: [number, number] | null = [1, 0]
    for (let i = 0; i < 4000 && metresBetween(pos, north(0)) > 5; i++) {
      const r = forwardStep(pos, north(0), heading, 16, heldMs)
      heldMs = r.held ? heldMs + 16 : 0
      if (!r.held) {
        const move: [number, number] = [r.pos[0] - pos[0], r.pos[1] - pos[1]]
        if (metresBetween(pos, r.pos) >= 0.3) heading = move
      }
      pos = r.pos
    }
    expect(metresBetween(pos, north(0))).toBeLessThanOrEqual(5)
  })
})
```

Add `MAX_HOLD_MS` to the import at the top of the file.

**Step 2: Run to verify failure**

Run: `npx vitest run src/motion.test.ts`
Expected: FAIL — `MAX_HOLD_MS` not exported, and `forwardStep` returns a tuple not an object.

**Step 3: Implement**

In `src/motion.ts`, add to `AnimState`:

```ts
  /** How long `forwardStep` has been blocking movement (see MAX_HOLD_MS). */
  heldMs?: number
```

Replace `forwardStep`:

```ts
/**
 * Longest a forward-only hold may block movement.
 *
 * Without this the hold is a deadlock: a held badge does not move, so main.ts
 * never refreshes its `heading` (it only updates on a move of >= 0.3 m), so the
 * hold can never end. The only escape was the target coming round to the front
 * again — on a ring line, a whole lap. Measured on live data: 33.5% of
 * vehicle-samples were still while the forecast said they were moving, and all 8
 * vehicles caught mid-freeze were correcting, with gaps up to 5,697 m.
 *
 * 2 s reads as a pause rather than a fault, and bounds the freeze by
 * construction. After yielding, the badge glides to the corrected position under
 * the usual rate limit, so a large correction is still never a blink.
 */
export const MAX_HOLD_MS = 2000

/**
 * Move `from` toward `to`, but not against `heading` — unless the hold has
 * already lasted `MAX_HOLD_MS`, in which case yield rather than deadlock.
 *
 * `stepTowards` has no sense of direction: when a poll corrects a badge to a
 * position BEHIND it, easing there drags it backwards. `drawnAlong` keeps
 * progress monotonic along one path, but a path swap re-projects the position,
 * so the guarantee has to be repeated here in position space. Holding briefly
 * reads as a pause; reversing reads as a bug; holding forever is worse than
 * either.
 *
 * Returns `held` so the caller can accumulate `AnimState.heldMs`.
 */
export function forwardStep(
  from: [number, number],
  to: [number, number],
  heading: [number, number] | null,
  dtMs: number,
  heldMs = 0
): {pos: [number, number]; held: boolean} {
  const next = stepTowards(from, to, dtMs)
  if (!heading) return {pos: next, held: false}
  const move: [number, number] = [next[0] - from[0], next[1] - from[1]]
  const backwards = heading[0] * move[0] + heading[1] * move[1] < 0
  if (!backwards || heldMs >= MAX_HOLD_MS) return {pos: next, held: false}
  return {pos: from, held: true}
}
```

In `src/main.ts`, replace lines 305-309:

```ts
      const from = s.renderPos
      if (from) {
        const step = forwardStep(from, target, s.heading ?? null, dtMs, s.heldMs ?? 0)
        s.renderPos = step.pos
        // reset on any move, so the allowance is per stall and not cumulative
        s.heldMs = step.held ? (s.heldMs ?? 0) + dtMs : 0
      } else {
        s.renderPos = target
        s.heldMs = 0
      }
      if (from && metresBetween(from, s.renderPos) >= 0.3) {
        s.heading = [s.renderPos[0] - from[0], s.renderPos[1] - from[1]]
      }
```

Carry `heldMs` across a segment rebuild in `updateSegment`, next to `renderPos` and `heading`:

```ts
    heldMs: prev?.heldMs,
```

**Step 4: Verify**

Run: `npx vitest run && npm run build`
Expected: all PASS, build clean.

**Step 5: Commit**

```bash
git add src/motion.ts src/motion.test.ts src/main.ts
git commit -m "fix: forward-only hold could deadlock a vehicle for good"
```

---

## Task 2: Measure the deadlock fix before touching anything else

Two independent fixes land on this branch; each needs its own attribution.

**Step 1: Record an arm**

`npm run dev`, open the page, then in the console:

```js
__lb.startRecording()
```

Wait 140 s, then:

```js
__lb.stopRecording()
```

Read `__lb.guardStats` too.

**Step 2: Re-run the stillness probe**

Paste the joint-distribution probe (badge moving vs forecast moving, sampled every 2 s for 100 s) and record `badgeStill_dataMoving_DEFECT`. Parent branch measured **33.5%**.

Do NOT run heavy geometry loops in the page during a recording — an earlier run doing ~8.6M distance computations every 2 s starved the rAF loop and reported 28 freezes/100 s for a build that cleanly measures 11.8.

**Step 3: Fill in**

```
badgeStill_dataMoving:  33.5%  ->  ____%
freezes per 100 s:      13.8   ->  ____
drift median / p90:     5 / 61 ->  ____ / ____
reversals:              0      ->  ____
```

If reversals rise above 0, `MAX_HOLD_MS` is too low — raise it rather than removing the yield.

---

## Task 3: Give `maxResidualM` a true-metre metric

`pickShape` discriminates on differences of a few metres, so a bearing-dependent bias of up to 7.5 m decides variant choice by compass direction.

**Files:**
- Modify: `src/motion.ts` (`maxResidualM`)
- Test: `src/motion.test.ts`

**Step 1: Write the failing tests**

```ts
describe('maxResidualM metric', () => {
  const m = (x: number) => x / 111320
  const lonM = (x: number) => x / (111320 * Math.cos((52.5 * Math.PI) / 180))

  it('measures the same offset the same way whichever way the track runs', () => {
    // one 1 km track north, one 1 km track east, each with a point 40 m to its side
    const northTrack: Array<[number, number]> = [[52.5, 13.4], [52.5 + m(1000), 13.4]]
    const eastTrack: Array<[number, number]> = [[52.5, 13.4], [52.5, 13.4 + lonM(1000)]]
    const offNorth = maxResidualM(northTrack, [[52.5 + m(500), 13.4 + lonM(40)]])
    const offEast = maxResidualM(eastTrack, [[52.5 + m(40), 13.4 + lonM(500)]])
    expect(offNorth).toBeCloseTo(40, 0)
    expect(offEast).toBeCloseTo(40, 0)
    expect(Math.abs(offNorth - offEast)).toBeLessThan(1)
  })

  it('reports a diagonal track accurately too', () => {
    const diag: Array<[number, number]> = [[52.5, 13.4], [52.5 + m(707), 13.4 + lonM(707)]]
    // a point 30 m perpendicular to a 45-degree track
    const perp: [number, number] = [52.5 + m(353 - 21.2), 13.4 + lonM(353 + 21.2)]
    expect(maxResidualM(diag, [perp])).toBeCloseTo(30, 0)
  })

  it('still returns 0 for points on the path and for an empty list', () => {
    const track: Array<[number, number]> = [[52.5, 13.4], [52.5 + m(1000), 13.4]]
    expect(maxResidualM(track, [[52.5 + m(500), 13.4]])).toBeCloseTo(0, 3)
    expect(maxResidualM(track, [])).toBe(0)
  })

  it('handles a zero-length segment without dividing by zero', () => {
    const degenerate: Array<[number, number]> = [[52.5, 13.4], [52.5, 13.4]]
    expect(maxResidualM(degenerate, [[52.5 + m(10), 13.4]])).toBeCloseTo(10, 0)
  })
})
```

**Step 2: Verify it fails**

Run: `npx vitest run src/motion.test.ts`
Expected: the bearing-symmetry test FAILS — the east track reads roughly 40/0.61 through degree-space projection.

**Step 3: Implement**

Replace `maxResidualM` in `src/motion.ts`:

```ts
/**
 * Worst distance from any point in `pts` to `path`, in metres.
 *
 * Measures perpendicular distance directly rather than going through
 * `projectOntoPath`, which finds its nearest point in DEGREE space (1 deg lon
 * treated as 1 deg lat; at Berlin longitude is 0.61 of that). That foot point is
 * not the true nearest one, and measuring it in metres overstated the residual
 * by a mean 1.8 m and up to 7.5 m, varying with the segment's bearing. Harmless
 * for a 250 m threshold, fatal for `pickShape`: it discriminates on differences
 * of a few metres, so the bias decided variant choice by compass direction.
 *
 * Worst, not average: one point kilometres off means the wrong track, however
 * well the rest lines up.
 */
export function maxResidualM(path: Array<[number, number]>, pts: Array<[number, number]>): number {
  let worst = 0
  for (const pt of pts) {
    let best = Infinity
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]
      const b = path[i]
      const kx = 111320 * Math.cos((a[0] * Math.PI) / 180)
      const py = (pt[0] - a[0]) * 111320
      const px = (pt[1] - a[1]) * kx
      const by = (b[0] - a[0]) * 111320
      const bx = (b[1] - a[1]) * kx
      const len2 = by * by + bx * bx
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (py * by + px * bx) / len2))
      best = Math.min(best, Math.hypot(py - by * t, px - bx * t))
    }
    worst = Math.max(worst, path.length < 2 ? metresBetween(pt, path[0] ?? pt) : best)
  }
  return worst
}
```

**Step 4: Verify and commit**

```bash
npx vitest run && npm run build
git add src/motion.ts src/motion.test.ts
git commit -m "fix: measure shape residuals in metres, not degree space"
```

---

## Task 4: Add an early exit to `pickShape`

34.6 ms per poll where 14.5 ms picks the identical variant. Same poll-time budget the animation competes for.

**Files:**
- Modify: `src/motion.ts` (add a `limit` parameter), `src/track.ts`
- Test: `src/motion.test.ts`, `src/track.test.ts`

**Step 1: Write the failing test**

```ts
it('stops early once it is already worse than the limit', () => {
  const long: Array<[number, number]> = []
  for (let i = 0; i < 500; i++) long.push([52.5 + i / 111320, 13.4])
  // a point 5 km away: with a 100 m limit the answer only has to exceed it
  const r = maxResidualM(long, [[52.6, 13.5]], 100)
  expect(r).toBeGreaterThan(100)
})

it('is unaffected by a limit it never reaches', () => {
  const track: Array<[number, number]> = [[52.5, 13.4], [52.5 + 1000 / 111320, 13.4]]
  const pts: Array<[number, number]> = [[52.5 + 500 / 111320, 13.4 + 40 / (111320 * Math.cos(52.5 * Math.PI / 180))]]
  expect(maxResidualM(track, pts, 1000)).toBeCloseTo(maxResidualM(track, pts), 6)
})
```

And in `src/track.test.ts`, pin that the early exit does not change the choice:

```ts
it('picks the same variant with or without the early exit', () => {
  const cands = [trunk, branch]
  const pts: Array<[number, number]> = [[52.50 + m(650), 13.4075]]
  // pickShape uses the limit internally; the result must match a full scan
  const full = cands.reduce((best, s) =>
    maxResidualM(s, pts) < maxResidualM(best, pts) ? s : best, cands[0])
  expect(pickShape(cands, pts)).toBe(full)
})
```

Import `maxResidualM` in `src/track.test.ts`.

**Step 2: Verify failure, then implement**

Add an optional `limit` to `maxResidualM`: once `worst` exceeds it, return immediately.

```ts
export function maxResidualM(
  path: Array<[number, number]>,
  pts: Array<[number, number]>,
  limit = Infinity
): number {
```

…and inside the outer loop, after updating `worst`:

```ts
    if (worst > limit) return worst
```

In `src/track.ts`, pass the running best as the limit:

```ts
  let best = usable[0]
  let bestResidual = Infinity
  for (const shape of usable) {
    const r = maxResidualM(shape, pts, bestResidual)
    if (r < bestResidual) {
      bestResidual = r
      best = shape
    }
  }
```

Note this is exact, not approximate: a candidate abandoned early is one already worse than the incumbent, so it could never have won.

**Step 3: Verify and commit**

```bash
npx vitest run && npm run build
git add src/motion.ts src/motion.test.ts src/track.ts src/track.test.ts
git commit -m "perf: abandon a shape residual once it cannot win"
```

---

## Task 5: Prune redundant variants and fix the build-step ranking

Three related defects in one file, so one change.

**Files:**
- Modify: `scripts/prepare-data.mjs`
- Test: `scripts/simplify.test.mjs` (new helpers get their own tests)

**Step 1: Write the failing tests**

New file `scripts/variants.test.mjs`:

```js
import {describe, expect, it} from 'vitest'
import {corridorKey, isContainedIn, pathMetres} from './variants.mjs'

const m = n => n / 111320
const northLine = (fromM, toM, stepM) => {
  const out = []
  for (let d = fromM; d <= toM; d += stepM) out.push([52.5 + m(d), 13.4])
  return out
}

describe('pathMetres', () => {
  it('measures length in metres', () => {
    expect(pathMetres(northLine(0, 1000, 500))).toBeCloseTo(1000, 0)
  })
  it('is zero for a single point', () => {
    expect(pathMetres([[52.5, 13.4]])).toBe(0)
  })
})

describe('corridorKey', () => {
  it('gives the same key to the same corridor recorded at different densities', () => {
    // the defect being fixed: index-fraction sampling made these differ
    expect(corridorKey(northLine(0, 3000, 20))).toBe(corridorKey(northLine(0, 3000, 137)))
  })

  it('gives the same key when vertex density is uneven', () => {
    const dense = [...northLine(0, 500, 10), ...northLine(600, 3000, 400)]
    expect(corridorKey(dense)).toBe(corridorKey(northLine(0, 3000, 100)))
  })

  it('gives different keys to different corridors', () => {
    const east = []
    for (let d = 0; d <= 3000; d += 100) east.push([52.5, 13.4 + d / (111320 * Math.cos(52.5 * Math.PI / 180))])
    expect(corridorKey(northLine(0, 3000, 100))).not.toBe(corridorKey(east))
  })

  it('gives different keys to a route and its half-length short turn', () => {
    expect(corridorKey(northLine(0, 3000, 100))).not.toBe(corridorKey(northLine(0, 1500, 100)))
  })
})

describe('isContainedIn', () => {
  it('reports a short turn as contained in the full route', () => {
    expect(isContainedIn(northLine(500, 2000, 100), northLine(0, 3000, 100), 50)).toBe(true)
  })

  it('reports a diverging branch as not contained', () => {
    const branch = [[52.5 + m(1000), 13.4], [52.5 + m(1200), 13.45]]
    expect(isContainedIn(branch, northLine(0, 3000, 100), 50)).toBe(false)
  })

  it('is not fooled by a branch that only leaves at the very end', () => {
    const late = [...northLine(0, 2800, 100), [52.5 + m(2900), 13.44]]
    expect(isContainedIn(late, northLine(0, 3000, 100), 50)).toBe(false)
  })

  it('reports an identical route as contained', () => {
    expect(isContainedIn(northLine(0, 3000, 100), northLine(0, 3000, 100), 50)).toBe(true)
  })
})
```

**Step 2: Verify failure**

Run: `npx vitest run scripts/variants.test.mjs`
Expected: FAIL — `./variants.mjs` does not exist.

**Step 3: Implement `scripts/variants.mjs`**

```js
// Route-variant helpers for the data-prep step, extracted so they can be tested.

const MPD_LAT = 111320

/** Length of a [lat, lon] path in metres. */
export function pathMetres(pts) {
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    total += Math.hypot((a[0] - b[0]) * MPD_LAT, (a[1] - b[1]) * MPD_LAT * Math.cos((a[0] * Math.PI) / 180))
  }
  return total
}

/** Point at `frac` (0..1) of the way ALONG a path, by distance. */
function pointAtFraction(pts, frac) {
  const total = pathMetres(pts)
  if (total === 0) return pts[0]
  let target = total * frac
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const d = Math.hypot((a[0] - b[0]) * MPD_LAT, (a[1] - b[1]) * MPD_LAT * Math.cos((a[0] * Math.PI) / 180))
    if (target <= d || i === pts.length - 1) {
      const f = d === 0 ? 0 : target / d
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
    }
    target -= d
  }
  return pts[pts.length - 1]
}

/**
 * Corridor fingerprint: the route sampled at 12 fractions BY DISTANCE, rounded
 * to ~100 m, plus its length bucket.
 *
 * Sampling by index fraction (the previous version) is not sampling by position:
 * after Douglas-Peucker, vertex density tracks curviness, so the same corridor
 * recorded at a different vertex spacing produced a different key. Measured: the
 * index-fraction sample sat a median 574 m from the distance-fraction sample,
 * and 515 of 530 geometrically identical corridor pairs failed to merge.
 */
export function corridorKey(pts) {
  const k = []
  for (let i = 0; i < 12; i++) {
    const p = pointAtFraction(pts, i / 11)
    k.push(`${p[0].toFixed(3)},${p[1].toFixed(3)}`)
  }
  // length bucket keeps a route distinct from a short turn that happens to
  // sample onto the same cells
  k.push(Math.round(pathMetres(pts) / 500))
  return k.join(';')
}

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
 * Does `inner` run entirely along `outer`, within `tolM`?
 *
 * A short turn is a sub-slice of a longer variant, so it adds nothing to ship:
 * a vehicle on it projects onto the longer one correctly. 365 of 533 shipped
 * variants were contained this way, and because each was simplified
 * independently their vertices differ by sub-metre amounts, so residuals tied to
 * float noise and pickShape's choice flipped between polls.
 */
export function isContainedIn(inner, outer, tolM) {
  if (outer.length < 2) return false
  for (const p of inner) {
    let best = Infinity
    for (let i = 1; i < outer.length; i++) {
      best = Math.min(best, distToSegM(p, outer[i - 1], outer[i]))
      if (best <= tolM) break
    }
    if (best > tolM) return false
  }
  return true
}
```

**Step 4: Verify the helpers pass**

Run: `npx vitest run scripts/variants.test.mjs`
Expected: PASS, 11 tests.

**Step 5: Wire them into `prepare-data.mjs`**

Replace the whole variant block. Import first:

```js
import {corridorKey, isContainedIn, pathMetres as shapeMetres} from './variants.mjs'
```

Then, replacing the inline `corridorKey`, the `lineVariants` loop and `buildAt`:

```js
  const SIMPLIFY_M = 10
  const MAX_VARIANTS_PER_LINE = 12
  const CONTAINED_TOL_M = 50

  const lineVariants = new Map() // shortName -> {product, corridors: Map(key -> pts)}
  const seenShapeIds = new Set()
  for (const [routeId, {shortName, product}] of railRoutes) {
    for (const t of routeTrips.get(routeId) ?? []) {
      const raw = t.shapeId ? shapePts.get(t.shapeId) : undefined
      if (!raw || raw.length < 2) continue
      if (seenShapeIds.has(t.shapeId)) continue // once per shape_id, not per trip
      seenShapeIds.add(t.shapeId)
      const deduped = raw.filter((p, i) => i === 0 || p[0] !== raw[i - 1][0] || p[1] !== raw[i - 1][1])
      if (deduped.length < 2) continue
      const pts = simplifyPath(deduped, SIMPLIFY_M)
      if (!lineVariants.has(shortName)) lineVariants.set(shortName, {product, corridors: new Map()})
      const c = lineVariants.get(shortName).corridors
      const key = corridorKey(pts)
      const cur = c.get(key)
      // rank by METRES, not point count: after DP, point count tracks curviness.
      // On the previous output the two disagreed on 14% of pairs, and S7's 48 km
      // full-line variant has only 117 points -- it survived at rank 11 of 12.
      if (!cur || shapeMetres(pts) > shapeMetres(cur)) c.set(key, pts)
    }
  }

  const sortedLines = [...lineVariants.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const toFeature = (line, product, pts) => ({
    type: 'Feature',
    geometry: {type: 'LineString', coordinates: pts.map(([lat, lon]) => [lon, lat])},
    properties: {line, product}
  })

  // Drop any variant that runs entirely along a longer one. It cannot tell a
  // vehicle anything the longer variant does not, and shipping both is what made
  // pickShape's choice ambiguous (83% of choices tied within 0.5 m).
  let contained = 0
  const keptPerLine = new Map()
  for (const [line, {corridors}] of sortedLines) {
    const byLength = [...corridors.values()].sort((a, b) => shapeMetres(b) - shapeMetres(a))
    const keep = []
    for (const pts of byLength) {
      if (keep.some(longer => isContainedIn(pts, longer, CONTAINED_TOL_M))) { contained++; continue }
      keep.push(pts)
    }
    keptPerLine.set(line, keep)
  }
  console.log(`--- variants: ${seenShapeIds.size} shape_ids -> ${sortedLines.reduce((n, [, v]) => n + v.corridors.size, 0)} corridors -> ${[...keptPerLine.values()].reduce((n, k) => n + k.length, 0)} after dropping ${contained} contained`)

  const routeFeatures = []
  for (const [line, keep] of keptPerLine) {
    const product = lineVariants.get(line).product
    for (const pts of keep.slice(0, MAX_VARIANTS_PER_LINE)) routeFeatures.push(toFeature(line, product, pts))
  }
  const atCap = [...keptPerLine].filter(([, k]) => k.length > MAX_VARIANTS_PER_LINE)
  console.log(`  lines still at the cap: ${atCap.length}${atCap.length ? ' -> ' + atCap.map(([l, k]) => `${l}:${k.length}`).join(' ') : ''}`)
  console.log(`route variants shipped: ${routeFeatures.length} across ${keptPerLine.size} lines`)
```

**Step 6: Run it**

Run: `npm run prepare:data`
Expected: all gates PASS; variant count well below 533 (the review projected ~179); `lines still at the cap` should be far fewer than 41.

**Step 7: Commit**

```bash
git add scripts/variants.mjs scripts/variants.test.mjs scripts/prepare-data.mjs public/routes.json src/line-colors.ts
git commit -m "fix: drop route variants contained in a longer one, and key by distance"
```

---

## Task 6: Make the gates able to fail

**Files:**
- Modify: `scripts/prepare-data.mjs` (gates block)

**Step 1: Add floors and a finiteness check**

Replace the `checks` array with:

```js
  const allCoords = routeFeatures.flatMap(f => f.geometry.coordinates)
  const inBerlin = ([lon, lat]) => Number.isFinite(lat) && Number.isFinite(lon) &&
    lat > 51.8 && lat < 53.2 && lon > 12.5 && lon < 14.5
  const meanPtsPerShape = allCoords.length / Math.max(1, routeFeatures.length)
  const checks = [
    ['stations in low thousands', stationFeatures.length >= 500 && stationFeatures.length <= 15000],
    ['lines 40-60', lineNames.length >= 40 && lineNames.length <= 60],
    ['route variants 60-900', routeFeatures.length >= 60 && routeFeatures.length <= 900],
    // a units or tolerance bug collapses every shape to its endpoints; that
    // passed every previous gate at 4.7 KB against a real 54 KB
    ['shapes carry real geometry (>=15 pts mean)', meanPtsPerShape >= 15],
    ['routes.json 20-250 KB gzipped', routesGz >= 20 * 1024 && routesGz <= 250 * 1024],
    ['all coordinates finite and inside Berlin', allCoords.every(inBerlin)],
    ['no RE/RB/FEX/ICE routes', bad.length === 0],
    ['S41/S42 present', lineNames.includes('S41') && lineNames.includes('S42')],
    ['U1-U9 present', missingU.length === 0],
    ['trams present (>=10)', tramLines.length >= 10]
  ]
```

**Step 2: Prove the gates now catch it**

Temporarily add, just before the gates:

```js
  if (process.env.BREAK_SHAPES) for (const f of routeFeatures) f.geometry.coordinates = [f.geometry.coordinates[0], f.geometry.coordinates.at(-1)]
```

Run: `BREAK_SHAPES=1 npm run prepare:data`
Expected: `FAIL  shapes carry real geometry`, `FAIL  routes.json 20-250 KB gzipped`, non-zero exit, and **`public/routes.json` unchanged** (`git status` clean for it).

Then remove the temporary line and re-run clean.

**Step 3: Commit**

```bash
git add scripts/prepare-data.mjs
git commit -m "test: gates now reject collapsed geometry, not just oversized output"
```

---

## Task 7: Cover the untested cases, and correct the docs

**Files:**
- Test: `scripts/simplify.test.mjs`, `src/track.test.ts`
- Modify: `AGENTS.md`, `src/track.test.ts` comment

**Step 1: Add the missing tests**

`scripts/simplify.test.mjs`:

```js
it('handles a closed loop (first point equals last)', () => {
  // the S41/S42 case, and the only input that hits the zero-length branch
  const loop = []
  for (let i = 0; i <= 360; i += 1) {
    const a = (i * Math.PI) / 180
    loop.push([52.5 + (2000 * Math.sin(a)) / 111320, 13.4 + (2000 * Math.cos(a)) / (111320 * Math.cos((52.5 * Math.PI) / 180))])
  }
  const out = simplifyPath(loop, 10)
  expect(out.length).toBeLessThan(loop.length)
  expect(out[0]).toEqual(loop[0])
  expect(out[out.length - 1]).toEqual(loop[loop.length - 1])
})

it('handles a large input without blowing the stack', () => {
  // the stated reason the implementation is iterative
  const big = []
  for (let i = 0; i < 60000; i++) big.push([52.5 + i / 1e7, 13.4 + Math.sin(i / 50) / 1e4])
  expect(() => simplifyPath(big, 10)).not.toThrow()
  expect(simplifyPath(big, 10).length).toBeLessThan(big.length)
})
```

`src/track.test.ts` — replace the misleading comment above `pickShape fit precedence` and add:

```ts
// Ties ARE broken, by array order: pickShape uses a strict `<`, and
// prepare-data.mjs emits variants sorted longest-first. 83% of live choices are
// ties inside 0.5 m, so this is the dominant path. Task 5 removes most ties by
// dropping contained variants; what must hold regardless is that a clearly
// better fit always wins, and that a stationary forecast is handled.
```

```ts
it('handles a stationary vehicle, whose forecast is four identical points', () => {
  const still: Array<[number, number]> = Array(4).fill([52.50 + m(300), 13.40]) as Array<[number, number]>
  const picked = pickShape([trunk, branch], still)
  expect(picked).toBeDefined()
  // both variants pass through that point, so either is acceptable; what matters
  // is that it does not throw and does not return undefined
  expect([trunk, branch]).toContain(picked)
})

it('returns the first USABLE shape when the forecast is empty', () => {
  const stub: Array<[number, number]> = [[52.9, 13.9]]
  expect(pickShape([stub, trunk], [])).toBe(trunk)
})
```

**Step 2: Correct AGENTS.md**

- The test count line: `104 tests` is stale. Update to the real number and note `scripts/` now holds test files too (`scripts/simplify.test.mjs`, `scripts/variants.test.mjs`), which the co-location convention did not cover.
- Add the deadlock invariant:

```markdown
- **A forward-only hold must be time-boxed** (`MAX_HOLD_MS`, 2 s). `forwardStep` refuses to move a badge against its heading, and `main.ts` only refreshes the heading when the badge moves — so a hold could never end, and the only escape was the target coming round to the front (on a ring line, a whole lap). Measured before the fix: 33.5% of vehicle-samples were still while the forecast said they were moving, and 8 of 8 vehicles caught mid-freeze were correcting, with gaps up to 5,697 m. Do not remove the yield to suppress a reversal.
- **`maxResidualM` measures true metres, not degree space.** `projectOntoPath` finds its nearest point treating 1 deg lon as 1 deg lat (at Berlin, longitude is 0.61 of that), which overstated residuals by a mean 1.8 m, up to 7.5 m, varying with the track's bearing. That is harmless against a 250 m threshold and fatal for `pickShape`, which discriminates on a few metres. `projectOntoPath`/`pointAlongPath`/`slicePath` still share degree-space units — they are self-consistent, and changing them is a separate job.
- **Do not ship a route variant contained in a longer one** (`isContainedIn`, 50 m). 365 of 533 shipped variants ran entirely along a longer one; each was simplified independently, so their vertices differ by sub-metre amounts and residuals tie to float noise, flipping `pickShape`'s choice between polls. Pruning them cut ambiguity from 83% to 53% of choices.
- **Corridor fingerprints sample by DISTANCE, not index** (`scripts/variants.mjs`). After Douglas-Peucker, vertex density tracks curviness, so index-fraction sampling is not position sampling: the sampled point sat a median 574 m off, and 515 of 530 geometrically identical corridor pairs failed to merge.
- **Rank variants by metres, not point count.** After DP the two disagree on 14% of pairs; S7's 48 km full-line variant has only 117 points and survived at rank 11 of 12.
```

**Step 3: Commit**

```bash
npx vitest run && npm run build
git add -A
git commit -m "test: cover closed loops, large inputs and stationary forecasts; fix docs"
```

---

## Task 8: Final A/B and merge decision

**Step 1: Three clean arms, same hour**

For each of `main` (baseline), the parent branch tip, and this branch tip: check out the corresponding `public/routes.json`, reload, record 140 s with nothing else running in the page, and read the recorder summary plus `__lb.guardStats`.

**Step 2: Fill in**

```
                        main    parent   this branch
badFit % of rebuilds    7.9     0.25     ____
badgeStill_dataMoving   ?       33.5%    ____
freezes per 100 s       8.6     13.8     ____
drift median / p90      7/70    5/61     ____
reversals               0       0        ____
overspeed               1       0        ____
routes.json gz          76 KB   54 KB    ____
pickShape per poll      n/a     34.6 ms  ____
variants shipped        48      533      ____
```

**Step 3: Decide**

Merge only if freezes are at or below 8.6 per 100 s, reversals are 0, and drift is no worse than the parent. Otherwise report the remaining gap and stop.

REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch.

---

## Risks

| Risk | Signal | Response |
|---|---|---|
| `MAX_HOLD_MS` too short reintroduces visible reversals | recorder `reversal` count above 0 | raise the constant; never remove the yield |
| pruning drops a variant that was genuinely needed | `badFit` rises above 0.25% | raise `CONTAINED_TOL_M`, or lower it if too little is pruned |
| the length bucket in `corridorKey` splits corridors that should merge | corridor count barely falls | widen the bucket, or drop it and rely on `isContainedIn` |
| `isContainedIn` is O(inner × outer) per pair, per line | build time | it runs once at build time over <=155 variants per line; measure before optimising |
| the true-metre residual shifts what `SHAPE_FIT_LIMIT_M` means | `badFit` count moves sharply either way | the bias was an over-statement, so readings should fall slightly; re-check the 250 m figure against the new p99 |

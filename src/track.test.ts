import {describe, expect, it} from 'vitest'
import {buildSegmentPath, pickShape} from './track.js'
import {maxResidualM} from './motion.js'

// a straight north-south shape, 0..30
const shape: Array<[number, number]> = [[0, 0], [10, 0], [20, 0], [30, 0]]

describe('buildSegmentPath', () => {
  it('slices the shape between from and to', () => {
    const p = buildSegmentPath({M10: [shape]}, 'M10', {lat: 5, lon: 0}, {lat: 25, lon: 0})
    expect(p[0][0]).toBeCloseTo(5, 6)
    expect(p[p.length - 1][0]).toBeCloseTo(25, 6)
    // interior vertex preserved
    expect(p.some(pt => pt[0] === 10)).toBe(true)
  })

  it('handles a shape that runs opposite to travel direction', () => {
    const p = buildSegmentPath({M10: [shape]}, 'M10', {lat: 25, lon: 0}, {lat: 5, lon: 0})
    expect(p[0][0]).toBeCloseTo(25, 6)
    expect(p[p.length - 1][0]).toBeCloseTo(5, 6)
    // progress 0 = from (25), progress 1 = to (5): walking the path goes 25 -> 5
    expect(p[0][0]).toBeGreaterThan(p[p.length - 1][0])
  })

  it('falls back to a straight line when the shape is missing', () => {
    const p = buildSegmentPath({}, 'M10', {lat: 1, lon: 2}, {lat: 3, lon: 4})
    expect(p).toEqual([[1, 2], [3, 4]])
  })

  it('falls back to a straight line when the line has an empty variant list', () => {
    expect(buildSegmentPath({M10: []}, 'M10', {lat: 1, lon: 2}, {lat: 3, lon: 4}))
      .toEqual([[1, 2], [3, 4]])
  })

  it('falls back to a straight line when from and to project to the same point', () => {
    const p = buildSegmentPath({M10: [shape]}, 'M10', {lat: 15, lon: 0}, {lat: 15, lon: 0})
    expect(p.length).toBeGreaterThanOrEqual(2)
  })
})

// Two real-scale variants of one line: a trunk running north, and a branch that
// leaves it and bends east. Coordinates are metres-scaled so residuals are
// meaningful.
const m = (n: number) => n / 111320
const trunk: Array<[number, number]> = [[52.50, 13.40], [52.50 + m(1000), 13.40], [52.50 + m(2000), 13.40]]
const branch: Array<[number, number]> = [[52.50, 13.40], [52.50 + m(500), 13.40], [52.50 + m(700), 13.41]]

describe('pickShape', () => {
  it('returns undefined when there are no shapes', () => {
    expect(pickShape(undefined, [[52.5, 13.4]])).toBeUndefined()
    expect(pickShape([], [[52.5, 13.4]])).toBeUndefined()
  })

  it('returns the only shape when there is one', () => {
    expect(pickShape([trunk], [[52.5 + m(100), 13.4]])).toBe(trunk)
  })

  it('picks the branch when the forecast lies on the branch', () => {
    expect(pickShape([trunk, branch], [[52.50 + m(650), 13.4075]])).toBe(branch)
  })

  it('picks the trunk when the forecast lies on the trunk', () => {
    expect(pickShape([trunk, branch], [[52.50 + m(1500), 13.40]])).toBe(trunk)
  })

  it('uses the whole forecast, not just its first point', () => {
    // both variants start at the same place, so the first point cannot decide;
    // the later points can
    const pts: Array<[number, number]> = [[52.50, 13.40], [52.50 + m(600), 13.4050], [52.50 + m(700), 13.41]]
    expect(pickShape([trunk, branch], pts)).toBe(branch)
  })

  it('falls back to the first shape when the forecast is empty', () => {
    expect(pickShape([trunk, branch], [])).toBe(trunk)
  })

  it('still returns a shape when none fits well, leaving the limit to the caller', () => {
    // 40 km away: nothing fits, but SHAPE_FIT_LIMIT_M in main.ts decides what to do
    expect(pickShape([trunk, branch], [[52.9, 13.4]])).toBeDefined()
  })

  it('skips degenerate variants with fewer than two points', () => {
    const stub: Array<[number, number]> = [[52.9, 13.9]]
    expect(pickShape([stub, trunk], [[52.50 + m(1500), 13.40]])).toBe(trunk)
  })
})

describe('buildSegmentPath with variants', () => {
  const shapes = {S1: [trunk, branch]}

  it('slices the variant the forecast matches', () => {
    const path = buildSegmentPath(
      shapes, 'S1',
      {lat: 52.50 + m(400), lon: 13.40},
      {lat: 52.50 + m(700), lon: 13.41},
      [[52.50 + m(650), 13.4075]]
    )
    // the branch bends east, so the sliced path must gain longitude
    expect(path[path.length - 1][1]).toBeGreaterThan(13.405)
  })

  it('slices the trunk when the forecast matches the trunk', () => {
    const path = buildSegmentPath(
      shapes, 'S1',
      {lat: 52.50 + m(200), lon: 13.40},
      {lat: 52.50 + m(1800), lon: 13.40},
      [[52.50 + m(1000), 13.40]]
    )
    expect(path[path.length - 1][1]).toBeCloseTo(13.40, 4)
  })

  it('still works with no forecast hint', () => {
    const path = buildSegmentPath({S1: [trunk]}, 'S1', {lat: 52.50 + m(100), lon: 13.4}, {lat: 52.50 + m(1500), lon: 13.4})
    expect(path.length).toBeGreaterThanOrEqual(2)
  })
})

// Ties are NOT broken here. Breaking them by track length was tried and
// measured worse on drift, dwell and overspeed (see pickShape's note), so the
// instability is documented rather than papered over. What must hold is that a
// clearly better fit always wins.
describe('pickShape fit precedence', () => {
  const short: Array<[number, number]> = [[52.50, 13.40], [52.50 + m(600), 13.40]]
  const long: Array<[number, number]> = [[52.50, 13.40], [52.50 + m(600), 13.40], [52.50 + m(3000), 13.40]]

  it('prefers a better fit over a longer variant', () => {
    const onBranch: Array<[number, number]> = [[52.50 + m(650), 13.4075]]
    expect(pickShape([long, branch], onBranch)).toBe(branch)
  })

  it('prefers a better fit over a shorter variant', () => {
    const farNorth: Array<[number, number]> = [[52.50 + m(2500), 13.40]]
    expect(pickShape([short, long], farNorth)).toBe(long)
  })

  it('ignores a variant that is nowhere near the forecast', () => {
    const off: Array<[number, number]> = long.map(([la, lo]) => [la, lo + m(2000)]) as Array<[number, number]>
    expect(pickShape([off, short], [[52.50 + m(300), 13.40]])).toBe(short)
  })
})

describe('pickShape early exit', () => {
  it('picks the same variant as a full scan would', () => {
    const cands = [trunk, branch]
    for (const pts of [
      [[52.50 + m(650), 13.4075]] as Array<[number, number]>,
      [[52.50 + m(1500), 13.40]] as Array<[number, number]>,
      [[52.50 + m(100), 13.40], [52.50 + m(1800), 13.40]] as Array<[number, number]>
    ]) {
      const full = cands.reduce((b, s) => (maxResidualM(s, pts) < maxResidualM(b, pts) ? s : b), cands[0])
      expect(pickShape(cands, pts)).toBe(full)
    }
  })
})

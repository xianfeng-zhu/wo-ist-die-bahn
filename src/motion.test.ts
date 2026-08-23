import {describe, expect, it} from 'vitest'
import {advanceAlong, alongAt, berlinEpoch, COAST_GRACE_MS, pointAlongPath, projectOntoPath, slicePath} from './motion.js'

describe('pointAlongPath', () => {
  const path: Array<[number, number]> = [[0, 0], [0, 10], [0, 20]]
  it('returns the start at progress 0 and end at progress 1', () => {
    expect(pointAlongPath(path, 0)).toEqual([0, 0])
    expect(pointAlongPath(path, 1)).toEqual([0, 20])
  })
  it('walks by length (halfway is the middle vertex)', () => {
    expect(pointAlongPath(path, 0.5)[1]).toBeCloseTo(10, 6)
  })
  it('interpolates within a segment', () => {
    expect(pointAlongPath(path, 0.25)[1]).toBeCloseTo(5, 6)
  })
})

describe('projectOntoPath', () => {
  const path: Array<[number, number]> = [[0, 0], [0, 10], [0, 20]]
  it('projects a point on the path to its along-distance', () => {
    expect(projectOntoPath(path, {lat: 0, lon: 5}).along).toBeCloseTo(5, 6)
  })
  it('snaps an off-path point to the nearest segment', () => {
    const r = projectOntoPath(path, {lat: 0.5, lon: 5})
    expect(r.point[0]).toBeCloseTo(0, 6)
    expect(r.along).toBeCloseTo(5, 6)
  })
  it('clamps before the start and after the end', () => {
    expect(projectOntoPath(path, {lat: 0, lon: -5}).along).toBe(0)
    expect(projectOntoPath(path, {lat: 0, lon: 25}).along).toBe(20)
  })
})

describe('slicePath', () => {
  const path: Array<[number, number]> = [[0, 0], [0, 10], [0, 20], [0, 30]]
  it('returns the sub-path between two along-distances', () => {
    const s = slicePath(path, 5, 25)
    expect(s.length).toBeGreaterThanOrEqual(2)
    expect(s[0][1]).toBeCloseTo(5, 6)
    expect(s[s.length - 1][1]).toBeCloseTo(25, 6)
  })
  it('keeps interior vertices between the cuts', () => {
    const s = slicePath(path, 5, 25)
    expect(s.some(p => p[1] === 10)).toBe(true)
    expect(s.some(p => p[1] === 20)).toBe(true)
  })
})

describe('berlinEpoch', () => {
  it('converts a summer (CEST, UTC+2) wall-clock time to epoch', () => {
    expect(berlinEpoch('20260820', '010200')).toBe(Date.UTC(2026, 7, 19, 23, 2, 0))
  })
  it('converts a winter (CET, UTC+1) wall-clock time to epoch', () => {
    expect(berlinEpoch('20260115', '233000')).toBe(Date.UTC(2026, 0, 15, 22, 30, 0))
  })
})

describe('advanceAlong', () => {
  const base = {
    reportT: 1_000_000,
    ms: [0, 10000, 20000, 30000],
    alongs: [0, 100, 300, 600],
    total: 1000,
    drawnAlong: 0,
    start: {lat: 0, lon: 0},
    end: {lat: 0, lon: 1},
    path: [[0, 0], [0, 1]] as Array<[number, number]>
  }

  it('follows the forecast while it lasts', () => {
    expect(advanceAlong(base, base.reportT + 15000)).toBeCloseTo(200, 6)
  })

  it('never draws behind what it has already drawn', () => {
    // a fresh poll re-anchors at 0 while 250 was already drawn: hold, never reverse
    expect(advanceAlong({...base, drawnAlong: 250}, base.reportT)).toBe(250)
    expect(advanceAlong({...base, drawnAlong: 250}, base.reportT + 5000)).toBe(250)
  })

  it('resumes moving once the forecast passes the drawn position', () => {
    const held = advanceAlong({...base, drawnAlong: 250}, base.reportT + 15000)
    expect(held).toBe(250) // forecast is at 200, still behind
    const past = advanceAlong({...base, drawnAlong: 250}, base.reportT + 18000)
    expect(past).toBeGreaterThan(250) // forecast at 260, now leads
  })

  it('stops coasting once the grace period after the forecast expires', () => {
    const atLimit = advanceAlong(base, base.reportT + 30000 + COAST_GRACE_MS)
    const wayLater = advanceAlong(base, base.reportT + 30000 + COAST_GRACE_MS + 600000)
    expect(wayLater).toBe(atLimit)
    expect(wayLater).toBeLessThan(base.total) // did NOT glide to the end of the track
  })

  it('coasts during the grace period so a late poll does not freeze it', () => {
    expect(advanceAlong(base, base.reportT + 32000)).toBeGreaterThan(600)
  })

  it('handles an empty forecast without moving', () => {
    expect(advanceAlong({...base, ms: [], alongs: []}, base.reportT + 99000)).toBe(0)
  })
})

describe('alongAt', () => {
  // operator forecast: 0/10/20/30 s -> 0/100/300/600 m along the path
  const ms = [0, 10000, 20000, 30000]
  const alongs = [0, 100, 300, 600]
  const total = 1000

  it('returns the first sample at or before the report instant', () => {
    expect(alongAt(ms, alongs, 0, total)).toBe(0)
    expect(alongAt(ms, alongs, -5000, total)).toBe(0)
  })
  it('hits each sample exactly', () => {
    expect(alongAt(ms, alongs, 10000, total)).toBeCloseTo(100, 6)
    expect(alongAt(ms, alongs, 30000, total)).toBeCloseTo(600, 6)
  })
  it('interpolates linearly between samples', () => {
    expect(alongAt(ms, alongs, 15000, total)).toBeCloseTo(200, 6)
    expect(alongAt(ms, alongs, 25000, total)).toBeCloseTo(450, 6)
  })
  it('follows the forecast speed, not a constant speed', () => {
    // 0-10s covers 100m, 20-30s covers 300m: the vehicle accelerates
    const first = alongAt(ms, alongs, 5000, total)
    const last = alongAt(ms, alongs, 25000, total) - alongAt(ms, alongs, 20000, total)
    expect(first).toBeCloseTo(50, 6)
    expect(last).toBeCloseTo(150, 6)
  })
  it('coasts at the last speed past the end of the forecast', () => {
    // last interval is 300m/10s, so +10s past the end is +300m
    expect(alongAt(ms, alongs, 40000, total)).toBeCloseTo(900, 6)
  })
  it('never exceeds the path length', () => {
    expect(alongAt(ms, alongs, 600000, total)).toBe(total)
  })
  it('never goes backwards when the forecast does', () => {
    expect(alongAt([0, 10000], [500, 400], 10000, total)).toBeGreaterThanOrEqual(0)
    expect(alongAt([0, 10000], [500, -100], 10000, total)).toBe(0)
  })
  it('holds position for a single-sample forecast', () => {
    expect(alongAt([0], [250], 99000, total)).toBe(250)
  })
  it('returns 0 for an empty forecast', () => {
    expect(alongAt([], [], 1000, total)).toBe(0)
  })
})

import {describe, expect, it} from 'vitest'
import {advanceAlong, alongAt, berlinEpoch, CATCHUP_MAX_SPEED, CATCHUP_MAX_STEP, CATCHUP_TAU_MS, COAST_GRACE_MS, forwardStep, impliedSpeed, metresBetween, pathMetres, SPEED_SANITY_MPS, stepTowards, pointAlongPath, projectOntoPath, slicePath} from './motion.js'

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

describe('stepTowards', () => {
  const berlin: [number, number] = [52.52, 13.405]

  it('lands exactly on target when the gap is within the frame budget', () => {
    // normal motion: 25 m/s over a 16 ms frame is 0.4 m, far under the ~6.4 m cap
    const near: [number, number] = [52.52 + 0.4 / 111320, 13.405]
    expect(metresBetween(berlin, near)).toBeLessThan(1)
    expect(stepTowards(berlin, near, 16)).toEqual(near)
  })

  it('caps a large correction to the frame budget', () => {
    const far: [number, number] = [52.53, 13.42] // ~1.4 km away
    const next = stepTowards(berlin, far, 16)
    const moved = metresBetween(berlin, next)
    expect(moved).toBeCloseTo(CATCHUP_MAX_SPEED * 0.016, 1)
    expect(moved).toBeLessThan(10) // no visible blink
  })

  it('moves along the straight line toward the target', () => {
    const far: [number, number] = [52.62, 13.405] // due north
    const next = stepTowards(berlin, far, 100)
    expect(next[1]).toBeCloseTo(13.405, 6)
    expect(next[0]).toBeGreaterThan(52.52)
  })

  it('closes a kilometre-scale gap in a couple of seconds', () => {
    let p = berlin
    const far: [number, number] = [52.53, 13.42]
    let frames = 0
    while (metresBetween(p, far) > 1 && frames < 600) { p = stepTowards(p, far, 16); frames++ }
    expect(frames * 16).toBeLessThan(4000)
  })

  it('never exceeds the hard per-frame cap, however long the frame was', () => {
    const far: [number, number] = [52.72, 13.9] // ~40 km away
    for (const dt of [16, 100, 1000, 30000]) {
      expect(metresBetween(berlin, stepTowards(berlin, far, dt))).toBeLessThanOrEqual(CATCHUP_MAX_STEP + 1e-6)
    }
  })

  it('does not move for a zero-length frame', () => {
    expect(stepTowards(berlin, [52.53, 13.42], 0)).toEqual(berlin)
  })
})

describe('forwardStep', () => {
  const p0: [number, number] = [52.52, 13.405]
  const north = (m: number): [number, number] => [52.52 + m / 111320, 13.405]

  it('moves forward when the target is ahead', () => {
    const next = forwardStep(p0, north(0.4), [1, 0], 16)
    expect(next[0]).toBeGreaterThan(p0[0])
  })

  it('holds instead of reversing when the target is behind', () => {
    // a poll corrected this badge backwards; it must not be dragged back
    expect(forwardStep(north(10), north(4), [1, 0], 16)).toEqual(north(10))
  })

  it('moves freely when no heading is known yet', () => {
    const next = forwardStep(north(10), north(4), null, 16)
    expect(next[0]).toBeLessThan(north(10)[0])
  })

  it('still rate-limits a forward correction', () => {
    const far = north(4000)
    expect(metresBetween(north(0), forwardStep(north(0), far, [1, 0], 16))).toBeLessThanOrEqual(CATCHUP_MAX_STEP + 1e-6)
  })
})

describe('pathMetres', () => {
  it('sums the length of a path', () => {
    expect(pathMetres([[52.52, 13.405], [52.52 + 100 / 111320, 13.405]])).toBeCloseTo(100, 0)
  })
  it('is zero for a path with fewer than two points', () => {
    expect(pathMetres([[52.52, 13.405]])).toBe(0)
  })
})

describe('impliedSpeed', () => {
  // a straight 1000 m path, in the degree units projectOntoPath works in
  const path: Array<[number, number]> = [[52.5, 13.4], [52.5 + 1000 / 111320, 13.4]]
  const total = 1000 / 111320

  it('computes the speed the forecast implies along a path', () => {
    // covers the whole 1000 m over the 30 s forecast => 33 m/s
    expect(impliedSpeed([0, 30000], [0, total], total, path)).toBeCloseTo(33.3, 0)
  })

  it('flags a track that would need an impossible speed', () => {
    // same 30 s but the projection spans 3 km of track
    const long: Array<[number, number]> = [[52.5, 13.4], [52.5 + 3000 / 111320, 13.4]]
    const t = 3000 / 111320
    expect(impliedSpeed([0, 30000], [0, t], t, long)).toBeGreaterThan(SPEED_SANITY_MPS)
  })

  it('returns 0 when it cannot be determined', () => {
    expect(impliedSpeed([], [], total, path)).toBe(0)
    expect(impliedSpeed([0, 30000], [0, total], 0, path)).toBe(0)
    expect(impliedSpeed([0, 0], [0, total], total, path)).toBe(0)
  })
})

describe('advanceAlong', () => {
  const base = {
    reportT: 1_000_000,
    ms: [0, 10000, 20000, 30000],
    alongs: [0, 100, 300, 600],
    total: 1000,
    drawnAlong: 0,
    drawnT: 1_000_000,
    start: {lat: 0, lon: 0},
    end: {lat: 0, lon: 1},
    path: [[0, 0], [0, 1]] as Array<[number, number]>
  }

  /** Replay frame by frame, as the render loop does. */
  const run = (state: typeof base, untilMs: number, stepMs = 16) => {
    let s = {...state}
    for (let t = s.drawnT + stepMs; t <= untilMs; t += stepMs) {
      s = {...s, drawnAlong: advanceAlong(s, t), drawnT: t}
    }
    return s.drawnAlong
  }

  it('tracks the forecast exactly while following it', () => {
    // 15000 is not a whole number of 16 ms frames, so allow a sub-metre shortfall
    expect(run(base, base.reportT + 15000)).toBeCloseTo(200, 0)
  })

  it('never draws behind what it has already drawn', () => {
    // re-anchored at 0 while 250 was already drawn: hold, never reverse
    expect(advanceAlong({...base, drawnAlong: 250}, base.reportT)).toBe(250)
    expect(run({...base, drawnAlong: 250}, base.reportT + 5000)).toBe(250)
  })

  it('eases forward instead of snapping when it trails the forecast', () => {
    // 500 behind: one frame must close only a sliver, not the whole gap
    const oneFrame = advanceAlong({...base, drawnAlong: 0, drawnT: base.reportT + 20000}, base.reportT + 20016)
    expect(oneFrame).toBeGreaterThan(0)
    expect(oneFrame).toBeLessThan(30) // forecast is at 300 — no teleport
  })

  it('closes a large gap within a couple of seconds', () => {
    const start = {...base, drawnAlong: 0, drawnT: base.reportT + 20000}
    const after2s = run(start, base.reportT + 22000)
    // forecast is ~360 by then; we should be close behind it, not stuck at 0
    expect(after2s).toBeGreaterThan(300)
  })

  it('slows rather than reversing when it runs ahead of the forecast', () => {
    const ahead = {...base, drawnAlong: 400, drawnT: base.reportT + 15000}
    const next = advanceAlong(ahead, base.reportT + 15016)
    expect(next).toBeGreaterThanOrEqual(400)
    expect(next).toBeLessThan(401)
  })

  it('stops coasting once the grace period after the forecast expires', () => {
    const atLimit = run(base, base.reportT + 30000 + COAST_GRACE_MS)
    const wayLater = run(base, base.reportT + 30000 + COAST_GRACE_MS + 20000)
    expect(wayLater).toBeCloseTo(atLimit, 0)
    expect(wayLater).toBeLessThan(base.total) // did NOT glide to the end of the track
  })

  it('coasts during the grace period so a late poll does not freeze it', () => {
    expect(run(base, base.reportT + 32000)).toBeGreaterThan(600)
  })

  it('handles an empty forecast without moving', () => {
    expect(advanceAlong({...base, ms: [], alongs: []}, base.reportT + 99000)).toBe(0)
  })

  it('has a catch-up time constant well under the poll interval', () => {
    expect(CATCHUP_TAU_MS).toBeLessThan(10000)
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

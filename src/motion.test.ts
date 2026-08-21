import {describe, expect, it} from 'vitest'
import {advanceAnimation, berlinEpoch, pointAlongPath, projectOntoPath, slicePath, timeDiffMs} from './motion.js'

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

describe('advanceAnimation', () => {
  const base = {
    progress: 0,
    velocity: 0,
    endT: Date.UTC(2026, 7, 19, 23, 4, 0), // arrival 120s after t0
    path: [[0, 0], [0, 10], [0, 20]] as Array<[number, number]>,
    start: {lat: 0, lon: 0},
    end: {lat: 0, lon: 20}
  }
  const t0 = Date.UTC(2026, 7, 19, 23, 2, 0)

  it('moves forward toward the arrival time (schedule-paced)', () => {
    const s = advanceAnimation(base, t0, 1000, {speedFactor: 1, maxAccel: 0.02, maxDecel: 0.02})
    expect(s.progress).toBeGreaterThan(0)
    expect(s.progress).toBeLessThan(0.02)
    expect(s.velocity).toBeGreaterThan(0)
  })

  it('never moves backward when the arrival is already due', () => {
    const past = advanceAnimation({...base, endT: t0 - 1000}, t0, 1000, {speedFactor: 1, maxAccel: 0.02, maxDecel: 0.02})
    expect(past.progress).toBe(0)
    expect(past.velocity).toBe(0)
  })

  it('holds at the end of the segment (progress 1) instead of overshooting', () => {
    const at = advanceAnimation({...base, progress: 0.99, velocity: 0.02}, t0, 1000, {speedFactor: 2, maxAccel: 0.1, maxDecel: 0.1})
    expect(at.progress).toBeLessThanOrEqual(1)
  })

  it('ramps velocity toward the target with bounded acceleration', () => {
    const s1 = advanceAnimation(base, t0, 1000, {speedFactor: 1, maxAccel: 0.001, maxDecel: 0.001})
    const s2 = advanceAnimation({...base, velocity: s1.velocity, progress: s1.progress}, t0 + 1000, 1000, {speedFactor: 1, maxAccel: 0.001, maxDecel: 0.001})
    expect(s2.velocity - s1.velocity).toBeLessThanOrEqual(0.001 + 1e-9)
    expect(s2.velocity).toBeGreaterThanOrEqual(s1.velocity)
  })

  it('decelerates to a stop (forward-only) when the data target falls behind', () => {
    const s = advanceAnimation({...base, velocity: 0.02, progress: 0.5}, t0, 1000, {speedFactor: 1, maxAccel: 0.01, maxDecel: 0.01})
    expect(s.progress).toBeGreaterThanOrEqual(0.5)
    expect(s.velocity).toBeLessThan(0.02)
  })
})

describe('timeDiffMs', () => {
  it('computes the schedule duration between two stop times', () => {
    expect(timeDiffMs('01022100', '01023500')).toBe(14000)
  })
  it('handles overnight wrap', () => {
    expect(timeDiffMs('23590000', '00030000')).toBe(240000)
  })
  it('clamps extreme values and falls back on missing data', () => {
    expect(timeDiffMs('01000000', '02000000')).toBe(30 * 60 * 1000) // > 30min cap
    expect(timeDiffMs('01000000', '01001000')).toBe(10000) // < 10s floor
  })
})

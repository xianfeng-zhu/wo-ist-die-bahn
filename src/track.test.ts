import {describe, expect, it} from 'vitest'
import {buildSegmentPath, firstStopAhead} from './track.js'

// a straight north-south shape, 0..30
const shape: Array<[number, number]> = [[0, 0], [10, 0], [20, 0], [30, 0]]

describe('buildSegmentPath', () => {
  it('slices the shape between from and to', () => {
    const p = buildSegmentPath({M10: shape}, 'M10', {lat: 5, lon: 0}, {lat: 25, lon: 0})
    expect(p[0][0]).toBeCloseTo(5, 6)
    expect(p[p.length - 1][0]).toBeCloseTo(25, 6)
    // interior vertex preserved
    expect(p.some(pt => pt[0] === 10)).toBe(true)
  })

  it('handles a shape that runs opposite to travel direction', () => {
    const p = buildSegmentPath({M10: shape}, 'M10', {lat: 25, lon: 0}, {lat: 5, lon: 0})
    expect(p[0][0]).toBeCloseTo(25, 6)
    expect(p[p.length - 1][0]).toBeCloseTo(5, 6)
    // progress 0 = from (25), progress 1 = to (5): walking the path goes 25 -> 5
    expect(p[0][0]).toBeGreaterThan(p[p.length - 1][0])
  })

  it('falls back to a straight line when the shape is missing', () => {
    const p = buildSegmentPath({}, 'M10', {lat: 1, lon: 2}, {lat: 3, lon: 4})
    expect(p).toEqual([[1, 2], [3, 4]])
  })

  it('falls back to a straight line when from and to project to the same point', () => {
    const p = buildSegmentPath({M10: shape}, 'M10', {lat: 15, lon: 0}, {lat: 15, lon: 0})
    expect(p.length).toBeGreaterThanOrEqual(2)
  })
})

describe('firstStopAhead', () => {
  const shape: Array<[number, number]> = [[0, 0], [10, 0], [20, 0], [30, 0]]
  const stops = [
    {name: 'A', lat: 0, lon: 0, t: '01000000'},
    {name: 'B', lat: 10, lon: 0, t: '01010000'},
    {name: 'C', lat: 25, lon: 0, t: '01020000'}
  ]
  it('picks the first stop ahead of the position', () => {
    expect(firstStopAhead({M10: shape}, 'M10', {lat: 2, lon: 0}, stops)).toBe(1)
    expect(firstStopAhead({M10: shape}, 'M10', {lat: 15, lon: 0}, stops)).toBe(2)
  })
  it('returns -1 when no stop is ahead', () => {
    expect(firstStopAhead({M10: shape}, 'M10', {lat: 29, lon: 0}, stops)).toBe(-1)
  })
  it('falls back to the first upcoming stop without a shape', () => {
    expect(firstStopAhead({}, 'M10', {lat: 2, lon: 0}, stops)).toBe(1)
  })
})

import {describe, expect, it} from 'vitest'
import {corridorKey, isContainedIn, pathMetres} from './variants.mjs'

const m = n => n / 111320
const lonM = n => n / (111320 * Math.cos((52.5 * Math.PI) / 180))
/** a straight track north, from `fromM` to `toM`, with a vertex every `stepM` */
const northLine = (fromM, toM, stepM) => {
  const out = []
  for (let d = fromM; d <= toM; d += stepM) out.push([52.5 + m(d), 13.4])
  if (out[out.length - 1][0] !== 52.5 + m(toM)) out.push([52.5 + m(toM), 13.4])
  return out
}

describe('pathMetres', () => {
  it('measures length in metres', () => {
    expect(pathMetres(northLine(0, 1000, 500))).toBeCloseTo(1000, 0)
  })

  it('scales longitude by latitude', () => {
    expect(pathMetres([[52.5, 13.4], [52.5, 13.4 + lonM(1000)]])).toBeCloseTo(1000, 0)
  })

  it('is zero for a single point', () => {
    expect(pathMetres([[52.5, 13.4]])).toBe(0)
  })
})

describe('corridorKey', () => {
  it('gives the same key to one corridor recorded at different vertex densities', () => {
    // the defect being fixed: index-fraction sampling made these differ, because
    // after Douglas-Peucker vertex density tracks curviness, not distance
    expect(corridorKey(northLine(0, 3000, 20))).toBe(corridorKey(northLine(0, 3000, 137)))
  })

  it('gives the same key when vertex density is uneven along the route', () => {
    const uneven = [...northLine(0, 500, 10), ...northLine(600, 3000, 400)]
    expect(corridorKey(uneven)).toBe(corridorKey(northLine(0, 3000, 100)))
  })

  it('gives different keys to different corridors', () => {
    const east = []
    for (let d = 0; d <= 3000; d += 100) east.push([52.5, 13.4 + lonM(d)])
    expect(corridorKey(northLine(0, 3000, 100))).not.toBe(corridorKey(east))
  })

  it('gives different keys to a route and its half-length short turn', () => {
    expect(corridorKey(northLine(0, 3000, 100))).not.toBe(corridorKey(northLine(0, 1500, 100)))
  })

  it('does not throw on a two-point path', () => {
    expect(() => corridorKey([[52.5, 13.4], [52.5 + m(100), 13.4]])).not.toThrow()
  })
})

describe('isContainedIn', () => {
  const full = northLine(0, 3000, 100)

  it('reports a short turn as contained in the full route', () => {
    expect(isContainedIn(northLine(500, 2000, 100), full, 50)).toBe(true)
  })

  it('reports an identical route as contained', () => {
    expect(isContainedIn(full, full, 50)).toBe(true)
  })

  it('reports a diverging branch as not contained', () => {
    const branch = [[52.5 + m(1000), 13.4], [52.5 + m(1200), 13.4 + lonM(3000)]]
    expect(isContainedIn(branch, full, 50)).toBe(false)
  })

  it('is not fooled by a branch that only leaves at the very end', () => {
    const late = [...northLine(0, 2800, 100), [52.5 + m(2900), 13.4 + lonM(400)]]
    expect(isContainedIn(late, full, 50)).toBe(false)
  })

  it('tolerates sub-tolerance vertex differences from independent simplification', () => {
    // the real case: two DP runs over the same track differ by well under 50 m
    const jittered = northLine(200, 2500, 90).map(([la, lo]) => [la, lo + lonM(3)])
    expect(isContainedIn(jittered, full, 50)).toBe(true)
  })

  it('returns false when the outer path is degenerate', () => {
    expect(isContainedIn(full, [[52.5, 13.4]], 50)).toBe(false)
  })
})

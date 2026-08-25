import {describe, expect, it} from 'vitest'
import {simplifyPath} from './simplify.mjs'

/** metres north of a base latitude, as [lat, lon] */
const north = (m, lon = 13.4) => [52.5 + m / 111320, lon]
/** metres east of a base longitude */
const east = (m, lat = 52.5) => [lat, 13.4 + m / (111320 * Math.cos((lat * Math.PI) / 180))]

/** local copy of the metric, so the test does not lean on the implementation */
function distToSegM(p, a, b) {
  const k = 111320
  const kx = k * Math.cos((a[0] * Math.PI) / 180)
  const py = (p[0] - a[0]) * k
  const px = (p[1] - a[1]) * kx
  const by = (b[0] - a[0]) * k
  const bx = (b[1] - a[1]) * kx
  const len2 = by * by + bx * bx
  if (len2 === 0) return Math.hypot(py, px)
  const t = Math.max(0, Math.min(1, (py * by + px * bx) / len2))
  return Math.hypot(py - by * t, px - bx * t)
}

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
    expect(simplifyPath([north(0), east(100), north(200)], 10)).toHaveLength(3)
  })

  it('drops a bend smaller than the tolerance', () => {
    const mid = [north(100)[0], east(3)[1]]
    expect(simplifyPath([north(0), mid, north(200)], 10)).toHaveLength(2)
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
      const a = (i / 199) * (Math.PI / 2)
      pts.push([
        52.5 + (500 * Math.sin(a)) / 111320,
        13.4 + (500 * Math.cos(a)) / (111320 * Math.cos((52.5 * Math.PI) / 180))
      ])
    }
    const out = simplifyPath(pts, 10)
    expect(out.length).toBeLessThan(pts.length)
    for (const p of pts) {
      let best = Infinity
      for (let i = 1; i < out.length; i++) best = Math.min(best, distToSegM(p, out[i - 1], out[i]))
      expect(best).toBeLessThanOrEqual(10.001)
    }
  })

  it('keeps far more detail than Nth-point decimation at the same size', () => {
    // the shape a decimated GTFS track distorts: a tight curve then a long straight
    const pts = []
    for (let i = 0; i < 100; i++) {
      const a = (i / 99) * (Math.PI / 2)
      pts.push([52.5 + (200 * Math.sin(a)) / 111320, 13.4 + (200 * Math.cos(a)) / (111320 * Math.cos((52.5 * Math.PI) / 180))])
    }
    for (let i = 1; i <= 400; i++) pts.push([pts[99][0] + (i * 10) / 111320, pts[99][1]])
    const dp = simplifyPath(pts, 10)
    // decimate to the same point count, the old way
    const step = (pts.length - 1) / (dp.length - 1)
    const dec = []
    for (let i = 0; i < dp.length; i++) dec.push(pts[Math.round(i * step)])
    const worst = (line) => {
      let w = 0
      for (const p of pts) {
        let best = Infinity
        for (let i = 1; i < line.length; i++) best = Math.min(best, distToSegM(p, line[i - 1], line[i]))
        w = Math.max(w, best)
      }
      return w
    }
    expect(worst(dp)).toBeLessThan(worst(dec))
  })

  it('handles a path with repeated identical points', () => {
    expect(simplifyPath([north(0), north(0), north(0), north(100)], 10)).toHaveLength(2)
  })
})

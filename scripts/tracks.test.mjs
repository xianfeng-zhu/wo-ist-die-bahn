import {describe, expect, it} from 'vitest'
import {resampleByDistance, mergeToTracks} from './tracks.mjs'

const m = n => n / 111320
const lonM = n => n / (111320 * Math.cos((52.5 * Math.PI) / 180))
/** straight track north from `fromM` to `toM`, vertex every `stepM` */
const north = (fromM, toM, stepM = 100) => {
  const out = []
  for (let d = fromM; d < toM; d += stepM) out.push([52.5 + m(d), 13.4])
  out.push([52.5 + m(toM), 13.4])
  return out
}
const totalM = runs => {
  let s = 0
  for (const r of runs) {
    for (let i = 1; i < r.length; i++) {
      s += Math.hypot((r[i][0] - r[i - 1][0]) * 111320,
                      (r[i][1] - r[i - 1][1]) * 111320 * Math.cos(r[i][0] * Math.PI / 180))
    }
  }
  return s
}

describe('resampleByDistance', () => {
  it('places points at the requested spacing', () => {
    const out = resampleByDistance(north(0, 1000, 500), 100)
    expect(out.length).toBeGreaterThanOrEqual(10)
    const gap = Math.hypot((out[1][0] - out[0][0]) * 111320, 0)
    expect(gap).toBeCloseTo(100, 0)
  })

  it('keeps the first and last point', () => {
    const pts = north(0, 500, 250)
    const out = resampleByDistance(pts, 50)
    expect(out[0]).toEqual(pts[0])
    expect(out[out.length - 1][0]).toBeCloseTo(pts[pts.length - 1][0], 6)
  })

  it('is independent of the input vertex spacing', () => {
    const a = resampleByDistance(north(0, 2000, 20), 50)
    const b = resampleByDistance(north(0, 2000, 500), 50)
    expect(a.length).toBe(b.length)
    expect(a[10][0]).toBeCloseTo(b[10][0], 6)
  })

  it('handles short and degenerate input', () => {
    expect(resampleByDistance([], 50)).toEqual([])
    expect(resampleByDistance([[52.5, 13.4]], 50)).toHaveLength(1)
    expect(resampleByDistance([[52.5, 13.4], [52.5, 13.4]], 50)).toHaveLength(1)
  })
})

describe('mergeToTracks', () => {
  it('draws one track once, however many variants run along it', () => {
    // twelve variants of the same 3 km street, each recorded differently
    const variants = []
    for (let i = 0; i < 12; i++) variants.push(north(0, 3000, 60 + i * 17))
    const runs = mergeToTracks(variants)
    // total drawn length must be about one pass, not twelve
    expect(totalM(runs)).toBeGreaterThan(2700)
    expect(totalM(runs)).toBeLessThan(3400)
  })

  it('keeps a branch, and draws the shared trunk only once', () => {
    const trunk = north(0, 2000)
    const branch = [...north(0, 1000), [52.5 + m(1100), 13.4 + lonM(400)], [52.5 + m(1200), 13.4 + lonM(900)]]
    const runs = mergeToTracks([trunk, branch])
    const len = totalM(runs)
    // trunk 2000 m + about 1000 m of branch, not 2000 + 2000
    expect(len).toBeGreaterThan(2700)
    expect(len).toBeLessThan(3600)
  })

  it('keeps two genuinely separate tracks', () => {
    const a = north(0, 1000)
    const b = a.map(([la, lo]) => [la, lo + lonM(600)])
    expect(totalM(mergeToTracks([a, b]))).toBeGreaterThan(1800)
  })

  it('merges near-parallel tracks in the same street', () => {
    // the two rails of one tram street, a few metres apart
    const a = north(0, 1000)
    const b = a.map(([la, lo]) => [la, lo + lonM(4)])
    expect(totalM(mergeToTracks([a, b]))).toBeLessThan(1400)
  })

  it('returns runs of at least two points', () => {
    for (const r of mergeToTracks([north(0, 2000), north(500, 1500)])) {
      expect(r.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('handles a single variant', () => {
    expect(totalM(mergeToTracks([north(0, 1000)]))).toBeCloseTo(1000, -2)
  })

  it('handles no usable variants', () => {
    expect(mergeToTracks([])).toEqual([])
    expect(mergeToTracks([[[52.5, 13.4]]])).toEqual([])
  })

  it('is order-independent in total drawn length', () => {
    const vs = [north(0, 2000), north(400, 1200), north(800, 3000)]
    const a = totalM(mergeToTracks(vs))
    const b = totalM(mergeToTracks([...vs].reverse()))
    expect(Math.abs(a - b)).toBeLessThan(400)
  })
})

describe('mergeToTracks output shape', () => {
  it('rounds coordinates to about a metre, so the file compresses', () => {
    // full-precision floats from resampling cost 39 bytes each and barely gzip
    for (const r of mergeToTracks([north(0, 2000, 137)])) {
      for (const [lat, lon] of r) {
        expect(String(lat).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(5)
        expect(String(lon).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(5)
      }
    }
  })

  it('drops fragments too short to see', () => {
    // a variant that only adds 30 m of new track contributes nothing
    const runs = mergeToTracks([north(0, 2000), north(0, 2030)])
    for (const r of runs) {
      let len = 0
      for (let i = 1; i < r.length; i++) {
        len += Math.hypot((r[i][0] - r[i-1][0]) * 111320, (r[i][1] - r[i-1][1]) * 111320 * Math.cos(r[i][0] * Math.PI / 180))
      }
      expect(len).toBeGreaterThanOrEqual(79)
    }
  })

  it('does not shred a long run at a short shared stretch', () => {
    // two variants crossing the same 40 m of track in the middle
    const a = north(0, 3000)
    const b = [...north(0, 1480).map(([la, lo]) => [la, lo + lonM(300)]),
               ...north(1480, 1520),
               ...north(1520, 3000).map(([la, lo]) => [la, lo + lonM(300)])]
    const runs = mergeToTracks([a, b])
    expect(runs.length).toBeLessThanOrEqual(3)
  })
})

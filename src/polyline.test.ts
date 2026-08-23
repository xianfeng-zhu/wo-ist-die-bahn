import {describe, expect, it} from 'vitest'
import {decodePolyline} from './polyline.js'

describe('decodePolyline', () => {
  it('decodes the canonical Google test vector', () => {
    const p = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')
    expect(p.length).toBe(3)
    expect(p[0][0]).toBeCloseTo(38.5, 5)
    expect(p[0][1]).toBeCloseTo(-120.2, 5)
    expect(p[1][0]).toBeCloseTo(40.7, 5)
    expect(p[1][1]).toBeCloseTo(-120.95, 5)
    expect(p[2][0]).toBeCloseTo(43.252, 5)
    expect(p[2][1]).toBeCloseTo(-126.453, 5)
  })

  it('decodes a real HAFAS ani polyline to points in Berlin', () => {
    // captured verbatim from common.polyL[].crdEncYX
    const p = decodePolyline('i~m_IawfpAArRbAlRBX')
    expect(p.length).toBe(4)
    for (const [lat, lon] of p) {
      expect(lat).toBeGreaterThan(52)
      expect(lat).toBeLessThan(53)
      expect(lon).toBeGreaterThan(12.5)
      expect(lon).toBeLessThan(14.5)
    }
  })

  it('returns an empty array for an empty string', () => {
    expect(decodePolyline('')).toEqual([])
  })

  it('ignores truncated trailing input instead of throwing', () => {
    const full = decodePolyline('_p~iF~ps|U_ulLnnqC')
    expect(full.length).toBe(2)
    // cut mid-value: keeps the points it could complete
    expect(decodePolyline('_p~iF~ps|U_ulL').length).toBe(1)
  })
})

import {describe, expect, it} from 'vitest'
import {arrivalSummary} from './views.js'
import type {Vehicle} from './vehicle.js'

const base: Vehicle = {
  id: '1|105929|33|86|23082026',
  line: 'U6',
  product: 'subway',
  direction: 'Alt-Tegel',
  lat: 52.52,
  lon: 13.4,
  nextStop: null,
  delayMs: null
}

describe('arrivalSummary', () => {
  it('reads the declared target and turns its time into a clock + countdown', () => {
    const v: Vehicle = {
      ...base,
      nextStop: 'U Leopoldplatz',
      toStop: {name: 'U Leopoldplatz', lat: 52.54, lon: 13.36, t: '143200'}
    }
    const nowSec = 14 * 3600 + 29 * 60 // 14:29:00
    expect(arrivalSummary(v, nowSec)).toEqual({next: 'U Leopoldplatz', time: '14:32', eta: '3 min'})
  })

  it('falls back to nextStop and reports no time when there is no target', () => {
    const v: Vehicle = {...base, nextStop: 'S Westend'}
    expect(arrivalSummary(v, 0)).toEqual({next: 'S Westend', time: null, eta: null})
  })

  it('says now once the arrival minute has been reached', () => {
    const v: Vehicle = {
      ...base,
      toStop: {name: 'U Leopoldplatz', lat: 52.54, lon: 13.36, t: '143200'}
    }
    const nowSec = 14 * 3600 + 32 * 60 // 14:32:00
    expect(arrivalSummary(v, nowSec).eta).toBe('now')
  })

  it('returns empty pieces when neither target nor next stop is present', () => {
    expect(arrivalSummary(base, 0)).toEqual({next: '', time: null, eta: null})
  })
})

import {describe, expect, it} from 'vitest'
import {arrivalSummary, departuresForLine, journeyFocusIndex, lineChipsFor} from './views.js'
import type {Vehicle} from './vehicle.js'
import type {Departure} from './journey.js'

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

describe('lineChipsFor / departuresForLine', () => {
  const dep = (line: string, product: Departure['product'], time: string): Departure => ({
    jid: line + time,
    line,
    product,
    direction: 'd',
    time,
    scheduled: time,
    delaySec: null,
    cancelled: false,
    platform: null
  })

  it('lists each distinct line once, in product then numeric-name order', () => {
    const chips = lineChipsFor([
      dep('M8', 'tram', '120000'),
      dep('S7', 'suburban', '120000'),
      dep('M10', 'tram', '120100'),
      dep('S7', 'suburban', '120200'),
      dep('U2', 'subway', '120300')
    ])
    expect(chips.map(c => c.key)).toEqual(['suburban:S7', 'subway:U2', 'tram:M8', 'tram:M10'])
    expect(chips.map(c => c.count)).toEqual([2, 1, 1, 1])
  })

  it('keeps a bus apart from a rail line of the same name', () => {
    const chips = lineChipsFor([
      dep('S9', 'suburban', '120000'),
      dep('S9', 'bus', '120100')
    ])
    expect(chips.map(c => c.key)).toEqual(['suburban:S9', 'bus:S9'])
  })

  it('narrows to one line key, and null returns everything', () => {
    const deps = [
      dep('S7', 'suburban', '120000'),
      dep('M8', 'tram', '120100')
    ]
    expect(departuresForLine(deps, 'suburban:S7')).toEqual([deps[0]])
    expect(departuresForLine(deps, 'tram:M8')).toEqual([deps[1]])
    expect(departuresForLine(deps, null)).toEqual(deps)
    expect(departuresForLine(deps, 'bus:999')).toEqual([])
  })
})

describe('journeyFocusIndex', () => {
  const stops = [
    {id: '9001', name: 'A'},
    {id: '9002', name: 'B'},
    {id: '9003', name: 'C'}
  ]

  it('finds the stop by extId first', () => {
    expect(journeyFocusIndex(stops, '9003', 'A')).toBe(2)
  })

  it('falls back to the name when the ids do not line up', () => {
    expect(journeyFocusIndex(stops, null, 'B')).toBe(1)
    expect(journeyFocusIndex(stops, '9999', 'A')).toBe(0)
  })

  it('returns -1 when the stop is not on the trip', () => {
    expect(journeyFocusIndex(stops, '9999', 'Z')).toBe(-1)
  })
})

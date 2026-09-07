import {describe, expect, it} from 'vitest'
import {
  aggregateLineNotices, classifyRem, noticesFromMsgL, noticeFromRem
} from './notice.js'

describe('notice classification', () => {
  it('sorts codes into the kinds the UI styles', () => {
    expect(classifyRem({code: 'text.occup.jny.max.13'})).toBe('occupancy')
    expect(classifyRem({code: 'ELEVATOR'})).toBe('elevator')
    expect(classifyRem({code: 'BAUSTELLE'})).toBe('construction')
    expect(classifyRem({code: 'Störung'})).toBe('disruption')
    expect(classifyRem({code: 'FK'})).toBe('information')
  })

  it('drops operator metadata and missing text', () => {
    const remL = [
      {code: 'OPERATOR', txtN: 'S-Bahn Berlin GmbH'},
      {code: 'FK'},
      {code: 'FK', txtN: 'Fahrradmitnahme möglich'}
    ]
    expect(noticeFromRem(0, remL)).toBeNull()
    expect(noticeFromRem(1, remL)).toBeNull()
    expect(noticeFromRem(2, remL)).toEqual({text: 'Fahrradmitnahme möglich', kind: 'information'})
    expect(noticeFromRem(9, remL)).toBeNull()
  })
})

describe('noticesFromMsgL', () => {
  it('resolves remX refs and dedupes repeated texts', () => {
    const remL = [
      {code: 'BAUSTELLE', txtN: 'Bauarbeiten zwischen A und B'},
      {code: 'ELEVATOR', txtN: 'Aufzug defekt'}
    ]
    const out = noticesFromMsgL([{remX: 0}, {remX: 1}, {remX: 0}], remL)
    expect(out).toEqual([
      {text: 'Bauarbeiten zwischen A und B', kind: 'construction'},
      {text: 'Aufzug defekt', kind: 'elevator'}
    ])
  })

  it('drops a category the caller excludes', () => {
    const remL = [{code: 'text.occup.jny.max.12', txtN: 'Mittlere Auslastung'}]
    expect(noticesFromMsgL([{remX: 0}], remL, new Set(['occupancy']))).toEqual([])
  })
})

describe('aggregateLineNotices', () => {
  it('merges the same alert across a line\'s vehicles', () => {
    const map = aggregateLineNotices([
      {line: 'S7', product: 'suburban', notices: [{text: 'Bauarbeiten', kind: 'construction'}]},
      {line: 'S7', product: 'suburban', notices: [{text: 'Bauarbeiten', kind: 'construction'}]},
      {line: 'S7', product: 'suburban', notices: [{text: 'Aufzug defekt', kind: 'elevator'}]},
      {line: 'M8', product: 'tram', notices: [{text: 'Bauarbeiten', kind: 'construction'}]}
    ])
    expect(map.get('suburban:S7')?.notices).toEqual([
      {text: 'Bauarbeiten', kind: 'construction'},
      {text: 'Aufzug defekt', kind: 'elevator'}
    ])
    expect(map.get('tram:M8')?.notices).toEqual([{text: 'Bauarbeiten', kind: 'construction'}])
  })

  it('ignores vehicles with no notices', () => {
    expect(aggregateLineNotices([{line: 'U2', product: 'subway'}]).size).toBe(0)
  })
})

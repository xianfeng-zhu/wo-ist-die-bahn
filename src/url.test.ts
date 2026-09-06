import {describe, expect, it} from 'vitest'
import {decodeViewState, encodeViewState} from './url.js'

describe('encodeViewState', () => {
  it('writes types, custom lines and camera', () => {
    const q = encodeViewState({
      types: ['suburban', 'subway', 'tram'],
      lineMode: 'custom',
      lines: ['suburban:S1', 'subway:U6'],
      center: [13.405, 52.52],
      zoom: 12
    })
    expect(q).toBe('types=suburban%2Csubway%2Ctram&lines=suburban%3AS1%2Csubway%3AU6&center=13.405%2C52.52&zoom=12')
  })

  it('omits lines while in all mode and omits an absent camera', () => {
    const q = encodeViewState({types: [], lineMode: 'all', lines: [], center: null, zoom: null})
    expect(q).toBe('types=')
  })
})

describe('decodeViewState', () => {
  it('round-trips a complete state', () => {
    const s = decodeViewState('types=suburban%2Csubway%2Ctram&lines=suburban%3AS1&center=13.405%2C52.52&zoom=12')
    expect(s).toEqual({
      types: ['suburban', 'subway', 'tram'],
      lineMode: 'custom',
      lines: ['suburban:S1'],
      center: [13.405, 52.52],
      zoom: 12
    })
  })

  it('keeps unknown types out and returns no types when the value is empty', () => {
    expect(decodeViewState('types=suburban%2Cnonsense')).toEqual({types: ['suburban']})
    expect(decodeViewState('types=')).toEqual({types: []})
  })

  it('ignores an out-of-range camera and zoom', () => {
    expect(decodeViewState('center=200%2C91&zoom=30')).toEqual({})
  })
})

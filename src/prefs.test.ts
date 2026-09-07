import {describe, expect, it} from 'vitest'
import {decodeFilterPrefs, encodeFilterPrefs} from './prefs.js'
import type {FilterPrefs} from './prefs.js'

describe('filter prefs', () => {
  it('round-trips a custom selection', () => {
    const prefs: FilterPrefs = {types: ['suburban', 'bus'], lineMode: 'custom', lines: ['suburban:S7', 'bus:125']}
    expect(decodeFilterPrefs(encodeFilterPrefs(prefs))).toEqual(prefs)
  })

  it('keeps an all-off selection honest instead of defaulting it away', () => {
    expect(decodeFilterPrefs(encodeFilterPrefs({types: [], lineMode: 'all', lines: []}))).toEqual({
      types: [],
      lineMode: 'all',
      lines: []
    })
  })

  it('returns null for garbage and for a wrong shape', () => {
    expect(decodeFilterPrefs(null)).toBeNull()
    expect(decodeFilterPrefs('not json')).toBeNull()
    expect(decodeFilterPrefs('{"types":"suburban"}')).toBeNull()
    expect(decodeFilterPrefs(JSON.stringify({types: ['nonsense'], lineMode: 'all', lines: []}))).toEqual({
      types: [],
      lineMode: 'all',
      lines: []
    })
  })
})

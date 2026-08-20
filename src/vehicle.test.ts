import {describe, expect, it} from 'vitest'
import {delayFrom, productFromCls, transformJourney} from './vehicle.js'

describe('productFromCls', () => {
  it('maps HAFAS cls bitmask to rail products', () => {
    expect(productFromCls(1)).toBe('suburban')
    expect(productFromCls(2)).toBe('subway')
    expect(productFromCls(4)).toBe('tram')
    expect(productFromCls(8)).toBeNull() // bus
    expect(productFromCls(64)).toBeNull() // regional
  })
})

describe('delayFrom', () => {
  it('computes delay from realtime minus scheduled departure', () => {
    expect(delayFrom({dTimeS: '23:09:00', dTimeR: '23:11:00'})).toBe(120000)
  })
  it('falls back to arrival times', () => {
    expect(delayFrom({aTimeS: '23:09:00', aTimeR: '23:06:00'})).toBe(-180000)
  })
  it('handles midnight wrap-around', () => {
    expect(delayFrom({dTimeS: '23:59:00', dTimeR: '00:03:00'})).toBe(240000)
  })
  it('computes delay from compact HAFAS departure times (HHMMSS)', () => {
    expect(delayFrom({dTimeS: '230300', dTimeR: '230500'})).toBe(120000)
  })
  it('computes delay from compact HAFAS arrival times (HHMMSS)', () => {
    expect(delayFrom({aTimeS: '230900', aTimeR: '230600'})).toBe(-180000)
  })
  it('returns null without realtime data', () => {
    expect(delayFrom({dTimeS: '23:09:00'})).toBeNull()
  })
  it('returns null when a time string is malformed', () => {
    expect(delayFrom({dTimeS: 'xxyyzz', dTimeR: '230500'})).toBeNull()
  })
})

describe('transformJourney', () => {
  const locs = [
    {name: 'S Schöneweide Bhf (Berlin)'},
    {name: 'S Treptower Park'}
  ]
  const j = {
    jid: '1|98495|0|86|20082026',
    prodX: 0,
    dirTxt: 'S Treptower Park (Berlin)',
    pos: {x: 13495123, y: 52467625},
    stopL: [
      {locX: 0, dTimeS: '23:03:00'},
      {locX: 1, aTimeS: '23:09:00', aTimeR: '23:08:00', dTimeS: '23:09:00', dTimeR: '23:08:00'}
    ]
  }
  it('transforms a journey into a Vehicle', () => {
    const v = transformJourney(j, {locs, prods: [{name: 'S9', cls: 1}]}, '23:05:00')!
    expect(v).toEqual({
      id: '1|98495|0|86|20082026',
      line: 'S9',
      product: 'suburban',
      direction: 'S Treptower Park (Berlin)',
      lat: 52.467625,
      lon: 13.495123,
      nextStop: 'S Treptower Park',
      delayMs: -60000
    })
  })
  it('returns null when pos is missing', () => {
    expect(transformJourney({...j, pos: null}, {locs, prods: [{name: 'S9', cls: 1}]}, '23:05:00')).toBeNull()
  })
  it('returns null for non-rail cls', () => {
    expect(transformJourney(j, {locs, prods: [{name: 'M29', cls: 8}]}, '23:05:00')).toBeNull()
  })
  it('picks the first upcoming stop as nextStop', () => {
    const v = transformJourney(j, {locs, prods: [{name: 'S9', cls: 1}]}, '23:03:30')!
    expect(v.nextStop).toBe('S Treptower Park')
  })
  it('selects the upcoming stop with compact HAFAS times (HHMMSS)', () => {
    const compactLocs = [
      {name: 'S Schöneweide Bhf (Berlin)'},
      {name: 'S Treptower Park'},
      {name: 'S Ostkreuz Bhf (Berlin)'}
    ]
    const compactJ = {
      jid: '1|98495|0|86|20082026',
      prodX: 0,
      dirTxt: 'S Ostkreuz (Berlin)',
      pos: {x: 13495123, y: 52467625},
      stopL: [
        {locX: 0, dTimeS: '230300'},
        {locX: 1, dTimeS: '230315'},
        {locX: 2, aTimeS: '230900', aTimeR: '230600', dTimeS: '230900', dTimeR: '230600'}
      ]
    }
    const v = transformJourney(compactJ, {locs: compactLocs, prods: [{name: 'S9', cls: 1}]}, '230330')!
    expect(v.nextStop).toBe('S Ostkreuz Bhf (Berlin)')
    expect(v.delayMs).toBe(-180000)
  })
})

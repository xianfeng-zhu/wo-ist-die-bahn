import {describe, expect, it} from 'vitest'
import type {Product} from './vehicle.js'
import {delayFrom, filterVehicles, productFromCls, transformJourney} from './vehicle.js'

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

describe('filterVehicles', () => {
  const v = (product: Product) => ({id: product, line: 'L', product, direction: 'd', lat: 1, lon: 2, nextStop: null, delayMs: null})
  it('keeps only enabled products', () => {
    const out = filterVehicles([v('suburban'), v('subway'), v('tram')], {suburban: true, subway: false, tram: true})
    expect(out.map(x => x.product)).toEqual(['suburban', 'tram'])
  })
  it('keeps only the listed lines when a line filter is given', () => {
    const vs = [v('tram'), v('subway')]
    vs[0].line = 'M10'
    vs[1].line = 'U8'
    const out = filterVehicles(vs, {suburban: true, subway: true, tram: true}, new Set(['M10']))
    expect(out.map(x => x.line)).toEqual(['M10'])
  })
  it('keeps everything when the line filter is empty', () => {
    const vs = [v('tram'), v('subway')]
    vs[0].line = 'M10'
    vs[1].line = 'U8'
    const out = filterVehicles(vs, {suburban: true, subway: true, tram: true}, new Set())
    expect(out.length).toBe(2)
  })
})

describe('line-name product gate', () => {
  const mk = (name: string, cls: number) => ({
    jid: 'j', prodX: 0, dirTxt: 'd',
    pos: {x: 13490000, y: 52460000},
    stopL: []
  })
  const commonFor = (prods: Array<{name?: string; cls?: number}>) => ({locs: [], prods})
  it('keeps S-Bahn, U-Bahn and tram names', () => {
    for (const [name, cls] of [['S7', 1], ['S85', 1], ['U2', 2], ['U12', 2], ['M10', 4], ['68', 4]] as const) {
      expect(transformJourney(mk(name, cls) as never, commonFor([{name, cls}]), '23:00:00')).not.toBeNull()
    }
  })
  it('rejects non-S/U/tram names even with a rail cls (e.g. FEX)', () => {
    expect(transformJourney(mk('FEX', 1) as never, commonFor([{name: 'FEX', cls: 1}]), '23:00:00')).toBeNull()
    expect(transformJourney(mk('RE1', 2) as never, commonFor([{name: 'RE1', cls: 2}]), '23:00:00')).toBeNull()
  })
})

describe('test mode (strictName: false)', () => {
  it('keeps FEX with an inferred product', () => {
    const j = {jid: 'f1', prodX: 0, dirTxt: 'd', pos: {x: 13490000, y: 52460000}, stopL: []}
    const v = transformJourney(j as never, {locs: [], prods: [{name: 'FEX', cls: 64}]}, '23:00:00', false)
    expect(v).not.toBeNull()
    expect(v?.line).toBe('FEX')
  })
  it('still drops vehicles without a position in test mode', () => {
    const j = {jid: 'f1', prodX: 0, dirTxt: 'd', pos: null, stopL: []}
    expect(transformJourney(j as never, {locs: [], prods: [{name: 'FEX', cls: 64}]}, '23:00:00', false)).toBeNull()
  })
})

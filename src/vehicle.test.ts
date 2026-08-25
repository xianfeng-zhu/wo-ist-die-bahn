import {describe, expect, it} from 'vitest'
import type {Product} from './vehicle.js'
import {compareLineNames, delayFrom, filterVehicles, productFromCls, shortId, transformJourney} from './vehicle.js'

describe('productFromCls', () => {
  it('maps HAFAS cls bitmask to rail products', () => {
    expect(productFromCls(1)).toBe('suburban')
    expect(productFromCls(2)).toBe('subway')
    expect(productFromCls(4)).toBe('tram')
    expect(productFromCls(8)).toBeNull() // bus
    expect(productFromCls(64)).toBeNull() // regional
  })
})

describe('transformJourney segment (HAFAS ani)', () => {
  // locL entries need coords to become a StopRef
  const locs = [
    {name: 'Origin', crd: {x: 13000000, y: 52400000}},
    {name: 'Left behind', crd: {x: 13100000, y: 52410000}},
    {name: 'Heading to', crd: {x: 13200000, y: 52420000}},
    {name: 'Terminus', crd: {x: 13300000, y: 52430000}}
  ]
  const prods = [{name: 'S9', cls: 1}]
  // the shape HAFAS always returns: [origin, previous, next, destination]
  const j = {
    jid: '1|1|0|86|20082026',
    prodX: 0,
    pos: {x: 13150000, y: 52415000},
    stopL: [
      {locX: 0, dTimeS: '230000'},
      {locX: 1, aTimeS: '230500', dTimeS: '230600'},
      {locX: 2, aTimeS: '230900', dTimeS: '231000'},
      {locX: 3, aTimeS: '234000'}
    ],
    ani: {fLocX: [1, 1, 1, 1], tLocX: [2, 2, 2, 2]}
  }

  it('takes the segment from ani.fLocX / ani.tLocX', () => {
    const v = transformJourney(j, {locs, prods}, '230700')!
    expect(v.fromStop).toEqual({name: 'Left behind', lat: 52.41, lon: 13.1, t: '230500'})
    expect(v.toStop).toEqual({name: 'Heading to', lat: 52.42, lon: 13.2, t: '230900'})
  })

  it('resolves the target by locX, not by stopover position', () => {
    // HAFAS points at the LAST stopover: it must win over stopL[2]
    const v = transformJourney({...j, ani: {fLocX: [2], tLocX: [3]}}, {locs, prods}, '230700')!
    expect(v.toStop?.name).toBe('Terminus')
  })

  it('leaves the segment undefined when ani is absent', () => {
    const {ani, ...noAni} = j
    const v = transformJourney(noAni, {locs, prods}, '230700')!
    expect(v.fromStop).toBeUndefined()
    expect(v.toStop).toBeUndefined()
  })

  it('leaves the segment undefined when the referenced stop has no coords', () => {
    const bare = [{name: 'Origin'}, {name: 'No coords'}, {name: 'Also none'}, {name: 'T'}]
    const v = transformJourney(j, {locs: bare, prods}, '230700')!
    expect(v.toStop).toBeUndefined()
  })

  it('still exposes the raw 4-stopover summary (not a chain)', () => {
    const v = transformJourney(j, {locs, prods}, '230700')!
    expect(v.stops?.map(s => s.name)).toEqual(['Origin', 'Left behind', 'Heading to', 'Terminus'])
  })
})

describe('shortId', () => {
  it('shortens a HAFAS journey id to ref-variant', () => {
    expect(shortId('1|108006|0|86|23082026')).toBe('108006-0')
  })
  it('keeps the variant field (the ref alone is not unique)', () => {
    // both vehicles share ref 105929 and must stay distinguishable
    expect(shortId('1|105929|33|86|23082026')).toBe('105929-33')
    expect(shortId('1|105929|32|86|23082026')).toBe('105929-32')
  })
  it('passes through an id that is not a HAFAS journey id', () => {
    expect(shortId('unknown')).toBe('unknown')
  })
  it('passes through when the ref or variant field is empty', () => {
    expect(shortId('1||0|86|23082026')).toBe('1||0|86|23082026')
    expect(shortId('1|108006')).toBe('1|108006')
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
  it('keeps nothing when the line filter is an empty set', () => {
    // an empty selection matches nothing, mirroring the product filter, so the
    // UI's "All lines" box can tick and untick every line like "All types" does
    const vs = [v('tram'), v('subway')]
    vs[0].line = 'M10'
    vs[1].line = 'U8'
    const out = filterVehicles(vs, {suburban: true, subway: true, tram: true}, new Set())
    expect(out.length).toBe(0)
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

describe('compareLineNames', () => {
  const sorted = (names: string[]) => [...names].sort(compareLineNames)

  it('orders numbers numerically, not as text', () => {
    expect(sorted(['U12', 'U1', 'U9', 'U2'])).toEqual(['U1', 'U2', 'U9', 'U12'])
    expect(sorted(['S41', 'S1', 'S25', 'S3'])).toEqual(['S1', 'S3', 'S25', 'S41'])
  })

  it('puts bare tram numbers before the M lines', () => {
    expect(sorted(['M10', '21', 'M1', '12'])).toEqual(['12', '21', 'M1', 'M10'])
  })

  it('groups by prefix', () => {
    expect(sorted(['U8', 'S1', 'M4', '50'])).toEqual(['50', 'M4', 'S1', 'U8'])
  })

  it('is stable for equal names and handles odd input', () => {
    expect(compareLineNames('U8', 'U8')).toBe(0)
    expect(sorted(['', 'U1'])).toEqual(['', 'U1'])
    expect(() => sorted(['FEX', 'RE1', 'X9'])).not.toThrow()
  })
})

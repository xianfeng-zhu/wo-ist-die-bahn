import {describe, expect, it} from 'vitest'
import {ALL_PRODUCTS, berlinDateTime, buildRadarBody, JNY_CAP, parseRadar, parseRadarPage, PRODUCT_GROUPS} from './hci.js'

describe('berlinDateTime', () => {
  it('converts a UTC instant to Europe/Berlin wall-clock (summer, UTC+2)', () => {
    expect(berlinDateTime(new Date('2026-08-20T23:30:00Z'))).toEqual({date: '20260821', time: '013000'})
  })
  it('converts a UTC instant to Europe/Berlin wall-clock (winter, UTC+1)', () => {
    expect(berlinDateTime(new Date('2026-01-15T22:30:00Z'))).toEqual({date: '20260115', time: '233000'})
  })
})

describe('buildRadarBody', () => {
  it('builds a JourneyGeoPos request for the mask it is given', () => {
    const body = buildRadarBody({north: 52.68, west: 13.08, south: 52.34, east: 13.76}, '20260820', '230819', 2000, 7)
    const req = body.svcReqL[0]
    expect(req.meth).toBe('JourneyGeoPos')
    expect(req.req.rect).toEqual({llCrd: {x: 13080000, y: 52340000}, urCrd: {x: 13760000, y: 52680000}})
    expect(req.req.jnyFltrL).toEqual([{type: 'PROD', mode: 'INC', value: 7}])
    expect(req.req.date).toBe('20260820')
    expect(req.req.time).toBe('230819')
    expect(req.req.maxJny).toBe(2000)
    expect(body.auth).toEqual({type: 'AID', aid: 'hafas-vbb-webapp'})
    expect(body.client).toMatchObject({id: 'VBB', l: 'vs_webapp_vbb'})
  })
})

describe('parseRadar', () => {
  const json = {
    svcResL: [{err: 'OK', res: {
      common: {
        locL: [{name: 'S Schöneweide'}, {name: 'S Treptower Park'}],
        prodL: [{name: 'S9', cls: 1}, {name: 'U2', cls: 2}, {name: 'M10', cls: 4}, {name: 'M29', cls: 8}]
      },
      jnyL: [
        {jid: 's1', prodX: 0, dirTxt: 'd1', pos: {x: 13490000, y: 52460000}, stopL: [{locX: 1, aTimeS: '23:10:00'}]},
        {jid: 'u1', prodX: 1, dirTxt: 'd2', pos: {x: 13490001, y: 52460001}, stopL: []},
        {jid: 'b1', prodX: 3, dirTxt: 'd3', pos: {x: 13490002, y: 52460002}, stopL: []},
        {jid: 't1', prodX: 2, dirTxt: 'd4', pos: null, stopL: []}
      ]
    }}]
  }
  it('parses journeys of every mode, dropping only the ones without a position', () => {
    const vehicles = parseRadar(json, '23:00:00')
    expect(vehicles.map(v => v.id)).toEqual(['s1', 'u1', 'b1']) // t1 has pos: null
    expect(vehicles[0]).toMatchObject({line: 'S9', product: 'suburban', lat: 52.46, lon: 13.49, nextStop: 'S Treptower Park'})
    expect(vehicles[1]).toMatchObject({line: 'U2', product: 'subway'})
    expect(vehicles[2]).toMatchObject({line: 'M29', product: 'bus'})
  })
  it('reports the raw journey count, so the caller can spot the gate\'s cap', () => {
    const page = parseRadarPage(json, '23:00:00')
    expect(page.journeys).toBe(4)   // includes the one we drop
    expect(page.vehicles.length).toBe(3)
  })
  it('throws on server error', () => {
    expect(() => parseRadar({svcResL: [{err: 'NOOK', res: {}}]}, '23:00:00')).toThrow()
  })
})

describe('PRODUCT_GROUPS', () => {
  it('covers every product bit exactly once', () => {
    expect(PRODUCT_GROUPS.reduce((a, b) => a | b, 0)).toBe(ALL_PRODUCTS)
    expect(PRODUCT_GROUPS.reduce((a, b) => a + b, 0)).toBe(ALL_PRODUCTS) // disjoint
  })
  it('splits bus off on its own, because one request is capped', () => {
    // measured: all products in one request returns exactly JNY_CAP journeys and
    // loses ~130 vehicles; bus alone is ~675 and everything else ~460
    expect(PRODUCT_GROUPS).toContain(8)
    expect(JNY_CAP).toBe(1000)
  })
})

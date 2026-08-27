import {describe, expect, it} from 'vitest'
import {markProgress, parseJourneyDetail, parseStationBoard, type JourneyStop} from './journey.js'

// Shapes taken from real gate responses (2026-08-27). JourneyDetails returned 31
// stops for a tram whose radar entry had 4; StationBoard resolved a board from an
// extId alone.
const detail = (over: Record<string, unknown> = {}) => ({
  svcResL: [{
    err: 'OK',
    res: {
      common: {
        locL: [
          {name: 'S Schöneweide Bhf', extId: '900192001', crd: {x: 13509000, y: 52455000}},
          {name: 'Brückenstr.', extId: '900192503', crd: {x: 13513000, y: 52458000}},
          {name: 'Firlstr.', extId: '900192507', crd: {x: 13519000, y: 52461000}}
        ],
        polyL: [{crdEncYX: '_p~iF~ps|U_ulLnnqC'}]
      },
      journey: {
        dirTxt: 'Bahnhofstr./Lindenstr.',
        polyG: {polyXL: [0]},
        stopL: [
          {locX: 0, dTimeS: '233900', dTimeR: '233900'},
          {locX: 1, aTimeS: '234000', aTimeR: '234200', dTimeS: '234000', dTimeR: '234200'},
          {locX: 2, aTimeS: '234400'}
        ],
        ...over
      }
    }
  }]
})

describe('parseJourneyDetail', () => {
  it('returns every stop in travel order, with coordinates and an extId', () => {
    const d = parseJourneyDetail(detail())!
    expect(d.stops.map(s => s.name)).toEqual(['S Schöneweide Bhf', 'Brückenstr.', 'Firlstr.'])
    expect(d.stops[0]).toMatchObject({id: '900192001', lat: 52.455, lon: 13.509})
    expect(d.direction).toBe('Bahnhofstr./Lindenstr.')
  })

  it('prefers realtime and reports the delay against schedule', () => {
    const d = parseJourneyDetail(detail())!
    expect(d.stops[1].time).toBe('234200')
    expect(d.stops[1].scheduled).toBe('234000')
    expect(d.stops[1].delaySec).toBe(120)
  })

  it('leaves delaySec null where the feed gives no realtime', () => {
    const d = parseJourneyDetail(detail())!
    expect(d.stops[2].time).toBe('234400')
    expect(d.stops[2].delaySec).toBeNull()
  })

  it('decodes the route polyline', () => {
    const d = parseJourneyDetail(detail())!
    expect(d.path.length).toBeGreaterThan(0)
    expect(d.path[0]).toHaveLength(2)
  })

  it('drops a stop whose location has no coordinates, not the whole journey', () => {
    const j = detail()
    j.svcResL[0].res.common.locL[1] = {name: 'No coords', extId: 'x'} as never
    const d = parseJourneyDetail(j)!
    expect(d.stops.map(s => s.name)).toEqual(['S Schöneweide Bhf', 'Firlstr.'])
  })

  it('marks a cancelled stop', () => {
    const j = detail()
    ;(j.svcResL[0].res.journey.stopL[1] as Record<string, unknown>).aCncl = true
    expect(parseJourneyDetail(j)!.stops[1].cancelled).toBe(true)
  })

  it('returns null on an error or an empty response', () => {
    expect(parseJourneyDetail({svcResL: [{err: 'NOOK'}]})).toBeNull()
    expect(parseJourneyDetail({})).toBeNull()
    expect(parseJourneyDetail({svcResL: [{err: 'OK', res: {}}]})).toBeNull()
  })
})

describe('markProgress', () => {
  const stops = (): JourneyStop[] => ['A', 'B', 'C', 'D'].map(name => ({
    name, id: null, lat: 0, lon: 0, time: null, scheduled: null,
    delaySec: null, passed: false, cancelled: false
  }))

  it('marks everything before the stop being approached', () => {
    const s = stops()
    expect(markProgress(s, 'B', 'C')).toBe(2)
    expect(s.map(x => x.passed)).toEqual([true, true, false, false])
  })

  it('takes the FIRST match after the current stop, so a repeated name is safe', () => {
    const s = [...stops(), ...stops()] // A B C D A B C D
    expect(markProgress(s, 'A', 'B')).toBe(1)
    expect(markProgress(s.slice(4), 'A', 'B')).toBe(1)
  })

  it('resolves a later loop through the same stop from the from-stop', () => {
    const s: JourneyStop[] = ['A', 'B', 'A', 'C'].map(name => ({
      name, id: null, lat: 0, lon: 0, time: null, scheduled: null,
      delaySec: null, passed: false, cancelled: false
    }))
    // second time through A, heading for C
    expect(markProgress(s, 'A', 'C')).toBe(3)
  })

  it('marks NOTHING when the segment cannot be located', () => {
    // a wrong half of the route shown as travelled is worse than none of it
    const s = stops()
    expect(markProgress(s, 'B', 'Z')).toBe(-1)
    expect(s.some(x => x.passed)).toBe(false)
    expect(markProgress(s, 'B', undefined)).toBe(-1)
  })

  it('clears a previous pass before marking again', () => {
    const s = stops()
    markProgress(s, 'C', 'D')
    markProgress(s, 'A', 'B')
    expect(s.map(x => x.passed)).toEqual([true, false, false, false])
  })
})

const board = (jnyL: unknown[]) => ({
  svcResL: [{
    err: 'OK',
    res: {
      common: {prodL: [{name: 'S5', cls: 1}, {name: 'M10', cls: 4}, {name: '200', cls: 8}]},
      jnyL
    }
  }]
})

describe('parseStationBoard', () => {
  it('reads line, mode, direction and realtime time', () => {
    const d = parseStationBoard(board([
      {jid: 'a', prodX: 0, dirTxt: 'S Strausberg', stbStop: {dTimeS: '234800', dTimeR: '235000'}}
    ]))
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({
      jid: 'a', line: 'S5', product: 'suburban', direction: 'S Strausberg',
      time: '235000', scheduled: '234800', delaySec: 120, cancelled: false
    })
  })

  it('sorts earliest first, whatever order the feed used', () => {
    const d = parseStationBoard(board([
      {jid: 'late', prodX: 1, stbStop: {dTimeS: '235300'}},
      {jid: 'early', prodX: 0, stbStop: {dTimeS: '234800'}}
    ]))
    expect(d.map(x => x.jid)).toEqual(['early', 'late'])
  })

  it('KEEPS a cancelled departure — that is the useful case', () => {
    const d = parseStationBoard(board([
      {jid: 'x', prodX: 1, isCncl: true, stbStop: {dTimeS: '234800'}}
    ]))
    expect(d[0].cancelled).toBe(true)
  })

  it('carries the platform where the feed gives one', () => {
    const d = parseStationBoard(board([
      {jid: 'x', prodX: 0, stbStop: {dTimeS: '234800', dPltfR: {txt: '3'}}}
    ]))
    expect(d[0].platform).toBe('3')
  })

  it('keeps a replacement bus with its rail-style name, per its cls', () => {
    const d = parseStationBoard(board([
      {jid: 'x', prodX: 2, dirTxt: 'Ersatzverkehr', stbStop: {dTimeS: '234900'}}
    ]))
    expect(d[0]).toMatchObject({line: '200', product: 'bus'})
  })

  it('drops entries with no id or no time, rather than rendering blanks', () => {
    const d = parseStationBoard(board([
      {prodX: 0, stbStop: {dTimeS: '234800'}},
      {jid: 'no-time', prodX: 0, stbStop: {}}
    ]))
    expect(d).toEqual([])
  })

  it('returns an empty board on an error response', () => {
    expect(parseStationBoard({svcResL: [{err: 'NOOK'}]})).toEqual([])
    expect(parseStationBoard({})).toEqual([])
  })
})

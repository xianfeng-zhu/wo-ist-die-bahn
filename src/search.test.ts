import {describe, expect, it} from 'vitest'
import {nameKey, normalise, scoreName, search, type StopEntry} from './search.js'
import type {LineRef} from './vehicle.js'

// Real names from the shipped stations.json and the live line list.
const STOPS: StopEntry[] = [
  {id: '900100003', name: 'S+U Alexanderplatz Bhf (Berlin)'},
  {id: '900100005', name: 'Alexanderplatz, Grunerstr./Karl-Liebknecht-Str. (Berlin)'},
  {id: '900003201', name: 'S+U Berlin Hauptbahnhof'},
  {id: '900120005', name: 'S Ostbahnhof (Berlin)'},
  {id: '900120004', name: 'S+U Ostkreuz Bhf (Berlin)'},
  {id: '900192001', name: 'S Schöneweide Bhf (Berlin)'},
  {id: '900193002', name: 'Müggelseedamm/Bölschestr. (Berlin)'},
  {id: '900002201', name: 'U Birkenstr. (Berlin)'},
  {id: '900007110', name: 'U Turmstr. (Berlin)'}
]
const LINES: LineRef[] = [
  {line: 'M10', product: 'tram'},
  {line: 'M1', product: 'tram'},
  {line: 'U6', product: 'subway'},
  {line: 'S9', product: 'suburban'},
  {line: 'S9', product: 'bus'},
  {line: '100', product: 'bus'}
]

describe('normalise', () => {
  it('folds the German letters people do not type', () => {
    expect(normalise('Müggelseedamm')).toBe('muggelseedamm')
    expect(normalise('Schöneweide')).toBe('schoneweide')
    expect(normalise('Grünstraße')).toBe('grunstrasse')
  })
  it('expands the str. abbreviation both ways', () => {
    expect(normalise('U Turmstr.')).toBe('u turmstrasse')
    expect(normalise('Turmstrasse')).toBe('turmstrasse')
  })
  it('drops punctuation that only appears in the data', () => {
    expect(normalise('S+U Alexanderplatz Bhf (Berlin)')).toBe('s u alexanderplatz bhf berlin')
    expect(normalise('Wilhelminenhofstr./Edisonstr.')).toBe('wilhelminenhofstrasse edisonstrasse')
  })
})

describe('nameKey', () => {
  it('reduces a decorated station name to the name', () => {
    expect(nameKey('S+U Alexanderplatz Bhf (Berlin)')).toBe('alexanderplatz')
    expect(nameKey('S Ostbahnhof (Berlin)')).toBe('ostbahnhof')
    expect(nameKey('U Turmstr. (Berlin)')).toBe('turmstrasse')
  })
  it('does not eat a real word that starts with the mode letter', () => {
    expect(nameKey('S Schöneweide Bhf (Berlin)')).toBe('schoneweide')
    expect(nameKey('S+U Berlin Hauptbahnhof')).toBe('berlin hauptbahnhof')
  })
})

describe('scoreName', () => {
  it('ranks exact, then prefix, then word start, then anywhere', () => {
    // Bands, not exact numbers: within a band the shorter name wins, so comparing
    // two different names across bands says nothing useful.
    const band = (n: number) => n >= 1000 ? 'exact' : n >= 800 ? 'prefix' : n >= 600 ? 'word' : n > 0 ? 'anywhere' : 'none'
    expect(band(scoreName('S+U Alexanderplatz Bhf (Berlin)', 'alexanderplatz'))).toBe('exact')
    expect(band(scoreName('Alexanderplatz, Grunerstr. (Berlin)', 'alex'))).toBe('prefix')
    expect(band(scoreName('Grosser Alexanderweg', 'alex'))).toBe('word')
    // 'bahn' sits inside 'ostbahnhof' but does not start a word there
    expect(band(scoreName('S Ostbahnhof (Berlin)', 'bahn'))).toBe('anywhere')
    expect(band(scoreName('S Ostbahnhof (Berlin)', 'zzz'))).toBe('none')
  })

  it('treats a hyphen as a word break, so Karl-Alexander-Ring matches alex', () => {
    expect(scoreName('Karl-Alexander-Ring', 'alex')).toBeGreaterThanOrEqual(600)
  })
  it('matches a word start inside a decorated name', () => {
    expect(scoreName('S Ostbahnhof (Berlin)', 'ostbahnhof')).toBeGreaterThan(0)
  })
  it('is 0 for no match and for an empty query', () => {
    expect(scoreName('S Ostbahnhof', 'zzz')).toBe(0)
    expect(scoreName('S Ostbahnhof', '')).toBe(0)
  })
  it('prefers the shorter of two names in the same tier', () => {
    expect(scoreName('S+U Alexanderplatz Bhf (Berlin)', 'alexanderplatz'))
      .toBeGreaterThan(scoreName('Alexanderplatz, Grunerstr./Karl-Liebknecht-Str. (Berlin)', 'alexanderplatz'))
  })
})

describe('search', () => {
  const run = (q: string) => search(q, STOPS, LINES)

  it('returns nothing for an empty query', () => {
    expect(run('')).toEqual([])
    expect(run('  ')).toEqual([])
  })

  it('puts the line first when the query looks like a line', () => {
    const hits = run('M10')
    expect(hits[0]).toMatchObject({kind: 'line', line: 'M10'})
  })

  it('finds a stop by the part of the name people actually type', () => {
    expect(run('alex')[0]).toMatchObject({kind: 'stop', id: '900100003'})
    expect(run('muggelsee')[0]).toMatchObject({kind: 'stop', id: '900193002'})
    expect(run('schoneweide')[0]).toMatchObject({kind: 'stop', id: '900192001'})
  })

  it('finds a stop typed with its umlaut too', () => {
    expect(run('müggelsee')[0]).toMatchObject({kind: 'stop', id: '900193002'})
  })

  it('finds a street stop whether or not you abbreviate', () => {
    expect(run('turmstrasse')[0]).toMatchObject({kind: 'stop', id: '900007110'})
    expect(run('turmstr')[0]).toMatchObject({kind: 'stop', id: '900007110'})
  })

  it('keeps a line name that two modes share as two separate hits', () => {
    const hits = run('S9').filter(h => h.kind === 'line')
    expect(hits).toHaveLength(2)
    expect(new Set(hits.map(h => (h as {key: string}).key))).toEqual(new Set(['suburban:S9', 'bus:S9']))
  })

  it('honours the limit', () => {
    expect(search('s', STOPS, LINES, 3)).toHaveLength(3)
  })

  it('returns an empty list rather than everything for a miss', () => {
    expect(run('zzzzz')).toEqual([])
  })
})

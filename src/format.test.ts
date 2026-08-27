import {describe, expect, it} from 'vitest'
import {berlinSecondsOfDay, clockTime, delayLabel, etaLabel, minutesUntil, timeToSeconds} from './format.js'

describe('timeToSeconds', () => {
  it('reads the compact HAFAS form', () => {
    expect(timeToSeconds('232500')).toBe(23 * 3600 + 25 * 60)
  })
  it('reads the colon form too', () => {
    expect(timeToSeconds('23:25:00')).toBe(23 * 3600 + 25 * 60)
  })
  it('keeps HAFAS 24+ hours as given, for same-day arithmetic', () => {
    expect(timeToSeconds('250500')).toBe(25 * 3600 + 5 * 60)
  })
  it('reads the day-offset prefix the feed uses after midnight', () => {
    // real strings from a board queried at 00:01: 01000100 is a 00:01 departure
    // on the next day of operation, NOT 01:00:01
    expect(timeToSeconds('01000100')).toBe(86400 + 60)
    expect(timeToSeconds('01001000')).toBe(86400 + 10 * 60)
    expect(timeToSeconds('1235900')).toBe(86400 + 23 * 3600 + 59 * 60)
  })
  it('rejects nonsense rather than guessing', () => {
    expect(timeToSeconds('xxyyzz')).toBeNull()
    expect(timeToSeconds('')).toBeNull()
    expect(timeToSeconds(undefined)).toBeNull()
    expect(timeToSeconds('236100')).toBeNull() // 61 minutes
  })
})

describe('clockTime', () => {
  it('drops the seconds the feed never varies', () => {
    expect(clockTime('232500')).toBe('23:25')
  })
  it('wraps a 24+ hour back to a clock reading', () => {
    expect(clockTime('250500')).toBe('01:05')
  })
  it('folds a day offset back to a clock reading', () => {
    expect(clockTime('01000100')).toBe('00:01')
    expect(clockTime('01001000')).toBe('00:10')
  })
  it('shows a dash rather than a wrong time', () => {
    expect(clockTime(undefined)).toBe('—')
    expect(clockTime('nope')).toBe('—')
  })
})

describe('minutesUntil', () => {
  const at = (h: number, m: number) => h * 3600 + m * 60
  it('counts forward', () => {
    expect(minutesUntil('232500', at(23, 18))).toBe(7)
  })
  it('crosses midnight forward', () => {
    // 00:05 seen at 23:58 is 7 minutes away, not -1433
    expect(minutesUntil('000500', at(23, 58))).toBe(7)
  })
  it('handles HAFAS 24+ notation', () => {
    expect(minutesUntil('240500', at(23, 58))).toBe(7)
  })
  it('reports a departure already gone as negative', () => {
    expect(minutesUntil('231500', at(23, 18))).toBe(-3)
  })
  it('folds a day-offset string back to a real countdown', () => {
    // the bug this caught: at 00:01, a board says 01000100 for a departure now
    expect(minutesUntil('01000100', at(0, 1))).toBe(0)
    expect(minutesUntil('01001000', at(0, 1))).toBe(9)
  })
  it('is null when unreadable', () => {
    expect(minutesUntil('junk', at(12, 0))).toBeNull()
  })
})

describe('etaLabel', () => {
  it('says now rather than 0 min', () => {
    expect(etaLabel(0)).toBe('now')
  })
  it('labels the rest in minutes', () => {
    expect(etaLabel(1)).toBe('1 min')
    expect(etaLabel(14)).toBe('14 min')
  })
  it('marks a departure that has gone', () => {
    expect(etaLabel(-2)).toBe('gone')
  })
  it('shows a dash for no data', () => {
    expect(etaLabel(null)).toBe('—')
  })
})

describe('delayLabel', () => {
  it('says nothing when on time, so the UI can omit the line', () => {
    expect(delayLabel(0)).toBeNull()
    expect(delayLabel(20000)).toBeNull() // under half a minute
    expect(delayLabel(null)).toBeNull()
    expect(delayLabel(undefined)).toBeNull()
  })
  it('signs the value', () => {
    expect(delayLabel(120000)).toBe('+2 min')
    expect(delayLabel(-180000)).toBe('-3 min')
  })
})

describe('berlinSecondsOfDay', () => {
  it('uses Berlin wall clock, not UTC (summer, UTC+2)', () => {
    expect(berlinSecondsOfDay(new Date('2026-08-20T21:30:00Z'))).toBe(23 * 3600 + 30 * 60)
  })
  it('and in winter (UTC+1)', () => {
    expect(berlinSecondsOfDay(new Date('2026-01-15T22:30:00Z'))).toBe(23 * 3600 + 30 * 60)
  })
})

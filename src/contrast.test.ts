import {describe, expect, it} from 'vitest'
import {contrastRatio, relativeLuminance, textOn} from './contrast.js'
import {lineColors} from './line-colors.js'

describe('relativeLuminance', () => {
  it('anchors on black and white', () => {
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10)
  })
  it('accepts upper case and a missing hash', () => {
    expect(relativeLuminance('F0D722')).toBeCloseTo(relativeLuminance('#f0d722'), 12)
  })
  it('returns 0 for input it cannot read, so textOn falls back to white', () => {
    expect(relativeLuminance('not a colour')).toBe(0)
    expect(relativeLuminance('#abc')).toBe(0)
  })
})

describe('contrastRatio', () => {
  it('is 21:1 for black on white', () => {
    expect(contrastRatio(0, 1)).toBeCloseTo(21, 6)
  })
  it('is symmetric', () => {
    expect(contrastRatio(0.2, 0.8)).toBeCloseTo(contrastRatio(0.8, 0.2), 12)
  })
})

describe('textOn', () => {
  it('puts black on the colours that were unreadable in white', () => {
    // measured: U4 scored 1.45:1 against white, RE2 1.42:1
    expect(textOn('#F0D722')).toBe('#000000') // U4 yellow
    expect(textOn('#FFD502')).toBe('#000000') // RE2 yellow
    expect(textOn('#66AA22')).toBe('#000000') // S8 green
    expect(textOn('#009BD5')).toBe('#000000') // U7 / ferry blue
  })
  it('keeps white on the dark colours', () => {
    expect(textOn('#224F86')).toBe('#ffffff') // U8 dark blue
    expect(textOn('#16683D')).toBe('#ffffff') // U3 dark green
    expect(textOn('#992746')).toBe('#ffffff') // S9 purple-red
    expect(textOn('#c62828')).toBe('#ffffff') // tram red
  })
  it('flips the mid-tones that sat just under the minimum', () => {
    // white gave U6 4.29:1 and S7 4.50:1 — black gives them 4.89 and 4.67
    expect(textOn('#8C6DAB')).toBe('#000000')
    expect(textOn('#816DA6')).toBe('#000000')
  })
  it('falls back to white for an unreadable value', () => {
    expect(textOn('')).toBe('#ffffff')
  })
  it('reaches 4.5:1 on EVERY colour the app ships', () => {
    const failures: string[] = []
    for (const [line, hex] of Object.entries(lineColors)) {
      const bg = relativeLuminance(hex)
      const fg = textOn(hex) === '#000000' ? 0 : 1
      const ratio = contrastRatio(bg, fg)
      if (ratio < 4.5) failures.push(`${line} ${hex} ${ratio.toFixed(2)}:1`)
    }
    expect(failures).toEqual([])
  })
})

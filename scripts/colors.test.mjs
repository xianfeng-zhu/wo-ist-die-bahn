import {describe, expect, it} from 'vitest'
import {MODE_ROWS, parseLineColors, renderLineColorsTs} from './colors.mjs'

// Shaped like the real file: ';' separated, "Linie" first, "background_Hex" 11th.
const HEADER = 'Linie;Farbentitel;bacground_RAL;background_C;background_M;background_Y;background_K;background_R;background_G;background_B;background_Hex;text_R;text_G;text_B'
const row = (name, hex) => `${name};title;RAL;0;0;0;0;0;0;0;${hex};0;0;0`
const csv = (...rows) => [HEADER, ...rows].join('\n')

describe('parseLineColors', () => {
  it('keeps every mode, not just rail', () => {
    const out = parseLineColors(csv(
      row('S1', '#da6ba2'), row('U8', '#224f86'), row('RE1', '#e2001a'),
      row('RB25', '#007cb0'), row('FEX', '#79122f'), row('X9', '#6E368C')
    ))
    expect(out.map(([n]) => n)).toEqual(['S1', 'U8', 'RE1', 'RB25', 'FEX', 'X9'])
  })

  it('keeps the mode fallback rows', () => {
    const out = parseLineColors(csv(row('Tram', '#e2001a'), row('Bus', '#a5027d'), row('Fähre', '#009bd5')))
    expect(out.map(([n]) => n)).toEqual(['Tram', 'Bus', 'Fähre'])
    for (const [n] of out) expect(MODE_ROWS.has(n)).toBe(true)
  })

  it('drops the single-letter DB category codes', () => {
    // P, R, S and T are categories (PlusBus and so on), not lines. Left in, "S"
    // would sit in the map as if it were a line name.
    const out = parseLineColors(csv(row('S1', '#da6ba2'), row('P', '#FFBB00'), row('S', '#EC0016')))
    expect(out.map(([n]) => n)).toEqual(['S1'])
  })

  it('drops rows with no usable colour', () => {
    const out = parseLineColors(csv(row('RB21', ''), row('RE14', 'not-a-hex'), row('RB10', '#66aa22')))
    expect(out.map(([n]) => n)).toEqual(['RB10'])
  })

  it('normalises the hex to upper case and trims names', () => {
    expect(parseLineColors(csv(row(' S1 ', ' #da6ba2 ')))).toEqual([['S1', '#DA6BA2']])
  })

  it('throws on a CSV without the columns it needs', () => {
    expect(() => parseLineColors('a;b\n1;2')).toThrow(/Linie/)
  })
})

describe('renderLineColorsTs', () => {
  it('emits a valid module with the notice in it', () => {
    const ts = renderLineColorsTs([['S1', '#DA6BA2'], ['Fähre', '#009BD5']], '(c) VBB, CC BY 4.0')
    expect(ts).toContain('// (c) VBB, CC BY 4.0')
    expect(ts).toContain('export const lineColors: Record<string, string> = {')
    expect(ts).toContain(`  "S1": '#DA6BA2',`)
    // a non-ASCII name must be a quoted key, not a bare identifier
    expect(ts).toContain(`  "Fähre": '#009BD5',`)
    expect(ts.endsWith('}\n')).toBe(true)
  })
})

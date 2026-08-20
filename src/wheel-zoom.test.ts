import {describe, expect, it} from 'vitest'
import {classifyWheel, normalizeDelta} from './wheel-zoom.js'

describe('normalizeDelta', () => {
  it('passes pixel deltas through', () => {
    expect(normalizeDelta({deltaMode: 0, deltaY: -40} as WheelEvent)).toBe(-40)
  })
  it('scales line deltas by 40 (OL/MapLibre convention)', () => {
    expect(normalizeDelta({deltaMode: 1, deltaY: 3} as WheelEvent)).toBe(120)
  })
  it('scales page deltas by 300 (OpenLayers)', () => {
    expect(normalizeDelta({deltaMode: 2, deltaY: 1} as WheelEvent)).toBe(300)
  })
})

describe('classifyWheel (MapLibre detection)', () => {
  it('classifies tiny deltas as trackpad', () => {
    expect(classifyWheel(null, 2.5, 8)).toBe('trackpad')
    expect(classifyWheel('trackpad', -1.2, 8)).toBe('trackpad')
  })
  it('classifies quantized notch deltas as mouse wheel', () => {
    const notch = 4.000244140625 * 3
    expect(classifyWheel(null, notch, 8)).toBe('wheel')
  })
  it('treats a long gap as a new gesture (unknown type)', () => {
    expect(classifyWheel(null, 10, 500)).toBeNull()
  })
  it('infers trackpad from small delta*time product', () => {
    expect(classifyWheel(null, 10, 10)).toBe('trackpad') // 100 < 200
  })
  it('infers wheel from large delta*time product', () => {
    expect(classifyWheel(null, 10, 30)).toBe('wheel') // 300 >= 200
  })
  it('keeps the previous type once known', () => {
    expect(classifyWheel('trackpad', 50, 8)).toBe('trackpad')
    expect(classifyWheel('wheel', 100, 8)).toBe('wheel')
  })
})

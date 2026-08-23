import {describe, expect, it} from 'vitest'
import {classifyStep, MOTION_LIMITS, MotionRecorder} from './recorder.js'
import type {FrameEntry} from './recorder.js'

/** metres north of a base latitude */
const north = (m: number, base = 52.5): [number, number] => [base + m / 111320, 13.4]

describe('classifyStep', () => {
  it('reports distance and speed for a normal frame', () => {
    const c = classifyStep(north(0), north(0.4), null, 16)
    expect(c.metres).toBeCloseTo(0.4, 2)
    expect(c.mps).toBeCloseTo(25, 0)
    expect(c.jump).toBe(false)
  })

  it('flags a teleport', () => {
    const c = classifyStep(north(0), north(300), null, 16)
    expect(c.jump).toBe(true)
    expect(c.metres).toBeCloseTo(300, 0)
  })

  it('flags a reversal against the previous heading', () => {
    const back = classifyStep(north(10), north(9), [1, 0], 16)
    expect(back.reversal).toBe(true)
    const on = classifyStep(north(10), north(11), [1, 0], 16)
    expect(on.reversal).toBe(false)
  })

  it('ignores sub-noise movement when looking for reversals', () => {
    expect(classifyStep(north(10), north(9.9), [1, 0], 16).reversal).toBe(false)
  })

  it('does not divide by zero on a zero-length frame', () => {
    expect(classifyStep(north(0), north(1), null, 0).mps).toBe(0)
  })
})

describe('MotionRecorder', () => {
  const entry = (pos: [number, number], atTarget = false): FrameEntry[] =>
    [{id: 'v1', line: 'U8', pos, atTarget, target: 'U Boddinstr.'}]

  it('records an appearance the first time it sees a vehicle', () => {
    const r = new MotionRecorder(1000)
    r.frame(1000, entry(north(0)))
    expect(r.events.map(e => e.kind)).toEqual(['appear'])
  })

  it('detects a teleport between frames', () => {
    const r = new MotionRecorder(1000)
    r.frame(1000, entry(north(0)))
    r.frame(1016, entry(north(400)))
    expect(r.events.filter(e => e.kind === 'jump')).toHaveLength(1)
    expect(r.summary(1016).maxStepM).toBeGreaterThan(300)
  })

  it('detects a reversal', () => {
    const r = new MotionRecorder(1000)
    r.frame(1000, entry(north(0)))
    r.frame(1016, entry(north(5)))
    r.frame(1032, entry(north(3)))
    expect(r.events.filter(e => e.kind === 'reversal')).toHaveLength(1)
  })

  it('stays quiet while movement is normal', () => {
    const r = new MotionRecorder(1000)
    for (let i = 0; i <= 60; i++) r.frame(1000 + i * 16, entry(north(i * 0.4)))
    expect(r.events.filter(e => e.kind !== 'appear')).toEqual([])
  })

  it('times a dwell at the declared stop', () => {
    const r = new MotionRecorder(1000)
    r.frame(1000, entry(north(0), true))
    r.frame(6000, entry(north(0), true))
    r.frame(6016, entry(north(1), false))
    const d = r.events.find(e => e.kind === 'dwell')
    expect(d?.seconds).toBeCloseTo(5, 0)
  })

  it('reports a vehicle that stands still for too long', () => {
    const r = new MotionRecorder(1000)
    r.frame(1000, entry(north(0)))
    r.frame(1000 + (MOTION_LIMITS.freezeSec + 1) * 1000, entry(north(0)))
    expect(r.events.filter(e => e.kind === 'freeze')).toHaveLength(1)
  })

  it('logs a correction run with its distance and duration', () => {
    const r = new MotionRecorder(1000)
    const moving = (pos: [number, number], correcting: boolean): FrameEntry[] =>
      [{id: 'v1', line: 'U8', pos, atTarget: false, correcting}]
    r.frame(1000, moving(north(0), true))
    r.frame(1016, moving(north(20), true))
    r.frame(1032, moving(north(40), true))
    r.frame(1048, moving(north(60), false)) // correction ends on this frame
    const fix = r.events.find(e => e.kind === 'correction')
    expect(fix?.metres).toBeCloseTo(60, 0)
    expect(fix?.seconds).toBeCloseTo(0.048, 2)
  })

  it('ignores a brief fast burst, which is a re-anchor and not real speed', () => {
    const r = new MotionRecorder(1000)
    const e = (pos: [number, number]): FrameEntry[] => [{id: 'v1', line: 'U8', pos, atTarget: false}]
    // 90 m in 0.2 s (450 m/s for an instant), then normal running for 14 s
    r.frame(1000, e(north(0)))
    r.frame(1200, e(north(90)))
    for (let i = 1; i <= 466; i++) r.frame(1200 + i * 30, e(north(90 + i * 0.75))) // 25 m/s
    expect(r.events.filter(x => x.kind === 'overspeed')).toEqual([])
  })

  it('does not count distance covered while correcting as speed', () => {
    const r = new MotionRecorder(1000)
    const e = (pos: [number, number], correcting: boolean): FrameEntry[] =>
      [{id: 'v1', line: 'U6', pos, atTarget: false, correcting}]
    // 60 m/s sustained for 14 s, but every frame is a correction
    for (let i = 0; i <= 466; i++) r.frame(1000 + i * 30, e(north(i * 1.8), true))
    expect(r.events.filter(x => x.kind === 'overspeed')).toEqual([])
  })

  it('reports speed that is sustained across the window', () => {
    const r = new MotionRecorder(1000)
    const e = (pos: [number, number]): FrameEntry[] => [{id: 'v1', line: 'U8', pos, atTarget: false}]
    // 60 m/s held for 14 s — no real Berlin service does this
    for (let i = 0; i <= 466; i++) r.frame(1000 + i * 30, e(north(i * 1.8)))
    expect(r.events.filter(x => x.kind === 'overspeed').length).toBeGreaterThan(0)
    expect(r.events.find(x => x.kind === 'overspeed')?.mps).toBeGreaterThan(40)
  })

  it('records a vanish when a vehicle stops being reported', () => {
    const r = new MotionRecorder(1000)
    r.frame(1000, entry(north(0)))
    r.frame(1016, [])
    expect(r.events.filter(e => e.kind === 'vanish')).toHaveLength(1)
  })

  it('samples the trace at the configured interval, not every frame', () => {
    const r = new MotionRecorder(1000, 200)
    for (let i = 0; i < 60; i++) r.frame(1000 + i * 16, entry(north(i)))  // ~1 s of frames
    // 960 ms at 200 ms spacing is ~5 samples, far fewer than 60 frames
    expect(r.summary(1960).traceSamples).toBeLessThan(10)
    expect(r.summary(1960).frames).toBe(60)
  })

  it('summarises drift against reported positions', () => {
    const r = new MotionRecorder(1000)
    r.poll(new Map([['v1', north(0)]]), new Map([['v1', north(30)]]))
    expect(r.summary(2000).drift.medianM).toBe(30)
  })

  it('exports NDJSON with a meta header then events then positions', () => {
    const r = new MotionRecorder(1000, 0)
    r.frame(1000, entry(north(0)))
    const lines = r.toNdjson(1000).trim().split('\n').map(l => JSON.parse(l))
    expect(lines[0].type).toBe('meta')
    expect(lines.some(l => l.type === 'event')).toBe(true)
    expect(lines.some(l => l.type === 'pos')).toBe(true)
    // timestamps in the export are relative to the start
    expect(lines[1].t).toBe(0)
  })
})

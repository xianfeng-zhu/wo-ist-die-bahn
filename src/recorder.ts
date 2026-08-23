// Motion recorder: captures what the map actually DRAWS, so vehicle movement
// can be checked by measurement instead of by watching badges.
//
// Detection runs every animation frame, so single-frame faults (a teleport is
// exactly one frame) cannot be missed. The position trace is sampled at a lower
// rate, because storing every frame for every vehicle is ~350 MB per 15 min.

import {metresBetween} from './motion.js'

export const MOTION_LIMITS = {
  /** A step this large is a teleport: above the animation's own per-frame cap. */
  jumpM: 25,
  /** Direction flip sharper than this counts as going backwards. */
  reversalCos: -0.7,
  /** Ignore reversals below this, which are float noise rather than motion. */
  reversalMinM: 0.3,
  /**
   * 40 m/s = 144 km/h, above any Berlin S-Bahn (100 km/h), U-Bahn or tram.
   * Judged over `speedWindowSec`, never per frame: a single frame's speed says
   * nothing, because a re-anchor legitimately moves the badge fast for an
   * instant. Per-frame faults are caught by `jumpM` instead.
   */
  overspeedMps: 40,
  /**
   * Window for the sustained-speed check, and the minimum gap between reports.
   * 10 s, because a re-anchor is a burst of a few hundred milliseconds: over a
   * short window it is indistinguishable from real speed, over 10 s it is not.
   */
  speedWindowSec: 10,
  /** Standing still for longer than this while the data says otherwise. */
  freezeSec: 90
}

export type EventKind = 'jump' | 'reversal' | 'overspeed' | 'freeze' | 'dwell' | 'appear' | 'vanish' | 'correction'

export interface MotionEvent {
  t: number
  id: string
  line: string
  kind: EventKind
  metres?: number
  mps?: number
  seconds?: number
  at?: string
}

/**
 * Classify one frame of movement. `heading` is the previous movement vector,
 * used to detect a reversal; pass null when there isn't one yet.
 */
export function classifyStep(
  from: [number, number],
  to: [number, number],
  heading: [number, number] | null,
  dtMs: number
): {metres: number; mps: number; jump: boolean; reversal: boolean} {
  const metres = metresBetween(from, to)
  const mps = dtMs > 0 ? metres / (dtMs / 1000) : 0
  let reversal = false
  if (heading && metres >= MOTION_LIMITS.reversalMinM) {
    const v: [number, number] = [to[0] - from[0], to[1] - from[1]]
    const m1 = Math.hypot(heading[0], heading[1])
    const m2 = Math.hypot(v[0], v[1])
    if (m1 > 0 && m2 > 0) {
      reversal = (heading[0] * v[0] + heading[1] * v[1]) / (m1 * m2) < MOTION_LIMITS.reversalCos
    }
  }
  return {metres, mps, jump: metres > MOTION_LIMITS.jumpM, reversal}
}

/** One drawn sample of one vehicle. */
export interface FrameEntry {
  id: string
  line: string
  pos: [number, number]
  /** Pinned at the end of its path (arrived at the declared stop). */
  atTarget: boolean
  target?: string
  /**
   * The animation is dragging this badge toward a corrected position rather
   * than following the forecast. Speed is meaningless while this is true — the
   * limiter moves at up to CATCHUP_MAX_SPEED — so overspeed is not reported and
   * the correction is logged in its own right.
   */
  correcting?: boolean
}

interface Track {
  pos: [number, number]
  t: number
  heading: [number, number] | null
  /** When it last moved more than float noise. */
  movedT: number
  dwellFrom: number | null
  firstSeen: number
  fixFrom: number | null
  fixMetres: number
  /** Was the animation correcting on the previous frame? */
  wasCorrecting: boolean
  /** Rolling [time, cumulative distance] for the sustained-speed check. */
  hist: Array<[number, number]>
  cum: number
  lastOverspeedT: number
}

export interface RecorderSummary {
  startedAt: number
  seconds: number
  frames: number
  vehiclesSeen: number
  traceSamples: number
  events: Record<string, number>
  maxStepM: number
  drift: {samples: number; medianM: number; p90M: number; maxM: number}
}

/**
 * Buffers a trace plus every detected fault. Feed it `frame()` from the render
 * loop and `poll()` when fresh data lands.
 */
export class MotionRecorder {
  readonly events: MotionEvent[] = []
  private tracks = new Map<string, Track>()
  private trace: Array<[number, string, number, number]> = []
  private drifts: number[] = []
  private lastTraceT = 0
  private frames = 0
  private maxStep = 0
  private seen = new Set<string>()
  readonly startedAt: number

  constructor(startedAt: number, private readonly traceIntervalMs = 200, private readonly maxTrace = 2_000_000) {
    this.startedAt = startedAt
  }

  frame(now: number, entries: FrameEntry[]): void {
    this.frames++
    const takeTrace = now - this.lastTraceT >= this.traceIntervalMs
    if (takeTrace) this.lastTraceT = now
    const live = new Set<string>()

    for (const e of entries) {
      live.add(e.id)
      const prev = this.tracks.get(e.id)
      if (!prev) {
        this.events.push({t: now, id: e.id, line: e.line, kind: 'appear'})
        this.seen.add(e.id)
        this.tracks.set(e.id, {pos: e.pos, t: now, heading: null, movedT: now,
          dwellFrom: e.atTarget ? now : null, firstSeen: now,
          fixFrom: e.correcting ? now : null, fixMetres: 0, wasCorrecting: !!e.correcting,
          hist: [[now, 0]], cum: 0, lastOverspeedT: 0})
      } else {
        const dt = now - prev.t
        const c = classifyStep(prev.pos, e.pos, prev.heading, dt)
        this.maxStep = Math.max(this.maxStep, c.metres)
        if (c.jump) this.events.push({t: now, id: e.id, line: e.line, kind: 'jump', metres: +c.metres.toFixed(1), at: e.target})
        if (c.reversal) this.events.push({t: now, id: e.id, line: e.line, kind: 'reversal', metres: +c.metres.toFixed(1), at: e.target})
        // Sustained speed over a window, not this frame's speed — and only of
        // forecast-driven motion. Distance covered while correcting belongs to
        // the `correction` events, not to the vehicle's speed; counting it made
        // a vehicle with 119 m of corrections in 24 s look like it ran at
        // 179 km/h.
        const cum = prev.cum + (e.correcting ? 0 : c.metres)
        const hist = prev.hist
        hist.push([now, cum])
        const windowMs = MOTION_LIMITS.speedWindowSec * 1000
        while (hist.length > 2 && now - hist[0][0] > windowMs) hist.shift()
        const spanMs = now - hist[0][0]
        if (spanMs >= windowMs * 0.8) {
          const mps = (cum - hist[0][1]) / (spanMs / 1000)
          if (mps > MOTION_LIMITS.overspeedMps && now - prev.lastOverspeedT > windowMs) {
            this.events.push({t: now, id: e.id, line: e.line, kind: 'overspeed',
              mps: +mps.toFixed(1), seconds: +(spanMs / 1000).toFixed(1), at: e.target})
            prev.lastOverspeedT = now
          }
        }
        // a correction run: how far the badge had to be dragged, and for how long
        let fixFrom = prev.fixFrom
        let fixMetres = prev.fixMetres
        if (e.correcting) { if (fixFrom === null) { fixFrom = now; fixMetres = 0 } ; fixMetres += c.metres }
        else if (fixFrom !== null) {
          fixMetres += c.metres // this frame is the correction finishing, so count it
          this.events.push({t: now, id: e.id, line: e.line, kind: 'correction',
            metres: +fixMetres.toFixed(1), seconds: +((now - fixFrom) / 1000).toFixed(2), at: e.target})
          fixFrom = null
          fixMetres = 0
        }

        const moving = c.metres >= 0.05
        if (!moving && now - prev.movedT > MOTION_LIMITS.freezeSec * 1000) {
          this.events.push({t: now, id: e.id, line: e.line, kind: 'freeze', seconds: +((now - prev.movedT) / 1000).toFixed(1), at: e.target})
          prev.movedT = now // report once per freezeSec window
        }
        // dwell: a run of frames pinned at the declared stop
        let dwellFrom = prev.dwellFrom
        if (e.atTarget && dwellFrom === null) dwellFrom = now
        else if (!e.atTarget && dwellFrom !== null) {
          this.events.push({t: now, id: e.id, line: e.line, kind: 'dwell', seconds: +((now - dwellFrom) / 1000).toFixed(1), at: e.target})
          dwellFrom = null
        }
        this.tracks.set(e.id, {
          pos: e.pos, t: now,
          heading: c.metres >= MOTION_LIMITS.reversalMinM ? [e.pos[0] - prev.pos[0], e.pos[1] - prev.pos[1]] : prev.heading,
          movedT: moving ? now : prev.movedT,
          dwellFrom, firstSeen: prev.firstSeen, fixFrom, fixMetres,
          wasCorrecting: !!e.correcting,
          hist, cum, lastOverspeedT: prev.lastOverspeedT
        })
      }
      if (takeTrace && this.trace.length < this.maxTrace) {
        this.trace.push([now - this.startedAt, e.id, Math.round(e.pos[0] * 1e6), Math.round(e.pos[1] * 1e6)])
      }
    }

    for (const [id, tr] of this.tracks) {
      if (live.has(id)) continue
      this.events.push({t: now, id, line: '', kind: 'vanish', seconds: +((now - tr.firstSeen) / 1000).toFixed(1)})
      this.tracks.delete(id)
    }
  }

  /** Rendered position vs the position the operator just reported. */
  poll(rendered: Map<string, [number, number]>, reported: Map<string, [number, number]>): void {
    for (const [id, r] of reported) {
      const d = rendered.get(id)
      if (d) this.drifts.push(metresBetween(d, r))
    }
  }

  summary(now: number): RecorderSummary {
    const counts: Record<string, number> = {}
    for (const e of this.events) counts[e.kind] = (counts[e.kind] ?? 0) + 1
    const s = [...this.drifts].sort((a, b) => a - b)
    const q = (f: number): number => Math.round(s[Math.floor(s.length * f)] ?? 0)
    return {
      startedAt: this.startedAt,
      seconds: Math.round((now - this.startedAt) / 1000),
      frames: this.frames,
      vehiclesSeen: this.seen.size,
      traceSamples: this.trace.length,
      events: counts,
      maxStepM: +this.maxStep.toFixed(1),
      drift: {samples: s.length, medianM: q(0.5), p90M: q(0.9), maxM: Math.round(s[s.length - 1] ?? 0)}
    }
  }

  /** Newline-delimited JSON: one header, then events, then trace rows. */
  toNdjson(now: number): string {
    const lines = [JSON.stringify({type: 'meta', ...this.summary(now), limits: MOTION_LIMITS})]
    for (const e of this.events) lines.push(JSON.stringify({type: 'event', ...e, t: e.t - this.startedAt}))
    for (const [t, id, lat, lon] of this.trace) lines.push(JSON.stringify({type: 'pos', t, id, lat, lon}))
    return lines.join('\n') + '\n'
  }
}

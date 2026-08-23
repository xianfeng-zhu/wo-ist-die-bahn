// Pure motion helpers for smooth, track-following vehicle animation.

export interface LatLon {
  lat: number
  lon: number
}

export interface AnimState {
  /** Wall-clock epoch (ms) that forecast offset `ms[0]` corresponds to. */
  reportT: number
  /** Forecast offsets (ms after `reportT`), ascending. */
  ms: number[]
  /** Distance along `path` at each forecast offset, non-decreasing. */
  alongs: number[]
  /** Total length of `path` in the same units as `alongs`. */
  total: number
  /** Segment start (the reported position when the segment was created). */
  start: LatLon
  /** Segment end (the declared next stop). */
  end: LatLon
  /** Next stop name (segment identity; a change starts a new segment). */
  endName?: string
  /** Track from start to end (lat/lon); falls back to a straight line. */
  path: Array<[number, number]>
  /** Line name (used to slice the track for the current segment). */
  line?: string
  /**
   * Highest distance along `path` already drawn. Motion is forward-only: each
   * poll re-anchors on the reported position, which can sit slightly BEHIND
   * what we had extrapolated, and snapping back reads as the vehicle reversing.
   * Hold instead until the forecast catches up.
   */
  drawnAlong: number
  /** Wall clock of the last draw, so catch-up can be rate-limited over time. */
  drawnT: number
  /**
   * The position actually drawn last frame. Survives a path swap, so a
   * corrected position is glided to rather than snapped to (see stepTowards).
   */
  renderPos?: [number, number]
  /** True while `renderPos` still trails the computed position (see stepTowards). */
  correcting?: boolean
  /** Last direction the badge actually moved, so it can never be dragged back. */
  heading?: [number, number]
}

/**
 * How long to keep coasting after the forecast's last sample. Covers a late
 * poll without inventing minutes of movement: once data stops arriving the
 * vehicle stops too, rather than gliding off on a stale prediction.
 */
export const COAST_GRACE_MS = 5000

/** Metres between two lat/lon points (local flat approximation). */
export function metresBetween(a: [number, number], b: [number, number]): number {
  return Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * Math.cos(a[0] * Math.PI / 180))
}

/**
 * Fastest the drawn position may be dragged toward a corrected one. Far above
 * any real vehicle (~1440 km/h) so normal motion lands exactly on target with
 * no lag, but slow enough that a correction is a glide rather than a blink:
 * at 60 fps this caps a single frame at ~7 m.
 */
export const CATCHUP_MAX_SPEED = 400

/**
 * Hard ceiling on one frame's correction, whatever `dtMs` says. A stalled frame
 * (slow tab, background throttling) would otherwise buy a budget big enough to
 * be a visible jump again. 25 m is above anything normal motion needs at a
 * realistic frame rate, so it only ever limits corrections.
 */
export const CATCHUP_MAX_STEP = 25

/**
 * Move `from` toward `to`, covering at most `CATCHUP_MAX_SPEED` over `dtMs`.
 *
 * Rate-limiting has to happen in position space, not along-track space: each
 * poll can replace the whole path, and a point projected onto a *new* path can
 * land far from where the badge was drawn. That showed up as the badge blinking
 * out and reappearing hundreds of metres ahead.
 */
export function stepTowards(from: [number, number], to: [number, number], dtMs: number): [number, number] {
  const gap = metresBetween(from, to)
  const budget = Math.min(CATCHUP_MAX_SPEED * Math.max(0, dtMs) / 1000, CATCHUP_MAX_STEP)
  if (gap === 0 || gap <= budget) return to
  const f = budget / gap
  return [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f]
}

/**
 * Move `from` toward `to`, but never against `heading`.
 *
 * `stepTowards` has no sense of direction: when a poll corrects a badge to a
 * position BEHIND it, easing there drags it backwards. `drawnAlong` keeps
 * progress monotonic along one path, but a path swap re-projects the position,
 * so the guarantee has to be repeated here in position space. Holding until the
 * correction moves ahead reads as a pause; reversing reads as a bug.
 */
export function forwardStep(
  from: [number, number],
  to: [number, number],
  heading: [number, number] | null,
  dtMs: number
): [number, number] {
  const next = stepTowards(from, to, dtMs)
  if (!heading) return next
  const move: [number, number] = [next[0] - from[0], next[1] - from[1]]
  return heading[0] * move[0] + heading[1] * move[1] < 0 ? from : next
}

/** Distance in metres along a path of lat/lon points. */
export function pathMetres(path: Array<[number, number]>): number {
  let total = 0
  for (let i = 1; i < path.length; i++) total += metresBetween(path[i - 1], path[i])
  return total
}

/**
 * Fastest a Berlin S-Bahn, U-Bahn or tram plausibly runs (45 m/s = 162 km/h,
 * comfortably above the S-Bahn's 100 km/h). If a track implies more than this
 * over the forecast, the track is wrong for this vehicle — usually a shape that
 * fits within tolerance but takes a much longer way round, or a ring line where
 * projection wraps to the far side.
 */
export const SPEED_SANITY_MPS = 45

/**
 * Speed the forecast implies along `path`, in m/s. Returns 0 when it cannot be
 * determined. `alongs`/`total` are in the degree units `projectOntoPath` uses,
 * so the fraction is converted through the path's true length.
 */
export function impliedSpeed(
  ms: number[], alongs: number[], total: number, path: Array<[number, number]>
): number {
  const n = Math.min(ms.length, alongs.length)
  if (n < 2 || total <= 0) return 0
  const seconds = (ms[n - 1] - ms[0]) / 1000
  if (seconds <= 0) return 0
  const fraction = (alongs[n - 1] - alongs[0]) / total
  return (fraction * pathMetres(path)) / seconds
}

/**
 * Time constant for closing a gap between the drawn position and the forecast.
 * A gap opens when the vehicle sits at the end of its path (the declared stop)
 * while the real one drives on: the next segment then starts hundreds of metres
 * ahead. Snapping there looks like the badge blinking out and reappearing, so
 * close the gap over ~1.5 s instead. Small gaps are absorbed almost at once.
 */
export const CATCHUP_TAU_MS = 500

/**
 * Distance along `state.path` to draw at `nowMs`.
 *
 * Tracks the forecast exactly while it is being followed, and closes any
 * backlog smoothly on top of that. Forward-only: when the drawn position is
 * AHEAD of the forecast (after a hold) it slows rather than reversing. Bounded
 * by `COAST_GRACE_MS` past the forecast and by the path length.
 */
export function advanceAlong(state: AnimState, nowMs: number): number {
  const lastMs = state.ms.length > 0 ? state.ms[state.ms.length - 1] : 0
  const cap = lastMs + COAST_GRACE_MS
  const at = (since: number): number =>
    alongAt(state.ms, state.alongs, Math.min(since, cap), state.total)

  const expected = at(nowMs - state.reportT)
  const previous = at(state.drawnT - state.reportT)
  const dt = Math.max(0, nowMs - state.drawnT)
  // what the forecast itself advanced since the last draw
  const nominal = Math.max(0, expected - previous)
  // how far the drawn position trails (negative = it is ahead, so ease off)
  const backlog = previous - state.drawnAlong
  const closed = backlog * (1 - Math.exp(-dt / CATCHUP_TAU_MS))
  const next = state.drawnAlong + nominal + closed
  return Math.max(state.drawnAlong, Math.min(state.total, next))
}

/**
 * Distance along a path at `elapsedMs`, from the operator's own forecast
 * samples (`ms[i]` -> `alongs[i]`, both ascending, same length, >= 1 entry).
 *
 * Piecewise-linear between samples. Past the last sample it keeps going at the
 * last sample interval's speed, so a late poll coasts instead of freezing.
 * Never decreases and never exceeds `total`.
 */
export function alongAt(ms: number[], alongs: number[], elapsedMs: number, total: number): number {
  const n = Math.min(ms.length, alongs.length)
  if (n === 0) return 0
  const clamp = (a: number): number => Math.max(0, Math.min(total, a))
  if (n === 1 || elapsedMs <= ms[0]) return clamp(alongs[0])
  for (let i = 1; i < n; i++) {
    if (elapsedMs <= ms[i]) {
      const span = ms[i] - ms[i - 1]
      const f = span <= 0 ? 1 : (elapsedMs - ms[i - 1]) / span
      return clamp(alongs[i - 1] + (alongs[i] - alongs[i - 1]) * f)
    }
  }
  // past the forecast: coast at the last known speed
  const span = ms[n - 1] - ms[n - 2]
  const speed = span <= 0 ? 0 : (alongs[n - 1] - alongs[n - 2]) / span
  return clamp(alongs[n - 1] + speed * (elapsedMs - ms[n - 1]))
}

/** Position at `progress` (0..1) along a path, walking by accumulated length. */
export function pointAlongPath(path: Array<[number, number]>, progress: number): [number, number] {
  if (path.length === 0) return [0, 0]
  if (path.length === 1 || progress <= 0) return path[0]
  if (progress >= 1) return path[path.length - 1]
  const lengths: number[] = []
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])
    lengths.push(d)
    total += d
  }
  if (total === 0) return path[0]
  let target = total * progress
  for (let i = 0; i < lengths.length; i++) {
    if (target <= lengths[i] || i === lengths.length - 1) {
      const f = lengths[i] === 0 ? 0 : target / lengths[i]
      return [
        path[i][0] + (path[i + 1][0] - path[i][0]) * f,
        path[i][1] + (path[i + 1][1] - path[i][1]) * f
      ]
    }
    target -= lengths[i]
  }
  return path[path.length - 1]
}

/**
 * Project a point onto a path: returns the distance along the path to the
 * nearest point on it (and that nearest point). Used to anchor animated
 * positions and stops onto the line shape.
 */
export function projectOntoPath(path: Array<[number, number]>, pt: LatLon): {along: number; point: [number, number]} {
  if (path.length === 0) return {along: 0, point: [pt.lat, pt.lon]}
  if (path.length === 1) return {along: 0, point: path[0]}
  let bestAlong = 0
  let bestDist = Infinity
  let bestPoint: [number, number] = path[0]
  let acc = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1])
    const abx = b[0] - a[0]
    const aby = b[1] - a[1]
    let t = segLen === 0 ? 0 : ((pt.lat - a[0]) * abx + (pt.lon - a[1]) * aby) / (segLen * segLen)
    t = Math.max(0, Math.min(1, t))
    const px = a[0] + abx * t
    const py = a[1] + aby * t
    const d = Math.hypot(pt.lat - px, pt.lon - py)
    if (d < bestDist) {
      bestDist = d
      bestAlong = acc + segLen * t
      bestPoint = [px, py]
    }
    acc += segLen
  }
  return {along: bestAlong, point: bestPoint}
}

/**
 * Slice a path between two along-distances (a < b). Returns the sub-path from
 * `a` to `b`, including the interpolated endpoints.
 */
export function slicePath(path: Array<[number, number]>, a: number, b: number): Array<[number, number]> {
  if (path.length === 0 || b <= a) return path.length ? [path[0]] : []
  const lengths: number[] = []
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])
    lengths.push(d)
    total += d
  }
  if (total === 0) return [path[0]]
  const pointAt = (dist: number): [number, number] => {
    let target = Math.max(0, Math.min(total, dist))
    for (let i = 0; i < lengths.length; i++) {
      if (target <= lengths[i] || i === lengths.length - 1) {
        const f = lengths[i] === 0 ? 0 : target / lengths[i]
        return [path[i][0] + (path[i + 1][0] - path[i][0]) * f, path[i][1] + (path[i + 1][1] - path[i][1]) * f]
      }
      target -= lengths[i]
    }
    return path[path.length - 1]
  }
  const out: Array<[number, number]> = [pointAt(a)]
  let acc = 0
  for (let i = 1; i < path.length; i++) {
    acc += lengths[i - 1]
    if (acc > a && acc < b) out.push(path[i])
  }
  out.push(pointAt(b))
  return out
}

/**
 * Convert a Berlin wall-clock time (date `YYYYMMDD`, time `HHMMSS`) to an
 * epoch (ms), DST-aware via Europe/Berlin.
 */
export function berlinEpoch(dateStr: string, timeStr: string): number {
  const d = Number(dateStr.slice(0, 4))
  const mo = Number(dateStr.slice(4, 6))
  const day = Number(dateStr.slice(6, 8))
  const h = Number(timeStr.slice(0, 2))
  const mi = Number(timeStr.slice(2, 4))
  const s = Number(timeStr.slice(4, 6))
  // Two-pass: guess UTC, read the Berlin wall clock, correct the offset.
  let epoch = Date.UTC(d, mo - 1, day, h, mi, s)
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(epoch))
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? '0')
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return epoch - (wall - epoch)
}

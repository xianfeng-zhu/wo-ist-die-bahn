// Pure motion helpers for smooth, track-following vehicle animation.

export interface LatLon {
  lat: number
  lon: number
}

export interface AnimState {
  /** 0..1 along the segment path (0 = segment start, 1 = next stop). */
  progress: number
  /** progress units per second (smoothed, forward-only). */
  velocity: number
  /** Segment start (the animated position when the segment was created). */
  start: LatLon
  /** Segment end (the next stop). */
  end: LatLon
  /** Arrival epoch (ms) at the next stop (Europe/Berlin wall clock). */
  endT: number
  /** Next stop name (segment identity; a change starts a new segment). */
  endName?: string
  /** Track from start to end (lat/lon); falls back to a straight line. */
  path: Array<[number, number]>
}

export interface MotionOpts {
  /** 1.0 = real-time pace; scales the schedule-derived speed. */
  speedFactor: number
  /** Max progress/sec change per second (smooth speed transitions). */
  maxAccel: number
  maxDecel: number
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

/**
 * Advance one animation step. Forward-only: progress never decreases; the
 * vehicle eases toward the schedule-paced target velocity and holds when the
 * arrival is due or the data target is behind.
 */
export function advanceAnimation(state: AnimState, nowMs: number, dtMs: number, opts: MotionOpts): AnimState {
  const dt = Math.max(dtMs, 0) / 1000
  const remaining = Math.max(state.endT - nowMs, 0) / 1000
  const targetVel = remaining > 0 && state.progress < 1
    ? Math.min((1 - state.progress) / remaining, 1) * opts.speedFactor
    : 0

  // bounded acceleration toward the (non-negative) target — smooth transitions
  const maxStep = targetVel >= state.velocity ? opts.maxAccel * dt : opts.maxDecel * dt
  const nextVel = Math.max(0, state.velocity + Math.max(-maxStep, Math.min(maxStep, targetVel - state.velocity)))

  let progress = state.progress + nextVel * dt
  if (progress >= 1) {
    progress = 1
  }

  return {...state, progress, velocity: progress >= 1 ? 0 : nextVel}
}

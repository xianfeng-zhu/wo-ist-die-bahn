// Douglas-Peucker path simplification, in metres.
//
// Replaces blind Nth-point decimation. That kept every Nth point regardless of
// geometry: it wasted points on straight runs and cut corners on curves, which
// is what put GTFS-track residuals in a ~100 m noise band (the band
// SHAPE_FIT_LIMIT_M was originally sized around). This keeps a point only when
// dropping it would move the line by more than `toleranceM`, so the error is
// bounded by construction rather than by luck.

const MPD_LAT = 111320

/** Perpendicular distance from `p` to segment `a`-`b`, in metres. */
function distToSegM(p, a, b) {
  const kx = MPD_LAT * Math.cos((a[0] * Math.PI) / 180)
  const py = (p[0] - a[0]) * MPD_LAT
  const px = (p[1] - a[1]) * kx
  const by = (b[0] - a[0]) * MPD_LAT
  const bx = (b[1] - a[1]) * kx
  const len2 = by * by + bx * bx
  if (len2 === 0) return Math.hypot(py, px)
  const t = Math.max(0, Math.min(1, (py * by + px * bx) / len2))
  return Math.hypot(py - by * t, px - bx * t)
}

/**
 * Simplify `pts` (an array of `[lat, lon]`) so that no original point lies
 * further than `toleranceM` from the result. Endpoints are always kept.
 *
 * Iterative rather than recursive: GTFS shapes reach tens of thousands of
 * points, and a recursive split can blow the stack on a degenerate input.
 */
export function simplifyPath(pts, toleranceM) {
  if (pts.length <= 2) return pts.slice()
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()
    let worst = -1
    let worstAt = -1
    for (let i = lo + 1; i < hi; i++) {
      const d = distToSegM(pts[i], pts[lo], pts[hi])
      if (d > worst) {
        worst = d
        worstAt = i
      }
    }
    if (worst > toleranceM && worstAt > lo && worstAt < hi) {
      keep[worstAt] = 1
      stack.push([lo, worstAt], [worstAt, hi])
    }
  }
  const out = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i])
  return out
}

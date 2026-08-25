// Route-variant helpers for the data-prep step, extracted so they can be tested.

const MPD_LAT = 111320

/** Metres between two [lat, lon] points (local flat approximation). */
function metres(a, b) {
  return Math.hypot((a[0] - b[0]) * MPD_LAT, (a[1] - b[1]) * MPD_LAT * Math.cos((a[0] * Math.PI) / 180))
}

/** Length of a [lat, lon] path in metres. */
export function pathMetres(pts) {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += metres(pts[i - 1], pts[i])
  return total
}

/** Point at `frac` (0..1) of the way along a path, measured BY DISTANCE. */
function pointAtFraction(pts, frac) {
  if (pts.length === 0) return [0, 0]
  if (pts.length === 1) return pts[0]
  const total = pathMetres(pts)
  if (total === 0) return pts[0]
  let target = total * Math.max(0, Math.min(1, frac))
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const d = metres(a, b)
    if (target <= d || i === pts.length - 1) {
      const f = d === 0 ? 0 : Math.min(1, target / d)
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
    }
    target -= d
  }
  return pts[pts.length - 1]
}

/**
 * Corridor fingerprint: the route sampled at 12 fractions BY DISTANCE, rounded
 * to ~100 m, plus a length bucket.
 *
 * Sampling by index fraction — the previous version — is not sampling by
 * position. After Douglas-Peucker, vertex density tracks curviness, so the same
 * corridor recorded at a different vertex spacing produced a different key.
 * Measured: the index-fraction sample sat a median 574 m (p90 2.7 km) from the
 * distance-fraction sample, and 515 of 530 geometrically identical corridor
 * pairs failed to merge. The dedupe step was close to inert as a result.
 *
 * The length bucket keeps a full route distinct from a short turn that happens
 * to sample onto the same cells.
 */
export function corridorKey(pts) {
  const k = []
  for (let i = 0; i < 12; i++) {
    const p = pointAtFraction(pts, i / 11)
    k.push(`${p[0].toFixed(3)},${p[1].toFixed(3)}`) // 3 dp ~ 100 m
  }
  k.push(Math.round(pathMetres(pts) / 500))
  return k.join(';')
}

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
 * Does `inner` run entirely along `outer`, within `tolM`?
 *
 * A short turn is a sub-slice of a longer variant, so shipping it adds nothing:
 * a vehicle on it projects onto the longer one correctly. 365 of 533 shipped
 * variants were contained this way, and because each was simplified
 * independently their vertices differ by sub-metre amounts — so residuals tied
 * to float noise and `pickShape`'s choice flipped between polls, swapping the
 * path under a running animation.
 */
export function isContainedIn(inner, outer, tolM) {
  if (outer.length < 2) return false
  for (const p of inner) {
    let best = Infinity
    for (let i = 1; i < outer.length; i++) {
      best = Math.min(best, distToSegM(p, outer[i - 1], outer[i]))
      if (best <= tolM) break
    }
    if (best > tolM) return false
  }
  return true
}

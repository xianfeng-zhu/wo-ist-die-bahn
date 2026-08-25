import {LatLon, maxResidualM, projectOntoPath, slicePath} from './motion.js'

/** One route variant: an ordered list of lat/lon points. */
export type Shape = Array<[number, number]>

/**
 * Route variants keyed by line name.
 *
 * A line has more than one because branches and short turns do not share
 * geometry, and the two ring directions (S41/S42) run different track. Shipping
 * only one per line was the root cause of the fit guards in main.ts: 6.3% of
 * live vehicles projected onto a shape that missed by 300 m to 6.5 km.
 */
export type LineShapes = Record<string, Shape[]>

/**
 * Choose the variant the operator's forecast points actually lie on.
 *
 * The forecast is the only evidence of which branch a vehicle is on. HAFAS names
 * the next stop but not the route taken to reach it, and a headsign does not
 * identify a route — live U7 shows six destinations for a two-terminus line,
 * and M5 reaches one depot by two different streets.
 *
 * Returns its best candidate however poorly it fits; the caller applies its own
 * limit, so the fit threshold stays in one place (SHAPE_FIT_LIMIT_M).
 *
 * KNOWN LIMITATION — the choice is not stable. Variants of one line overlap, and
 * a 30 s forecast is only four points, so many candidates fit equally well:
 * measured on live data, the median gap to the runner-up is 0.0 m and 310 of 319
 * vehicles are within 5 m. 42% of vehicles therefore change variant within 60 s,
 * 21% of them while their declared stop never changed, which swaps the path
 * under the animation. Breaking ties by track length was tried and measured
 * WORSE on every other axis (drift p90 61 -> 106 m, dwell p90 12 -> 43 s,
 * overspeed 0 -> 8), because it prefers full-line and full-ring variants, and
 * projecting onto a long or closed shape is itself ambiguous. A stable fix needs
 * hysteresis (remember the variant on AnimState and keep it while it still fits)
 * or a tie-break on which variant actually reaches the declared stop.
 */
export function pickShape(shapes: Shape[] | undefined, pts: Shape): Shape | undefined {
  if (!shapes || shapes.length === 0) return undefined
  const usable = shapes.filter(s => s.length >= 2)
  if (usable.length === 0) return undefined
  if (usable.length === 1 || pts.length === 0) return usable[0]
  let best = usable[0]
  let bestResidual = Infinity
  for (const shape of usable) {
    const r = maxResidualM(shape, pts)
    if (r < bestResidual) {
      bestResidual = r
      best = shape
    }
  }
  return best
}

/**
 * Build the track path for a vehicle segment: the slice of the line's shape
 * between `from` (the animated position) and `to` (the next stop), handling
 * shape direction. `hint` is the forecast, used to choose between variants.
 * Falls back to a straight line when no shape is usable.
 */
export function buildSegmentPath(
  lineShapes: LineShapes,
  line: string | undefined,
  from: LatLon,
  to: LatLon,
  hint: Shape = []
): Shape {
  const shape = pickShape(line ? lineShapes[line] : undefined, hint)
  if (shape && shape.length >= 2) {
    const a = projectOntoPath(shape, from)
    const b = projectOntoPath(shape, to)
    if (b.along > a.along + 1e-9) {
      return slicePath(shape, a.along, b.along)
    }
    if (a.along > b.along + 1e-9) {
      // shape runs opposite to travel direction: reverse the sliced path so
      // index 0 is the vehicle position
      return slicePath(shape, b.along, a.along).reverse()
    }
  }
  return [[from.lat, from.lon], [to.lat, to.lon]]
}

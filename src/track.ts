import {LatLon, projectOntoPath, slicePath, StopLike} from './motion.js'

/** Line shapes keyed by line name (lat/lon pairs). */
export type LineShapes = Record<string, Array<[number, number]>>

/**
 * Index of the first remaining stop that lies AHEAD of `from` in the
 * vehicle's TRAVEL direction (from the stops list order — HAFAS stopL is
 * travel-ordered), regardless of the shape's stored direction. Returns -1
 * when no stop is ahead (vehicle has passed all known stops).
 */
export function firstStopAhead(
  lineShapes: LineShapes,
  line: string | undefined,
  from: LatLon,
  stops: StopLike[]
): number {
  const shape = line ? lineShapes[line] : undefined
  if (shape && shape.length >= 2 && stops.length >= 2) {
    const fromAlong = projectOntoPath(shape, from).along
    // travel direction on the shape, from the stops order (stops[0] -> stops[1])
    const dir = Math.sign(projectOntoPath(shape, stops[1]).along - projectOntoPath(shape, stops[0]).along)
    if (dir !== 0) {
      for (let k = 1; k < stops.length; k++) {
        const delta = projectOntoPath(shape, stops[k]).along - fromAlong
        if (dir > 0 ? delta > 0 : delta < 0) return k
      }
      return -1
    }
  }
  // no shape / degenerate: assume the first listed upcoming stop is ahead
  return stops.length > 1 ? 1 : -1
}

/**
 * Build the track path for a vehicle segment: the slice of the line's shape
 * between `from` (the animated position) and `to` (the next stop), handling
 * shape direction. Falls back to a straight line when the shape is missing.
 */
export function buildSegmentPath(
  lineShapes: LineShapes,
  line: string | undefined,
  from: LatLon,
  to: LatLon
): Array<[number, number]> {
  const shape = line ? lineShapes[line] : undefined
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

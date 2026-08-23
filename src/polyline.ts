// Google encoded-polyline decoder, used for HAFAS `common.polyL[].crdEncYX`
// (delta-encoded, dim 2, latitude before longitude, 1e5 precision).

/**
 * Decode an encoded polyline into `[lat, lon]` pairs. Returns `[]` for an
 * empty string. Trailing partial input is ignored rather than throwing —
 * transforms never throw on wire data.
 */
export function decodePolyline(encoded: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let i = 0
  let lat = 0
  let lon = 0
  while (i < encoded.length) {
    let shift = 0
    let result = 0
    let b: number
    do {
      b = encoded.charCodeAt(i++) - 63
      if (Number.isNaN(b)) return out // truncated input
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    lat += result & 1 ? ~(result >> 1) : result >> 1
    shift = 0
    result = 0
    do {
      b = encoded.charCodeAt(i++) - 63
      if (Number.isNaN(b)) return out
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    lon += result & 1 ? ~(result >> 1) : result >> 1
    out.push([lat / 1e5, lon / 1e5])
  }
  return out
}

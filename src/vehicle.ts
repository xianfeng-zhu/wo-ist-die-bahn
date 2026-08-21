
export type Product = 'suburban' | 'subway' | 'tram'

export interface Vehicle {
  id: string
  line: string
  product: Product
  direction: string
  lat: number
  lon: number
  nextStop: string | null
  delayMs: number | null
  /** Next stop as animation target (coords + schedule segment duration ms). */
  segEnd?: {name: string; lat: number; lon: number; durationMs: number}
}

export const PRODUCT_BY_CLS: Record<number, Product> = {1: 'suburban', 2: 'subway', 4: 'tram'}

// Defensive second gate: HAFAS can classify non-S/U/tram services (e.g. the
// FEX airport express) under a rail cls bit, so also require the line name to
// match the product (S1..S85, U1..U12, trams M1-M17 or plain 2-digit numbers).
const LINE_PATTERNS: Record<Product, RegExp> = {
  suburban: /^S\d{1,2}$/,
  subway: /^U\d{1,2}$/,
  tram: /^M?\d{1,2}$/
}

export type Filters = Record<Product, boolean>

export function filterVehicles(vehicles: Vehicle[], filters: Filters): Vehicle[] {
  return vehicles.filter(v => filters[v.product])
}

export function productFromCls(cls: number | undefined): Product | null {
  return cls != null ? PRODUCT_BY_CLS[cls] ?? null : null
}

const toSec = (s: string): number => {
  const digits = s.replace(/:/g, '').padStart(6, '0')
  const h = Number(digits.slice(0, 2))
  const m = Number(digits.slice(2, 4))
  const sec = Number(digits.slice(4, 6))
  return h * 3600 + m * 60 + sec
}

export function delayFrom(stop: StopoverLike): number | null {
  for (const [r, s] of [['dTimeR', 'dTimeS'], ['aTimeR', 'aTimeS']] as const) {
    if (stop[r] && stop[s]) {
      let diff = (toSec(stop[r]) - toSec(stop[s])) / 60 * 60000
      if (diff > 12 * 3600 * 1000) diff -= 24 * 3600 * 1000
      if (diff < -12 * 3600 * 1000) diff += 24 * 3600 * 1000
      return Number.isFinite(diff) ? Math.round(diff) : null
    }
  }
  return null
}

export interface StopoverLike {
  locX?: number
  aTimeS?: string
  aTimeR?: string
  dTimeS?: string
  dTimeR?: string
}

interface Common {
  locs: Array<{name?: string; crd?: {x?: number; y?: number}}>
  prods: Array<{name?: string; cls?: number}>
}

export interface Journey {
  jid?: string
  date?: string
  prodX?: number
  dirTxt?: string
  pos?: {x?: number; y?: number} | null
  stopL?: StopoverLike[]
}

/**
 * Strict mode keeps only S/U/tram by cls AND line name (e.g. rejects FEX,
 * which HAFAS can classify under a rail cls bit). Test mode (`strictName:
 * false`) keeps every returned vehicle, inferring a display product from the
 * line name — used with `?all=1` to test animation on any running service.
 */
const INFER_PRODUCT: Record<string, Product> = {S: 'suburban', U: 'subway', T: 'tram'}

export function transformJourney(j: Journey, common: Common, nowTime: string, strictName = true): Vehicle | null {
  const prod = common.prods[j.prodX ?? -1]
  let product = productFromCls(prod?.cls)
  if (!product) {
    if (strictName) return null
    const head = (prod?.name ?? '').charAt(0)
    product = INFER_PRODUCT[head] ?? 'tram'
  }
  if (strictName && !LINE_PATTERNS[product].test(prod?.name ?? '')) return null // e.g. FEX
  if (!j.pos?.x || !j.pos?.y) return null
  const nowSec = toSec(nowTime)
  const stops = j.stopL ?? []
  const next = stops.find(s => {
    const t = s.aTimeS ?? s.dTimeS
    return !!t && toSec(t) >= nowSec
  }) ?? stops[1] ?? stops[0]
  const nextLoc = next ? common.locs[next.locX ?? -1] : undefined
  const cur = stops[0]
  const curTime = cur?.dTimeR ?? cur?.dTimeS ?? cur?.aTimeR ?? cur?.aTimeS
  const nextTime = next?.aTimeR ?? next?.aTimeS ?? next?.dTimeR ?? next?.dTimeS
  let segEnd: Vehicle['segEnd']
  if (nextLoc?.name && nextLoc.crd?.x != null && nextLoc.crd.y != null && nextTime && curTime) {
    // Schedule-derived segment duration (relative, immune to the operating-day
    // date lag); HAFAS absolute times can be ~24h stale for night services.
    let durationMs = (toSec(nextTime) - toSec(curTime)) * 1000
    if (durationMs < 0) durationMs += 24 * 3600 * 1000 // overnight wrap
    durationMs = Math.min(Math.max(durationMs, 10000), 30 * 60 * 1000)
    segEnd = {
      name: nextLoc.name,
      lat: nextLoc.crd.y / 1e6,
      lon: nextLoc.crd.x / 1e6,
      durationMs: Number.isFinite(durationMs) ? durationMs : 60000
    }
  }
  return {
    id: j.jid ?? 'unknown',
    line: prod?.name ?? product,
    product,
    direction: j.dirTxt ?? '',
    lat: j.pos.y / 1e6,
    lon: j.pos.x / 1e6,
    nextStop: next ? nextLoc?.name ?? null : null,
    delayMs: next ? delayFrom(next) : null,
    segEnd
  }
}

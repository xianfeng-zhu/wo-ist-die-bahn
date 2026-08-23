
export type Product = 'suburban' | 'subway' | 'tram'

/** A stop with coordinates and a time (HHMMSS, realtime preferred). */
export interface StopRef {
  name: string
  lat: number
  lon: number
  t: string
}

export interface Vehicle {
  id: string
  line: string
  product: Product
  direction: string
  lat: number
  lon: number
  nextStop: string | null
  delayMs: number | null
  /**
   * The journey's stopover summary as HAFAS returns it — ALWAYS 4 entries:
   * `[origin, previous stop, next stop, destination]`. These are NOT
   * consecutive stops: only [1] and [2] are adjacent, and [0]/[3] can be an
   * hour and half a city away. Never walk this as a chain — use
   * `fromStop`/`toStop`, which HAFAS states explicitly.
   */
  stops?: StopRef[]
  /** Stop the vehicle last left (HAFAS `ani.fLocX`). */
  fromStop?: StopRef
  /** Stop the vehicle is heading to — HAFAS's own declared target (`ani.tLocX`). */
  toStop?: StopRef
}

export const PRODUCT_BY_CLS: Record<number, Product> = {1: 'suburban', 2: 'subway', 4: 'tram'}

/**
 * Short, stable, unique label for a HAFAS journey id — readable off the map,
 * greppable in the payload. `1|105929|33|86|23082026` -> `105929-33`. Fields 1,
 * 4 and 5 are constant across a poll (type, unknown, date) and carry no
 * information; the journey ref alone is NOT unique (many vehicles share one),
 * so the variant field is required. Ids of another shape pass through.
 */
export function shortId(id: string): string {
  const p = id.split('|')
  return p.length >= 3 && p[1] && p[2] ? `${p[1]}-${p[2]}` : id
}

// Defensive second gate: HAFAS can classify non-S/U/tram services (e.g. the
// FEX airport express) under a rail cls bit, so also require the line name to
// match the product (S1..S85, U1..U12, trams M1-M17 or plain 2-digit numbers).
const LINE_PATTERNS: Record<Product, RegExp> = {
  suburban: /^S\d{1,2}$/,
  subway: /^U\d{1,2}$/,
  tram: /^M?\d{1,2}$/
}

export type Filters = Record<Product, boolean>

/** Product + optional line-name filter (empty/omitted lines = all). */
export function filterVehicles(vehicles: Vehicle[], filters: Filters, lines?: ReadonlySet<string>): Vehicle[] {
  return vehicles.filter(v => filters[v.product] && (!lines || lines.size === 0 || lines.has(v.line)))
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
  /**
   * HAFAS 30-second motion forecast. `fLocX`/`tLocX` are per-sample indexes
   * into `common.locL` for the stop just left and the stop being approached;
   * index 0 is "now". (`mSec`/`proc`/`polyG` also describe the forecast
   * positions, but its first point is just `pos` — see AGENTS.md.)
   */
  ani?: {fLocX?: number[]; tLocX?: number[]}
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
  const stopovers = j.stopL ?? []
  const next = stopovers.find(s => {
    const t = s.aTimeS ?? s.dTimeS
    return !!t && toSec(t) >= nowSec
  }) ?? stopovers[1] ?? stopovers[0]
  const nextLoc = next ? common.locs[next.locX ?? -1] : undefined
  // the 4-stopover summary, verbatim (see Vehicle.stops — NOT a chain)
  const stops: StopRef[] = []
  for (const s of stopovers.slice(0, 7)) {
    const loc = common.locs[s.locX ?? -1]
    const t = s.aTimeR ?? s.aTimeS ?? s.dTimeR ?? s.dTimeS
    if (loc?.name && loc.crd?.x != null && loc.crd.y != null && t) {
      stops.push({name: loc.name, lat: loc.crd.y / 1e6, lon: loc.crd.x / 1e6, t})
    }
  }
  // HAFAS states the segment the vehicle is on; never infer it geometrically
  const stopAt = (locX: number | undefined): StopRef | undefined => {
    if (locX == null) return undefined
    const loc = common.locs[locX]
    const so = stopovers.find(s => s.locX === locX)
    const t = so && (so.aTimeR ?? so.aTimeS ?? so.dTimeR ?? so.dTimeS)
    if (!loc?.name || loc.crd?.x == null || loc.crd.y == null || !t) return undefined
    return {name: loc.name, lat: loc.crd.y / 1e6, lon: loc.crd.x / 1e6, t}
  }
  return {
    fromStop: stopAt(j.ani?.fLocX?.[0]),
    toStop: stopAt(j.ani?.tLocX?.[0]),
    id: j.jid ?? 'unknown',
    line: prod?.name ?? product,
    product,
    direction: j.dirTxt ?? '',
    lat: j.pos.y / 1e6,
    lon: j.pos.x / 1e6,
    nextStop: next ? nextLoc?.name ?? null : null,
    delayMs: next ? delayFrom(next) : null,
    stops: stops.length >= 2 ? stops : undefined
  }
}

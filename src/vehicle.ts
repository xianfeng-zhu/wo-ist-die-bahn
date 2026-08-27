import {decodePolyline} from './polyline.js'

/**
 * Every mode the VBB radar returns. Measured against the live feed on
 * 2026-08-27 by asking for one product bit at a time (see AGENTS.md):
 *
 *   bit 0  cls 1   `S`      S-Bahn        16 lines
 *   bit 1  cls 2   `U`      U-Bahn         9 lines
 *   bit 2  cls 4   `Tram`   tram          27 lines
 *   bit 3  cls 8   `Bus`    bus          187 lines (also labelled `Kleinbus`)
 *   bit 4  cls 16  `Fähre`  ferry          1 line
 *   bit 5  cls 32  `ICE`/`IC`  long distance  3 trains
 *   bit 6  cls 64  `RE`/`RB`   regional      17 lines
 *
 * Bits 7-9 are accepted by the gate but return nothing in the Berlin box.
 */
export type Product = 'suburban' | 'subway' | 'tram' | 'bus' | 'ferry' | 'express' | 'regional'

/**
 * The operator's own short-term motion forecast for one vehicle: positions at
 * `ms[i]` milliseconds after the report instant. `pts[0]` is the reported
 * position, so `ms[0]` is 0. Measured shape today: 4 samples, 10 s apart.
 */
export interface Forecast {
  ms: number[]
  pts: Array<[number, number]>
}

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
  /** Operator forecast for the next ~30 s (`ani.mSec` + `ani.polyG`). */
  forecast?: Forecast
}

export const PRODUCT_BY_CLS: Record<number, Product> = {
  1: 'suburban', 2: 'subway', 4: 'tram', 8: 'bus', 16: 'ferry', 32: 'express', 64: 'regional'
}

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

/**
 * Defensive second gate for the three rail modes only.
 *
 * HAFAS can classify a non-S/U/tram service (the FEX airport express) under a
 * rail `cls` bit, so a rail product also has to look like a rail line name
 * (S1..S85, U1..U12, trams M1-M17 or a plain 2-digit number).
 *
 * The other four modes have NO name gate, and must not get one. Bus names are
 * `125`, `M29`, `X34`, `893`, `TXL`; long-distance names are train numbers
 * (`ICE 1130`). More to the point, a rail replacement bus is named after the
 * line it replaces — the live feed today has a BUS called `S9` and a BUS called
 * `U6` — so a name pattern would be actively wrong there. `cls` is the only
 * trustworthy source of the mode, and the gate above exists purely because one
 * service is known to arrive with the wrong bit.
 */
const LINE_PATTERNS: Partial<Record<Product, RegExp>> = {
  suburban: /^S\d{1,2}$/,
  subway: /^U\d{1,2}$/,
  tram: /^M?\d{1,2}$/
}

/**
 * Sort line names the way a person reads them: the number part in numeric order,
 * so U9 comes before U12 rather than after U1. Bare tram numbers (12, 21) sort
 * before the M-prefixed ones, which is the order the network itself uses.
 */
export function compareLineNames(a: string, b: string): number {
  const split = (s: string): [string, number] => {
    const m = /^(\D*)(\d*)/.exec(s)
    return [m?.[1] ?? '', m?.[2] ? Number(m[2]) : -1]
  }
  const [pa, na] = split(a)
  const [pb, nb] = split(b)
  return pa === pb ? na - nb : pa.localeCompare(pb)
}

export type Filters = Record<Product, boolean>

/** Something with a mode and a line name — a `Vehicle`, or a menu row. */
export interface LineRef {
  product: Product
  line: string
}

/**
 * Identify a line by MODE AND NAME, never by name alone.
 *
 * Names are not unique across modes. A rail replacement bus takes the name of
 * the line it replaces, so the live feed can hold a bus called `S9` beside the
 * real S-Bahn S9, and a bus called `U6` beside the U-Bahn U6. Keyed on the name
 * alone, one would hide the other in the menu and ticking either would show
 * both.
 */
export const lineKey = (v: LineRef): string => `${v.product}:${v.line}`

/**
 * Product filter, plus an optional line filter keyed by `lineKey`.
 *
 * Omit `lines` for "no line filter". An EMPTY set means nothing is selected, and
 * so matches nothing — it does not mean "all". That mirrors the product filter,
 * where clearing every type also empties the map, and it lets the UI's "All
 * lines" box tick and untick every line the way "All types" does.
 */
export function filterVehicles(vehicles: Vehicle[], filters: Filters, lines?: ReadonlySet<string>): Vehicle[] {
  return vehicles.filter(v => filters[v.product] && (!lines || lines.has(lineKey(v))))
}

/** One line seen running, with its mode, name and the time it was last seen. */
export interface LineSighting extends LineRef {
  seen: number
}

/**
 * Fold one poll into the table of lines running now, editing it in place. The
 * table is keyed by `lineKey`.
 *
 * A line stays in the table for `lingerMs` after its last sighting, so one poll
 * that misses a line's only vehicle does not remove it. Returns true when the
 * set of lines changed — the caller rebuilds its menus only then, so an open
 * menu does not redraw under the user's pointer.
 */
export function recordLineSightings(
  table: Map<string, LineSighting>,
  seen: Iterable<LineRef>,
  now: number,
  lingerMs: number
): boolean {
  let changed = false
  for (const v of seen) {
    if (!v.line) continue
    const key = lineKey(v)
    if (!table.has(key)) changed = true
    table.set(key, {product: v.product, line: v.line, seen: now})
  }
  for (const [key, e] of table) {
    if (now - e.seen <= lingerMs) continue
    table.delete(key)
    changed = true
  }
  return changed
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
  /** `common.polyL`; indexed by `ani.polyG.polyXL`. */
  polys?: Array<{crdEncYX?: string}>
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
  ani?: {
    fLocX?: number[]
    tLocX?: number[]
    mSec?: number[]
    polyG?: {polyXL?: number[]}
  }
}

export function transformJourney(j: Journey, common: Common, nowTime: string): Vehicle | null {
  const prod = common.prods[j.prodX ?? -1]
  // `cls` decides the mode, and nothing else does. An unmapped bit is dropped
  // rather than guessed: a wrong badge colour and a wrong menu entry are worse
  // than a missing vehicle, and every bit the gate returns is mapped today.
  const product = productFromCls(prod?.cls)
  if (!product) return null
  const namePattern = LINE_PATTERNS[product]
  if (namePattern && !namePattern.test(prod?.name ?? '')) return null // e.g. FEX under a rail bit
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
  // the operator's forecast: one polyline point per mSec sample
  let forecast: Forecast | undefined
  const enc = common.polys?.[j.ani?.polyG?.polyXL?.[0] ?? -1]?.crdEncYX
  const ms = j.ani?.mSec
  if (enc && ms && ms.length > 0) {
    const pts = decodePolyline(enc)
    const n = Math.min(pts.length, ms.length)
    if (n > 0) forecast = {ms: ms.slice(0, n), pts: pts.slice(0, n)}
  }
  return {
    fromStop: stopAt(j.ani?.fLocX?.[0]),
    toStop: stopAt(j.ani?.tLocX?.[0]),
    forecast,
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

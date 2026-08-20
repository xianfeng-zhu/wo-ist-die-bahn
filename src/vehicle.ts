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
}

export const PRODUCT_BY_CLS: Record<number, Product> = {1: 'suburban', 2: 'subway', 4: 'tram'}

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
  locs: Array<{name?: string}>
  prods: Array<{name?: string; cls?: number}>
}

export interface Journey {
  jid?: string
  prodX?: number
  dirTxt?: string
  pos?: {x?: number; y?: number} | null
  stopL?: StopoverLike[]
}

export function transformJourney(j: Journey, common: Common, nowTime: string): Vehicle | null {
  const prod = common.prods[j.prodX ?? -1]
  const product = productFromCls(prod?.cls)
  if (!product) return null
  if (!j.pos?.x || !j.pos?.y) return null
  const nowSec = toSec(nowTime)
  const stops = j.stopL ?? []
  const next = stops.find(s => {
    const t = s.aTimeS ?? s.dTimeS
    return !!t && toSec(t) >= nowSec
  }) ?? stops[1] ?? stops[0]
  return {
    id: j.jid ?? 'unknown',
    line: prod?.name ?? product,
    product,
    direction: j.dirTxt ?? '',
    lat: j.pos.y / 1e6,
    lon: j.pos.x / 1e6,
    nextStop: next ? common.locs[next.locX ?? -1]?.name ?? null : null,
    delayMs: next ? delayFrom(next) : null
  }
}

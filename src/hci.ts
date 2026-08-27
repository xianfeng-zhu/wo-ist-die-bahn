import {Journey, transformJourney, Vehicle} from './vehicle.js'

export const GATE_URL = 'https://fahrinfo.vbb.de/gate'

/** Every product bit the gate accepts: S=1, U=2, tram=4, bus=8, ferry=16, ICE/IC=32, RE/RB=64. */
export const ALL_PRODUCTS = 1023

/**
 * The gate returns at most this many journeys, whatever `maxJny` asks for.
 *
 * Measured 2026-08-27: asking for all products with `maxJny` 2000 and then 5000
 * returned exactly 1000 both times, against 1,134 vehicles counted by asking for
 * one product at a time. So a single request CANNOT show every mode in Berlin,
 * and the vehicles it drops are not ours to choose.
 */
export const JNY_CAP = 1000

/**
 * Product masks to request separately, then merge.
 *
 * Bus alone is about 675 vehicles and everything else about 460, so each group
 * stays clear of `JNY_CAP` while one combined request would lose ~130. Three
 * requests move the same bytes as one uncapped request would; only the request
 * count goes up. The last group is every remaining bit, so a mode VBB adds later
 * still arrives.
 */
export const PRODUCT_GROUPS = [7, 8, ALL_PRODUCTS - 7 - 8]

const RAIL_MASK = 7 // S=1, U=2, tram=4

export interface BBox {north: number; south: number; west: number; east: number}

const BERLIN_FMT = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

export function berlinDateTime(now: Date): {date: string; time: string} {
  const parts = BERLIN_FMT.formatToParts(now)
  const p: Record<string, string> = {}
  for (const part of parts) p[part.type] = part.value
  return {
    date: `${p.year}${p.month}${p.day}`,
    time: `${p.hour}${p.minute}${p.second}`
  }
}

export function buildRadarBody(bbox: BBox, date: string, time: string, maxJny: number, products: number = RAIL_MASK) {
  return {
    lang: 'de',
    svcReqL: [{
      meth: 'JourneyGeoPos',
      req: {
        maxJny,
        onlyRT: false,
        date,
        time,
        rect: {
          llCrd: {x: Math.round(bbox.west * 1e6), y: Math.round(bbox.south * 1e6)},
          urCrd: {x: Math.round(bbox.east * 1e6), y: Math.round(bbox.north * 1e6)}
        },
        perSize: 30000,
        perStep: 10000,
        ageOfReport: true,
        jnyFltrL: [{type: 'PROD', mode: 'INC', value: products}],
        trainPosMode: 'CALC'
      }
    }],
    client: {type: 'WEB', id: 'VBB', name: 'VBB WebApp', l: 'vs_webapp_vbb'},
    ver: '1.45',
    auth: {type: 'AID', aid: 'hafas-vbb-webapp'}
  }
}

// Minimal shape of the HCI response we consume (network JSON; validated by
// usage + unit tests). Cast is unchecked by design: the wire format is fixed
// by the HAFAS protocol and covered by parseRadar tests.
interface RadarResponse {
  svcResL?: Array<{
    err?: string
    res?: {
      common?: {
        locL?: Array<{name?: string; crd?: {x?: number; y?: number}}>
        prodL?: Array<{name?: string; cls?: number}>
        polyL?: Array<{crdEncYX?: string}>
      }
      jnyL?: Journey[]
    }
  }>
}

/** One radar response: the vehicles we keep, and how many journeys it held. */
export interface RadarPage {
  vehicles: Vehicle[]
  /** Raw journey count, BEFORE the product/name gates — compare against `JNY_CAP`. */
  journeys: number
}

export function parseRadarPage(json: unknown, nowTime: string): RadarPage {
  const svc = (json as RadarResponse).svcResL?.[0]
  if (!svc || svc.err !== 'OK') throw new Error(`HAFAS error: ${svc?.err ?? 'no svcResL'}`)
  const res = svc.res ?? {}
  const common = {
    locs: res.common?.locL ?? [],
    prods: res.common?.prodL ?? [],
    polys: res.common?.polyL ?? []
  }
  const journeys = res.jnyL ?? []
  return {
    journeys: journeys.length,
    vehicles: journeys
      .map((j: Journey) => transformJourney(j, common, nowTime))
      .filter((v: Vehicle | null): v is Vehicle => v !== null)
  }
}

export function parseRadar(json: unknown, nowTime: string): Vehicle[] {
  return parseRadarPage(json, nowTime).vehicles
}

/** One radar request for one product mask. */
export async function fetchVehiclePage(bbox: BBox, products: number, maxJny = 2000, signal?: AbortSignal): Promise<RadarPage> {
  const {date, time} = berlinDateTime(new Date())
  const res = await fetch(`${GATE_URL}?rnd=${Date.now()}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(buildRadarBody(bbox, date, time, maxJny, products)),
    signal
  })
  if (!res.ok) throw new Error(`HAFAS HTTP ${res.status}`)
  return parseRadarPage(await res.json(), time)
}

export async function fetchVehicles(bbox: BBox, maxJny = 2000, signal?: AbortSignal, products = RAIL_MASK): Promise<Vehicle[]> {
  return (await fetchVehiclePage(bbox, products, maxJny, signal)).vehicles
}

/** Everything running, from every mode, with the masks that came back capped. */
export interface RadarSweep {
  vehicles: Vehicle[]
  /** Product masks whose response hit `JNY_CAP`, so some vehicles are missing. */
  capped: number[]
}

/**
 * Fetch every mode, one request per product group, and merge.
 *
 * Runs the groups together rather than in sequence: they are independent, and
 * one slow group must not delay the rest of the poll. A group that fails takes
 * the whole poll with it, exactly as the single request did before — a partial
 * map that silently drops every bus is worse than a poll marked stale.
 */
export async function fetchAllVehicles(bbox: BBox, maxJny = 2000, signal?: AbortSignal): Promise<RadarSweep> {
  const pages = await Promise.all(PRODUCT_GROUPS.map(m => fetchVehiclePage(bbox, m, maxJny, signal)))
  // Dedupe by journey id: the groups do not overlap today, but a mask VBB
  // reassigns must not put the same vehicle on the map twice.
  const byId = new Map<string, Vehicle>()
  for (const p of pages) for (const v of p.vehicles) byId.set(v.id, v)
  return {
    vehicles: [...byId.values()],
    capped: PRODUCT_GROUPS.filter((_, i) => pages[i].journeys >= JNY_CAP)
  }
}

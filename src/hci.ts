import {Journey, transformJourney, Vehicle} from './vehicle.js'

export const GATE_URL = 'https://fahrinfo.vbb.de/gate'
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

export function buildRadarBody(bbox: BBox, date: string, time: string, maxJny: number) {
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
        jnyFltrL: [{type: 'PROD', mode: 'INC', value: RAIL_MASK}],
        trainPosMode: 'CALC'
      }
    }],
    client: {type: 'WEB', id: 'VBB', name: 'VBB WebApp', l: 'vs_webapp_vbb'},
    ver: '1.45',
    auth: {type: 'AID', aid: 'hafas-vbb-webapp'}
  }
}

export function parseRadar(json: any, nowTime: string): Vehicle[] {
  const svc = json?.svcResL?.[0]
  if (!svc || svc.err !== 'OK') throw new Error(`HAFAS error: ${svc?.err ?? 'no svcResL'}`)
  const res = svc.res ?? {}
  const common = {
    locs: res.common?.locL ?? [],
    prods: res.common?.prodL ?? []
  }
  return (res.jnyL ?? [])
    .map((j: Journey) => transformJourney(j, common, nowTime))
    .filter((v: Vehicle | null): v is Vehicle => v !== null)
}

export async function fetchVehicles(bbox: BBox, maxJny = 2000, signal?: AbortSignal): Promise<Vehicle[]> {
  const {date, time} = berlinDateTime(new Date())
  const res = await fetch(`${GATE_URL}?rnd=${Date.now()}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(buildRadarBody(bbox, date, time, maxJny)),
    signal
  })
  if (!res.ok) throw new Error(`HAFAS HTTP ${res.status}`)
  const json = await res.json()
  return parseRadar(json, time)
}

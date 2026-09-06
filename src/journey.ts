// The two on-demand lookups the detail panels need, and their parsers.
//
// The radar (`JourneyGeoPos`) is deliberately a bulk call: ~1,000 vehicles every
// 20 s, and it returns only 4 stopovers per journey. These two are the opposite —
// one request, for one thing a user just tapped:
//
//   JourneyDetails(jid)   -> the whole journey (measured: 31 stops with times,
//                            plus a route polyline, against the radar's 4)
//   StationBoard(extId)   -> a real departure board for one stop
//
// Both are parsed here into flat shapes the UI can render without knowing
// anything about HAFAS. Parsers are pure and never throw on wire data: a missing
// field drops that entry rather than the whole response.

import {decodePolyline} from './polyline.js'
import {timeToSeconds} from './format.js'
import {productFromCls, type Product} from './vehicle.js'

/** One stop on a journey, in order, with the time the vehicle is there. */
export interface JourneyStop {
  name: string
  /** HAFAS extId, so a stop on the strip can open its own departure board. */
  id: string | null
  lat: number
  lon: number
  /** Realtime where the feed has it, else scheduled. `HHMMSS`. */
  time: string | null
  /** Scheduled time, for showing a delay against `time`. */
  scheduled: string | null
  /** Seconds late, or null when the feed gives no realtime for this stop. */
  delaySec: number | null
  /** True once the vehicle has passed — set by `markProgress`, not by HAFAS. */
  passed: boolean
  /** HAFAS marks a stop it will not serve today. */
  cancelled: boolean
}

export interface JourneyDetail {
  /** Every stop, in travel order. */
  stops: JourneyStop[]
  /** The route as HAFAS draws it, `[lat, lon]`, empty when absent. */
  path: Array<[number, number]>
  direction: string | null
}

interface RawLoc {
  name?: string
  extId?: string
  crd?: {x?: number; y?: number}
}

/** Parse a `JourneyDetails` response. Returns null when there is no usable journey. */
export function parseJourneyDetail(json: unknown): JourneyDetail | null {
  const svc = (json as {svcResL?: Array<{err?: string; res?: unknown}>}).svcResL?.[0]
  if (!svc || svc.err !== 'OK') return null
  const res = svc.res as {
    journey?: {stopL?: RawStop[]; dirTxt?: string; polyG?: {polyXL?: number[]}}
    common?: {locL?: RawLoc[]; polyL?: Array<{crdEncYX?: string}>}
  } | undefined
  const jny = res?.journey
  if (!jny) return null
  const locs = res?.common?.locL ?? []
  const stops: JourneyStop[] = []
  for (const s of jny.stopL ?? []) {
    const loc = locs[s.locX ?? -1]
    if (!loc?.name || loc.crd?.x == null || loc.crd.y == null) continue
    // Arrival first: it is what a rider waiting at that stop cares about. The
    // first stop of a journey has only a departure, the last only an arrival.
    const rt = s.aTimeR ?? s.dTimeR ?? null
    const sched = s.aTimeS ?? s.dTimeS ?? null
    const rtSec = timeToSeconds(rt ?? undefined)
    const schedSec = timeToSeconds(sched ?? undefined)
    stops.push({
      name: loc.name,
      id: loc.extId ?? null,
      lat: loc.crd.y / 1e6,
      lon: loc.crd.x / 1e6,
      time: rt ?? sched,
      scheduled: sched,
      delaySec: rtSec != null && schedSec != null ? wrapDiff(rtSec - schedSec) : null,
      passed: false,
      cancelled: s.dCncl === true || s.aCncl === true
    })
  }
  const encoded = res?.common?.polyL?.[jny.polyG?.polyXL?.[0] ?? -1]?.crdEncYX
  return {
    stops,
    path: encoded ? decodePolyline(encoded) : [],
    direction: jny.dirTxt ?? null
  }
}

interface RawStop {
  locX?: number
  aTimeS?: string
  aTimeR?: string
  dTimeS?: string
  dTimeR?: string
  aCncl?: boolean
  dCncl?: boolean
}

/** Midnight-safe difference in seconds. */
const wrapDiff = (d: number): number =>
  d > 12 * 3600 ? d - 24 * 3600 : d < -12 * 3600 ? d + 24 * 3600 : d

/**
 * Mark which stops are behind the vehicle, and where it sits between two of them.
 *
 * `fromName`/`toName` are what HAFAS itself declares for the current segment
 * (`Vehicle.fromStop`/`toStop`) — never inferred geometrically. A name can repeat
 * on a journey (a line that loops through one stop twice), so the search starts
 * at `fromName` and takes the FIRST following `toName`.
 *
 * Returns the index of the stop being approached, or -1 when the segment cannot
 * be located — in which case nothing is marked, because a strip showing the wrong
 * half of the route as travelled is worse than one showing none of it.
 */
export function markProgress(stops: JourneyStop[], fromName?: string, toName?: string): number {
  for (const s of stops) s.passed = false
  if (!toName) return -1
  const start = fromName ? stops.findIndex(s => s.name === fromName) : -1
  const target = stops.findIndex((s, i) => s.name === toName && i > start)
  if (target === -1) return -1
  for (let i = 0; i < target; i++) stops[i].passed = true
  return target
}

/** One entry on a station's departure board. */
export interface Departure {
  /** HAFAS journey id, so tapping through can find the vehicle on the map. */
  jid: string
  line: string
  product: Product | null
  direction: string
  /** Realtime where the feed has it, else scheduled. `HHMMSS`. */
  time: string | null
  scheduled: string | null
  delaySec: number | null
  cancelled: boolean
  platform: string | null
  /** Journey-level notices for this departure (e.g. additional service). */
  notices?: StationNotice[]
}

/** Rough category for a HAFAS `remL` notice, decided from its code. */
export type NoticeKind =
  | 'information'
  | 'construction'
  | 'disruption'
  | 'elevator'
  | 'occupancy'
  | 'other'

export interface StationNotice {
  text: string
  kind: NoticeKind
}

/** A parsed departure board: the departures plus station-level notices. */
export interface StationBoardPage {
  departures: Departure[]
  /** Notices attached to the station rather than one particular journey. */
  notices: StationNotice[]
}

interface RawRem {
  code?: string
  txtN?: string
  txtL?: string
  txtS?: string
  type?: string
}

interface RawMsg {
  remX?: number
}

function classifyRem(rem: RawRem): NoticeKind {
  const code = (rem.code ?? '').toLowerCase()
  if (code.startsWith('text.occup')) return 'occupancy'
  if (code.includes('elevator') || code.includes('aufzug')) return 'elevator'
  if (code.includes('construction') || code.includes('baustelle') || code.includes('bauarbeiten')) return 'construction'
  if (code.includes('disruption') || code.includes('stoerung') || code.includes('störung')) return 'disruption'
  return 'information'
}

/**
 * A `remX` index into `common.remL`, as human text. Operator rows are dropped:
 * "S-Bahn Berlin GmbH" is metadata, not something a rider needs on a board.
 */
function noticeFromRem(remX: number | undefined, remL: RawRem[]): StationNotice | null {
  if (remX == null) return null
  const rem = remL[remX]
  if (!rem || rem.code === 'OPERATOR') return null
  const text = rem.txtN ?? rem.txtL ?? rem.txtS
  if (!text) return null
  return {text, kind: classifyRem(rem)}
}

function dedupeNotices(list: StationNotice[]): StationNotice[] {
  const seen = new Set<string>()
  const out: StationNotice[] = []
  for (const n of list) {
    const key = `${n.kind}:${n.text}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(n)
  }
  return out
}

/**
 * Parse a `StationBoard` response into departures and notices, earliest first.
 *
 * Cancelled departures are KEPT: "this one is not running" is the single most
 * useful thing a board can tell someone waiting for it.
 *
 * Notices come from `common.remL` via `remX` refs on `jnyL[].msgL` (journey
 * level) and `stbStop.msgL` (stop level). Occupancy is deliberately left out of
 * this round; it is a separate, richer feature.
 */
export function parseStationBoardPage(json: unknown): StationBoardPage {
  const svc = (json as {svcResL?: Array<{err?: string; res?: unknown}>}).svcResL?.[0]
  if (!svc || svc.err !== 'OK') return {departures: [], notices: []}
  const res = svc.res as {
    jnyL?: Array<{
      jid?: string
      prodX?: number
      dirTxt?: string
      isCncl?: boolean
      msgL?: RawMsg[]
      stbStop?: {
        dTimeS?: string; dTimeR?: string; aTimeS?: string; aTimeR?: string
        dPltfR?: {txt?: string}; dPltfS?: {txt?: string}; dCncl?: boolean
        msgL?: RawMsg[]
      }
    }>
    common?: {prodL?: Array<{name?: string; cls?: number}>; remL?: RawRem[]}
  } | undefined
  const prods = res?.common?.prodL ?? []
  const remL = res?.common?.remL ?? []
  const out: Departure[] = []
  const stationNotices: StationNotice[] = []
  for (const j of res?.jnyL ?? []) {
    if (!j.jid) continue
    const prod = prods[j.prodX ?? -1]
    const st = j.stbStop ?? {}
    const rt = st.dTimeR ?? st.aTimeR ?? null
    const sched = st.dTimeS ?? st.aTimeS ?? null
    if (!rt && !sched) continue
    const rtSec = timeToSeconds(rt ?? undefined)
    const schedSec = timeToSeconds(sched ?? undefined)
    const journeyNotices = dedupeNotices(
      (j.msgL ?? [])
        .map(m => noticeFromRem(m.remX, remL))
        .filter((n): n is StationNotice => n != null && n.kind !== 'occupancy')
    )
    const stopNotices = dedupeNotices(
      (st.msgL ?? [])
        .map(m => noticeFromRem(m.remX, remL))
        .filter((n): n is StationNotice => n != null && n.kind !== 'occupancy')
    )
    stationNotices.push(...stopNotices)
    out.push({
      jid: j.jid,
      line: (prod?.name ?? '').trim(),
      product: productFromCls(prod?.cls),
      direction: j.dirTxt ?? '',
      time: rt ?? sched,
      scheduled: sched,
      delaySec: rtSec != null && schedSec != null ? wrapDiff(rtSec - schedSec) : null,
      cancelled: j.isCncl === true || st.dCncl === true,
      platform: st.dPltfR?.txt ?? st.dPltfS?.txt ?? null,
      notices: journeyNotices.length > 0 ? journeyNotices : undefined
    })
  }
  out.sort((a, b) => (timeToSeconds(a.time ?? undefined) ?? 0) - (timeToSeconds(b.time ?? undefined) ?? 0))
  return {departures: out, notices: dedupeNotices(stationNotices)}
}

/** Departure-only view of a board, for callers that do not need notices. */
export function parseStationBoard(json: unknown): Departure[] {
  return parseStationBoardPage(json).departures
}

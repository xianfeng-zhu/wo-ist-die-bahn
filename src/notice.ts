// HAFAS reminder (`remL`) text, shared by the station board and the radar.
//
// Both endpoints carry the same shape — `common.remL[]` indexed by `remX` from
// `jnyL[].msgL[]` (and `stbStop.msgL[]` on a board) — so one classifier serves
// them. Occupancy is classified here but filtered by callers: this round has no
// occupancy UI, and the code that switches it on later should not touch wire
// handling again.

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

/** The kinds a rider should hear about without asking: work, faults, delays. */
export const IMPORTANT_NOTICE_KINDS: ReadonlySet<NoticeKind> = new Set([
  'construction',
  'disruption',
  'elevator'
])

export interface RawRem {
  code?: string
  txtN?: string
  txtL?: string
  txtS?: string
  type?: string
}

export interface RawMsg {
  remX?: number
}

export function classifyRem(rem: RawRem): NoticeKind {
  const code = (rem.code ?? '').toLowerCase()
  if (code.startsWith('text.occup')) return 'occupancy'
  if (code.includes('elevator') || code.includes('aufzug')) return 'elevator'
  if (code.includes('construction') || code.includes('baustelle') || code.includes('bauarbeiten')) return 'construction'
  if (code.includes('disruption') || code.includes('stoerung') || code.includes('störung')) return 'disruption'
  return 'information'
}

/**
 * A `remX` index into `common.remL`, as human text. Operator rows are dropped:
 * "S-Bahn Berlin GmbH" is metadata, not something a rider needs to read.
 */
export function noticeFromRem(remX: number | undefined, remL: RawRem[]): StationNotice | null {
  if (remX == null) return null
  const rem = remL[remX]
  if (!rem || rem.code === 'OPERATOR') return null
  const text = rem.txtN ?? rem.txtL ?? rem.txtS
  if (!text) return null
  return {text, kind: classifyRem(rem)}
}

export function dedupeNotices(list: StationNotice[]): StationNotice[] {
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

/** Parse a journey's `msgL` refs. `keep` lets a caller exclude a category. */
export function noticesFromMsgL(
  msgL: RawMsg[] | undefined,
  remL: RawRem[],
  drop: ReadonlySet<NoticeKind> = new Set()
): StationNotice[] {
  return dedupeNotices(
    (msgL ?? [])
      .map(m => noticeFromRem(m.remX, remL))
      .filter((n): n is StationNotice => n != null && !drop.has(n.kind))
  )
}

/** One running line with the notices its vehicles currently carry. */
export interface LineNoticeAgg {
  key: string
  line: string
  product: string
  notices: StationNotice[]
}

/**
 * Fold per-vehicle notices into per-line notices, deduplicated across the
 * vehicles of a line: a construction text on every S7 vehicle is one alert.
 */
export function aggregateLineNotices(
  seen: Iterable<{line?: string; product?: string; notices?: StationNotice[]}>
): Map<string, LineNoticeAgg> {
  const out = new Map<string, LineNoticeAgg>()
  for (const v of seen) {
    if (!v.line || !v.product || !v.notices || v.notices.length === 0) continue
    const key = `${v.product}:${v.line}`
    let agg = out.get(key)
    if (!agg) {
      agg = {key, line: v.line, product: v.product, notices: []}
      out.set(key, agg)
    }
    for (const n of v.notices) {
      if (agg.notices.some(x => x.kind === n.kind && x.text === n.text)) continue
      agg.notices.push(n)
    }
  }
  return out
}

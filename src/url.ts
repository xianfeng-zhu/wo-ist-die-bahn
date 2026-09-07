// Encode and decode the shareable map state: which modes and lines are selected,
// and where the camera is. Kept pure so a URL can be built and read without the
// map or DOM, and so the format is covered by unit tests.

import type {Filters} from './vehicle.js'

export type ProductKey = keyof Filters

export interface ViewState {
  types: ProductKey[]
  lineMode: 'all' | 'custom'
  /** `lineKey` values (`product:line`); meaningful only when `lineMode` is custom. */
  lines: string[]
  center: [number, number] | null
  zoom: number | null
}

const PRODUCT_KEYS: ProductKey[] = ['suburban', 'subway', 'tram', 'bus', 'ferry', 'express', 'regional']

/**
 * Turn a view state into query parameters. Types are always written, even when
 * they are the rail-only default, so a shared link reproduces the exact view.
 */
export function encodeViewState(state: ViewState): string {
  const p = new URLSearchParams()
  p.set('types', state.types.join(','))
  if (state.lineMode === 'custom' && state.lines.length > 0) p.set('lines', state.lines.join(','))
  if (state.center) p.set('center', `${state.center[0]},${state.center[1]}`)
  if (state.zoom != null) p.set('zoom', String(state.zoom))
  return p.toString()
}

/**
 * Read view parameters out of a query string. Absent parameters stay absent so
 * the caller can keep its defaults; invalid values are ignored rather than
 * applied.
 */
export function decodeViewState(search: string): Partial<ViewState> {
  const q = new URLSearchParams(search)
  const out: Partial<ViewState> = {}
  if (q.has('types')) {
    const wanted = new Set((q.get('types') ?? '').split(',').filter(Boolean))
    out.types = PRODUCT_KEYS.filter(k => wanted.has(k))
  }
  if (q.has('lines')) {
    out.lineMode = 'custom'
    out.lines = (q.get('lines') ?? '').split(',').filter(Boolean)
  }
  if (q.has('center')) {
    const c = (q.get('center') ?? '').split(',').map(Number)
    if (c.length === 2 && c.every(n => Number.isFinite(n)) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90) {
      out.center = [c[0], c[1]]
    }
  }
  if (q.has('zoom')) {
    const zoom = Number(q.get('zoom'))
    if (Number.isFinite(zoom) && zoom >= 0 && zoom <= 19) out.zoom = zoom
  }
  return out
}

/**
 * The shareable form of a not-yet-departed service: the journey id, the display
 * metadata the header needs before the fetch answers, and the stop whose board
 * the rider came from (`at`), so the schedule can be re-opened after a reload
 * with the same "this is my stop" marking.
 */
export interface JourneyLinkState {
  id: string
  line: string
  product: ProductKey | null
  direction: string
  stopId: string | null
  stopName: string | null
}

export function encodeJourneyState(s: JourneyLinkState): string {
  const p = new URLSearchParams()
  p.set('journey', s.id)
  if (s.product) p.set('p', s.product)
  if (s.line) p.set('line', s.line)
  if (s.direction) p.set('dir', s.direction)
  if (s.stopId) p.set('at', s.stopId)
  if (s.stopName) p.set('atName', s.stopName)
  return p.toString()
}

/** Read the journey parameters out of a query string; null when absent. */
export function decodeJourneyState(search: string): Partial<JourneyLinkState> | null {
  const q = new URLSearchParams(search)
  const id = q.get('journey')
  if (!id) return null
  const out: Partial<JourneyLinkState> = {id}
  const product = q.get('p')
  if (product && (PRODUCT_KEYS as string[]).includes(product)) {
    out.product = product as ProductKey
  }
  if (q.get('line')) out.line = q.get('line')!
  if (q.get('dir')) out.direction = q.get('dir')!
  if (q.get('at')) out.stopId = q.get('at')!
  if (q.get('atName')) out.stopName = q.get('atName')!
  return out
}

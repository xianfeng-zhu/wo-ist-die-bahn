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

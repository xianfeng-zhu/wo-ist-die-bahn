// Remember the type/line selection across visits, like the map view already is.
//
// Kept pure (a JSON string in, a validated object out) so the format is covered
// by unit tests. The caller owns the storage and the moment it is read: boot
// applies prefs BEFORE the URL view state, and a shared-link parameter
// overrides whatever was saved.

import type {Filters} from './vehicle.js'

export interface FilterPrefs {
  types: Array<keyof Filters>
  lineMode: 'all' | 'custom'
  lines: string[]
}

const PRODUCT_KEYS: Array<keyof Filters> = ['suburban', 'subway', 'tram', 'bus', 'ferry', 'express', 'regional']

export function encodeFilterPrefs(p: FilterPrefs): string {
  return JSON.stringify({types: p.types, lineMode: p.lineMode, lines: p.lines})
}

/**
 * Read and validate saved prefs. Anything that does not parse or is not the
 * right shape is treated as absent — a corrupted value must not silently wipe
 * the map's defaults.
 */
export function decodeFilterPrefs(raw: string | null): FilterPrefs | null {
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const o = value as {types?: unknown; lineMode?: unknown; lines?: unknown}
  const types = Array.isArray(o.types)
    ? o.types.filter((x): x is keyof Filters => typeof x === 'string' && (PRODUCT_KEYS as string[]).includes(x))
    : null
  const lineMode = o.lineMode === 'all' || o.lineMode === 'custom' ? o.lineMode : null
  const lines = Array.isArray(o.lines) ? o.lines.filter((x): x is string => typeof x === 'string') : null
  if (!types || !lineMode || !lines) return null
  return {types, lineMode, lines}
}

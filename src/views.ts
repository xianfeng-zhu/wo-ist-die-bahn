// The contents of the detail panel: a vehicle's journey, and a stop's departures.
//
// These build DOM from data and nothing else — no map, no fetching, no globals —
// so the panel can be re-rendered from a fresh poll without the caller
// untangling what changed.

import {clockTime, delayLabel, etaLabel, minutesUntil} from './format.js'
import type {Departure, JourneyDetail} from './journey.js'
import type {Product, Vehicle} from './vehicle.js'

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

/** A short message body — loading, empty, failed. */
export function noticeBody(text: string, kind: 'loading' | 'empty' | 'error' = 'empty'): HTMLElement {
  const wrap = el('div', `notice notice-${kind}`)
  wrap.append(el('p', undefined, text))
  return wrap
}

export interface VehicleView {
  body: HTMLElement
  /** Scroll the panel so the vehicle's place on the strip is on screen. */
  scrollToVehicle(): void
  /**
   * Move the marker on the strip.
   *
   * `progress` is how far the vehicle is between the stop it left and the stop it
   * is approaching, 0..1 — the same fraction the map uses, so the strip and the
   * map agree about where the vehicle is.
   */
  setProgress(progress: number): void
}

/**
 * A vehicle's journey as a vertical strip.
 *
 * Stops are spaced EVENLY, like a metro diagram, not by real distance: on a
 * regional line a couple of long gaps would compress every city stop into an
 * unreadable cluster. The moving marker still sits between two dots in the same
 * proportion as the vehicle sits between them on the map, which is the part that
 * has to line up.
 */
export function vehicleView(
  v: Vehicle,
  detail: JourneyDetail | null,
  targetIndex: number,
  opts: {onStop?: (stopId: string, name: string) => void} = {}
): VehicleView {
  const body = el('div', 'vdetail')

  const delay = delayLabel(v.delayMs)
  if (delay) {
    const late = (v.delayMs ?? 0) > 0
    body.append(el('p', `vdelay ${late ? 'is-late' : 'is-early'}`, `${late ? 'running late' : 'running early'} · ${delay}`))
  }

  if (!detail || detail.stops.length === 0) {
    body.append(noticeBody('The full route for this vehicle is not available.', 'empty'))
    body.append(estimateNote())
    return {body, setProgress: () => {}, scrollToVehicle: () => {}}
  }

  const strip = el('ol', 'strip')
  const rows: HTMLElement[] = []
  detail.stops.forEach((stop, i) => {
    const row = el('li', 'strip-row')
    if (stop.passed) row.classList.add('is-passed')
    if (i === targetIndex) row.classList.add('is-next')
    if (stop.cancelled) row.classList.add('is-cancelled')

    const time = el('span', 'strip-time', clockTime(stop.time ?? undefined))
    const d = stop.delaySec
    if (d != null && Math.abs(d) >= 60) {
      time.append(el('em', 'strip-delay', d > 0 ? `+${Math.round(d / 60)}` : `${Math.round(d / 60)}`))
    }
    const dot = el('span', 'strip-dot')
    dot.setAttribute('aria-hidden', 'true')
    const name = el('span', 'strip-name', stop.name)

    row.append(time, dot, name)
    // A stop on the strip is a way into that stop's own departures.
    if (stop.id && opts.onStop) {
      const id = stop.id
      row.classList.add('is-tappable')
      row.tabIndex = 0
      row.setAttribute('role', 'button')
      row.setAttribute('aria-label', `${stop.name}, departures`)
      const go = () => opts.onStop?.(id, stop.name)
      row.onclick = go
      row.onkeydown = e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go() }
      }
    }
    rows.push(row)
    strip.append(row)
  })

  // The vehicle itself, floating over the dot column between two stops.
  const marker = el('span', 'strip-vehicle')
  marker.setAttribute('aria-hidden', 'true')
  const wrap = el('div', 'strip-wrap')
  wrap.append(strip, marker)
  body.append(wrap)
  body.append(estimateNote())

  const setProgress = (progress: number): void => {
    if (targetIndex < 0 || rows.length === 0) {
      marker.hidden = true
      return
    }
    const to = rows[Math.min(targetIndex, rows.length - 1)]
    const from = rows[Math.max(0, targetIndex - 1)]
    const centre = (r: HTMLElement): number => r.offsetTop + r.offsetHeight / 2
    const a = centre(from)
    const b = centre(to)
    const p = Math.max(0, Math.min(1, progress))
    marker.hidden = false
    marker.style.top = `${a + (b - a) * p}px`
  }
  // Lay out once the rows have real heights.
  requestAnimationFrame(() => setProgress(0))

  /**
   * Bring the vehicle into view.
   *
   * A journey can be 31 stops, and the interesting one is wherever the vehicle
   * is — often the far end. Opening at the top of the list means every reader
   * scrolls to find it first. Aim a little above centre, so more of what is still
   * to come is on screen than what is done with.
   */
  const scrollToVehicle = (): void => {
    if (targetIndex < 0 || rows.length === 0) return
    const row = rows[Math.min(targetIndex, rows.length - 1)]
    const box = body.parentElement
    if (!box) return
    box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight * 0.4)
  }
  return {body, setProgress, scrollToVehicle}
}

/** The same honesty the map popup carries: this position is modelled. */
function estimateNote(): HTMLElement {
  return el('p', 'est-note', 'Times and position come from the timetable plus the live delay, not from GPS.')
}

/**
 * A stop's departure board, grouped by mode.
 *
 * Cancelled departures stay on the board and are marked, because "this one is not
 * running" is what someone waiting for it needs to know. Departures already gone
 * are dropped — a board is about what is still to come.
 */
export function stationView(
  departures: Departure[],
  nowSec: number,
  opts: {
    labels: Record<Product, string>
    colourFor: (d: Departure) => string
    textFor: (bg: string) => string
    onPick?: (d: Departure) => void
  }
): HTMLElement {
  const body = el('div', 'sdetail')
  const upcoming = departures.filter(d => (minutesUntil(d.time ?? undefined, nowSec) ?? -1) >= 0)
  if (upcoming.length === 0) {
    body.append(noticeBody('Nothing due here in the next hour.', 'empty'))
    return body
  }

  // Group by mode, keeping each group in time order.
  const byMode = new Map<Product | 'other', Departure[]>()
  for (const d of upcoming) {
    const key = d.product ?? 'other'
    const list = byMode.get(key)
    if (list) list.push(d)
    else byMode.set(key, [d])
  }
  const order = Object.keys(opts.labels) as Product[]
  const keys = [...byMode.keys()].sort((a, b) => {
    const ia = a === 'other' ? 99 : order.indexOf(a)
    const ib = b === 'other' ? 99 : order.indexOf(b)
    return ia - ib
  })

  for (const key of keys) {
    body.append(el('h3', 'sgroup', key === 'other' ? 'Other' : opts.labels[key]))
    const list = el('ul', 'deps')
    for (const d of byMode.get(key)!) {
      const row = el('li', 'dep')
      if (d.cancelled) row.classList.add('is-cancelled')

      const bg = opts.colourFor(d)
      const badge = el('span', 'dep-line', d.line)
      badge.style.background = bg
      badge.style.color = opts.textFor(bg)

      const where = el('span', 'dep-dir', d.direction || '—')
      const mins = minutesUntil(d.time ?? undefined, nowSec)
      const when = el('span', 'dep-eta', d.cancelled ? 'cancelled' : etaLabel(mins))
      const at = el('span', 'dep-at', clockTime(d.time ?? undefined))
      if (d.delaySec != null && Math.abs(d.delaySec) >= 60) {
        at.append(el('em', 'strip-delay', d.delaySec > 0 ? `+${Math.round(d.delaySec / 60)}` : `${Math.round(d.delaySec / 60)}`))
      }
      if (d.platform) where.append(el('span', 'dep-pltf', ` · ${d.platform}`))

      row.append(badge, where, at, when)
      if (opts.onPick && !d.cancelled) {
        row.classList.add('is-tappable')
        row.tabIndex = 0
        row.setAttribute('role', 'button')
        row.setAttribute('aria-label', `${d.line} to ${d.direction}, ${etaLabel(mins)}`)
        const go = () => opts.onPick?.(d)
        row.onclick = go
        row.onkeydown = e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go() }
        }
      }
      list.append(row)
    }
    body.append(list)
  }
  return body
}

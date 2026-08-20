import L from 'leaflet'

// Google-Maps-style wheel zoom for Leaflet, built on the common practice of
// the major web-map engines:
// - MapLibre GL JS `ScrollZoomHandler` (Apache-2.0): input-type detection
//   (trackpad vs discrete wheel), per-type zoom rates, sigmoid-compressed
//   scale cap. https://github.com/maplibre/maplibre-gl-js
// - OpenLayers `MouseWheelZoom`: DOM_DELTA_LINE/PAGE multipliers, per-event
//   fractional trackpad zoom.
// - Leaflet `ScrollWheelZoomHandler`: disabled here (see below).
//
// Divergence from OSS practice, per explicit requirement: **zoom fling**.
// MapLibre explicitly returns `noInertia: true` for scroll zoom, OpenLayers
// has no zoom inertia, and Leaflet's inertia covers panning only — zoom
// inertia exists nowhere in the OSS ecosystem. The decaying-velocity glide
// after the gesture ends is a Google Maps signature; this adds it.
//
// Design note: everything is synchronous per wheel event plus two bounded,
// self-clearing setTimeout timers (MapLibre's 40ms first-event disambiguation
// and the fling glide) — no requestAnimationFrame loop. A dead rAF loop
// previously left the map frozen and blank; a bounded timer chain can only
// stop early, never wedge.
//
// Leaflet's built-in handler is disabled (`scrollWheelZoom: false`): it
// compresses a whole gesture through a sigmoid that soft-caps at ~4 zoom
// levels and animates every step (~250ms), which feels slow.

const WHEEL_DELTA_STEP = 4.000244140625 // MapLibre: unit of one mouse-wheel notch
const TRACKPAD_ZOOM_RATE = 1 / 100 // MapLibre defaultZoomRate (100px per zoom level)
const WHEEL_ZOOM_RATE = 1 / 450 // MapLibre wheelZoomRate
const MAX_SCALE_PER_EVENT = 2 // MapLibre maxScalePerFrame (~1 zoom level per event)
const LINE_DELTA_MULTIPLIER = 40 // OpenLayers / MapLibre DOM_DELTA_LINE
const PAGE_DELTA_MULTIPLIER = 300 // OpenLayers DOM_DELTA_PAGE

// fling (inertia) tuning
const FLING_DETECT_MS = 60 // input gap after which the fling glide starts
const GLIDE_STEP_MS = 16
const GLIDE_DECAY_MS = 150 // exponential velocity decay constant
const GLIDE_MAX_MS = 600 // hard cap so the glide always terminates
const GLIDE_MIN_VELOCITY = 0.0002 // zoom/ms; stop gliding below this
// a gesture only ends after this quiet period without input (matches the
// 400ms new-gesture threshold), or shortly after the fling glide finishes —
// a premature end mid-scroll would re-enable per-step tile wipes
const GESTURE_END_MS = 400
const GLIDE_END_CONFIRM_MS = 100

export type WheelType = 'wheel' | 'trackpad' | null

/** Normalize a wheel event's delta to pixels (OL/MapLibre convention). */
export function normalizeDelta(e: Pick<WheelEvent, 'deltaMode' | 'deltaY'>): number {
  // spec-stable: DOM_DELTA_PIXEL=0, DOM_DELTA_LINE=1, DOM_DELTA_PAGE=2
  if (e.deltaMode === 1) return e.deltaY * LINE_DELTA_MULTIPLIER
  if (e.deltaMode === 2) return e.deltaY * PAGE_DELTA_MULTIPLIER
  return e.deltaY
}

/**
 * MapLibre wheel-event type detection (scroll_zoom.ts `wheel()`):
 * tiny deltas are trackpads, quantized notches are mouse wheels, a long gap
 * starts a new gesture, and an ambiguous repeating event is inferred from the
 * delta × time product. `prev` is kept once known.
 */
export function classifyWheel(prev: WheelType, value: number, timeDelta: number): WheelType {
  if (value !== 0 && Math.abs(value) < 4) return 'trackpad'
  if (value !== 0 && value % WHEEL_DELTA_STEP === 0) return 'wheel'
  if (timeDelta > 400) return null // likely a new scroll action
  if (!prev) return Math.abs(timeDelta * value) < 200 ? 'trackpad' : 'wheel'
  return prev
}

export interface WheelZoomOptions {
  /** Fired when a new scroll gesture starts (first event after a pause). */
  onGestureStart?: () => void
  /** Fired when the gesture fully ends (after the fling glide, if any). */
  onGestureEnd?: () => void
}

/**
 * Replace the map's wheel zoom with Google-Maps-style behavior: 1:1 trackpad
 * tracking at the cursor, per-event scale cap, and a fling glide after the
 * gesture ends (decaying velocity, like Google Maps). Shift = precision zoom;
 * Ctrl (browser pinch-zoom) passes through untouched. Returns a disposer.
 */
export function enableSmoothWheelZoom(map: L.Map, opts: WheelZoomOptions = {}): () => void {
  const container = map.getContainer()

  let type: WheelType = null
  let lastWheelTime = 0
  let lastEventTime = 0
  let lastValue = 0 // pending ambiguous first event of a gesture
  let velocity = 0 // smoothed zoom/ms for the fling
  let glideTimer: ReturnType<typeof setTimeout> | null = null
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let endTimer: ReturnType<typeof setTimeout> | null = null
  let lastAnchor = map.latLngToContainerPoint(map.getCenter())
  let gestureActive = false

  const endGesture = (): void => {
    if (endTimer !== null) {
      clearTimeout(endTimer)
      endTimer = null
    }
    if (gestureActive) {
      gestureActive = false
      opts.onGestureEnd?.()
    }
  }

  /** End the gesture after a quiet period; any new input cancels it. */
  const scheduleEnd = (delay: number): void => {
    if (endTimer !== null) clearTimeout(endTimer)
    endTimer = setTimeout(() => {
      endTimer = null
      endGesture()
    }, delay)
  }

  const applyZoom = (dZoom: number): void => {
    const zoom = map.getZoom() + dZoom
    if (!Number.isFinite(zoom)) return
    map.setZoomAround(lastAnchor, zoom, {animate: false})
  }

  const startGlide = (): void => {
    if (Math.abs(velocity) < GLIDE_MIN_VELOCITY) {
      // no fling: confirm the gesture really ended with a quiet period
      scheduleEnd(GESTURE_END_MS)
      return
    }
    const start = performance.now()
    const step = (): void => {
      const t = performance.now() - start
      const v = velocity * Math.exp(-t / GLIDE_DECAY_MS)
      if (Math.abs(v) < GLIDE_MIN_VELOCITY || t >= GLIDE_MAX_MS) {
        scheduleEnd(GLIDE_END_CONFIRM_MS)
        return
      }
      applyZoom(v * GLIDE_STEP_MS)
      glideTimer = setTimeout(step, GLIDE_STEP_MS)
    }
    glideTimer = setTimeout(step, GLIDE_STEP_MS)
  }

  /** Apply one scroll step: sigmoid-capped fractional zoom + velocity update. */
  const applyGesture = (value: number): void => {
    const rate = type === 'wheel' ? WHEEL_ZOOM_RATE : TRACKPAD_ZOOM_RATE
    let scale = MAX_SCALE_PER_EVENT / (1 + Math.exp(-Math.abs(value * rate)))
    if (value > 0 && scale !== 0) scale = 1 / scale // scroll down = zoom out
    const step = Math.log2(scale)

    const prevZoom = map.getZoom()
    applyZoom(step)
    const now = performance.now()
    const dt = Math.max(now - lastEventTime, 1)
    velocity = velocity * 0.5 + ((map.getZoom() - prevZoom) / dt) * 0.5 // EMA
    lastEventTime = now

    // if no more input arrives within FLING_DETECT_MS, glide with the
    // remaining velocity (fling / inertia); new input cancels the end timer
    if (glideTimer !== null) clearTimeout(glideTimer)
    if (endTimer !== null) clearTimeout(endTimer)
    glideTimer = setTimeout(startGlide, FLING_DETECT_MS)
  }

  const onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey) return // leave browser pinch-zoom to the browser
    e.preventDefault()
    let value = normalizeDelta(e)
    if (value === 0) return
    if (e.shiftKey) value /= 4 // precision zoom while holding shift
    const now = performance.now()
    const timeDelta = now - lastWheelTime
    lastWheelTime = now
    lastAnchor = map.mouseEventToContainerPoint(e)

    if (timeDelta > 400) {
      // new gesture: unambiguous values classify directly; ambiguous ones
      // wait 40ms for a repeat (trackpad stream) else resolve as a single
      // wheel notch (MapLibre `_onTimeout`)
      gestureActive = true
      opts.onGestureStart?.()
      const first = classifyWheel(null, value, timeDelta)
      if (first !== null) {
        type = first
        applyGesture(value)
      } else {
        type = null
        lastValue = value
        if (pendingTimer !== null) clearTimeout(pendingTimer)
        pendingTimer = setTimeout(() => {
          pendingTimer = null
          if (type === null) {
            type = 'wheel'
            applyGesture(lastValue)
          }
        }, 40)
      }
      return
    }

    if (type === null && pendingTimer !== null) {
      // the ambiguous first event repeats: it is a trackpad stream
      clearTimeout(pendingTimer)
      pendingTimer = null
      value += lastValue
      type = classifyWheel(null, value, timeDelta) ?? 'trackpad'
    } else {
      const next = classifyWheel(type, value, timeDelta)
      if (next !== null) type = next
    }
    if (type === null) return
    applyGesture(value)
  }

  container.addEventListener('wheel', onWheel, {passive: false})

  return () => {
    container.removeEventListener('wheel', onWheel)
    if (glideTimer !== null) clearTimeout(glideTimer)
    if (pendingTimer !== null) clearTimeout(pendingTimer)
    if (endTimer !== null) clearTimeout(endTimer)
    endGesture()
  }
}

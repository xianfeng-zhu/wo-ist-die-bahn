import L from 'leaflet'

// Continuous, fast wheel zoom, ported from the common practice of the major
// web-map engines:
// - MapLibre GL JS `ScrollZoomHandler` (Apache-2.0): type detection, per-type
//   zoom rates, sigmoid-compressed per-frame cap, 200ms ease-out for discrete
//   wheel notches. https://github.com/maplibre/maplibre-gl-js
// - OpenLayers `MouseWheelZoom`: DOM_DELTA_LINE/PAGE multipliers.
//
// Leaflet's built-in handler is disabled (`scrollWheelZoom: false`): it
// compresses a whole gesture through a sigmoid that soft-caps at ~4 zoom
// levels and animates every step (~250ms), which feels slow.

const WHEEL_DELTA_STEP = 4.000244140625 // MapLibre: unit of one mouse-wheel notch
const TRACKPAD_ZOOM_RATE = 1 / 100 // MapLibre defaultZoomRate
const WHEEL_ZOOM_RATE = 1 / 450 // MapLibre wheelZoomRate
const MAX_SCALE_PER_FRAME = 2 // MapLibre maxScalePerFrame (~1 zoom level per frame)
const EASE_MS = 200 // MapLibre _smoothOutEasing(200)
const LINE_DELTA_MULTIPLIER = 40 // OpenLayers / MapLibre DOM_DELTA_LINE
const PAGE_DELTA_MULTIPLIER = 300 // OpenLayers DOM_DELTA_PAGE

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

// cubic ease-out, close to MapLibre's bezier(0, 0, 0.15, 1)
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3)

/**
 * Replace the map's wheel zoom with a continuous, responsive implementation:
 * accumulate deltas, consume once per render frame with a per-frame scale cap
 * (no runaway), ease discrete wheel notches over 200ms, trackpads follow the
 * input directly (fractional zoom). Shift = precision zoom. Ctrl (browser
 * pinch-zoom) passes through untouched. Zoom is anchored at the cursor.
 * Returns a disposer.
 */
export function enableSmoothWheelZoom(map: L.Map): () => void {
  const container = map.getContainer()

  let type: WheelType = null
  let lastWheelTime = 0
  let lastValue = 0
  let delta = 0
  let startZoom = map.getZoom()
  let targetZoom = map.getZoom()
  let animStart = 0
  let needsFrame = false
  let raf: number | null = null
  let gestureTimeout: number | null = null
  let anchor = map.latLngToContainerPoint(map.getCenter()) // L.Point, cursor fallback

  const scheduleFrame = (): void => {
    if (!needsFrame) {
      needsFrame = true
      raf = requestAnimationFrame(renderFrame)
    }
  }

  const renderFrame = (now: number): void => {
    raf = null
    if (!needsFrame) return
    needsFrame = false

    if (delta !== 0) {
      // consume the accumulated delta once per frame; the sigmoid compresses
      // bursts so a fast scroll can't move more than ~1 level per frame
      const rate = type === 'wheel' && Math.abs(delta) > WHEEL_DELTA_STEP
        ? WHEEL_ZOOM_RATE
        : TRACKPAD_ZOOM_RATE
      let scale = MAX_SCALE_PER_FRAME / (1 + Math.exp(-Math.abs(delta * rate)))
      if (delta < 0 && scale !== 0) scale = 1 / scale
      startZoom = map.getZoom()
      targetZoom = startZoom + Math.log2(scale)
      if (type === 'wheel') animStart = now
      delta = 0
    }

    let zoom: number
    if (type === 'wheel') {
      const t = Math.min((now - animStart + 5) / EASE_MS, 1)
      zoom = startZoom + (targetZoom - startZoom) * easeOut(t)
      if (t < 1) needsFrame = true
    } else {
      zoom = targetZoom
    }

    map.setZoomAround(anchor, zoom, {animate: false})
    if (needsFrame) scheduleFrame()
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
    anchor = map.mouseEventToContainerPoint(e)

    if (timeDelta > 400) {
      // new gesture: a lone event is a mouse-wheel notch, delayed 40ms
      // (MapLibre `_onTimeout`) so a repeating trackpad isn't misread
      type = null
      lastValue = value
      if (gestureTimeout !== null) clearTimeout(gestureTimeout)
      gestureTimeout = window.setTimeout(() => {
        type = 'wheel'
        delta -= lastValue
        scheduleFrame()
      }, 40)
      return
    }

    const next = classifyWheel(type, value, timeDelta)
    if (type === null && gestureTimeout !== null) {
      // previous event was ambiguous; merge it into this one
      clearTimeout(gestureTimeout)
      gestureTimeout = null
      value += lastValue
    }
    type = next
    delta -= value
    scheduleFrame()
  }

  container.addEventListener('wheel', onWheel, {passive: false})

  return () => {
    container.removeEventListener('wheel', onWheel)
    if (raf !== null) cancelAnimationFrame(raf)
    if (gestureTimeout !== null) clearTimeout(gestureTimeout)
  }
}

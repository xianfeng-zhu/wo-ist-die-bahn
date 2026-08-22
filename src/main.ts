import {Map as GLMap, Marker, Popup, setWorkerUrl, type MapLayerMouseEvent} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import {fetchVehicles, BBox} from './hci.js'
import {filterVehicles, Product, Vehicle} from './vehicle.js'
import {lineColors} from './line-colors.js'
import {advanceAnimation, AnimState, pointAlongPath, projectOntoPath, slicePath, timeDiffMs} from './motion.js'
import {buildSegmentPath, firstStopAhead, LineShapes} from './track.js'

// MapLibre loads its tile-processing worker from an external file relative to
// the module; Vite doesn't emit it, so point it at the copy we ship in
// public/ (see public/maplibre-gl-worker.mjs).
setWorkerUrl('/maplibre-gl-worker.mjs')

const BERLIN_BBOX: BBox = {north: 52.68, west: 13.08, south: 52.34, east: 13.76}
const POLL_INTERVAL_MS = 20000
const MAX_BACKOFF_MS = 60000
// ?all=1 shows every returned vehicle (incl. FEX etc.) for testing the animation
const TEST_ALL = new URLSearchParams(location.search).has('all')

const PRODUCT_COLORS: Record<Product, string> = {suburban: '#2e7d32', subway: '#1565c0', tram: '#c62828'}
const PRODUCT_LABELS: Record<Product, string> = {suburban: 'S-Bahn', subway: 'U-Bahn', tram: 'Tram'}

// MapLibre GL: native smooth trackpad zoom, WebGL tile rendering (no white
// flashing, no tile-management gaps), tile overscaling capped by the engine.
// Persist the user's map view (center + zoom) across page refreshes.
const VIEW_KEY = 'liveberlin.mapview'
function loadView(): {center: [number, number]; zoom: number} | null {
  try {
    const raw = localStorage.getItem(VIEW_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as {lng?: number; lat?: number; zoom?: number}
    if (typeof v.lng !== 'number' || typeof v.lat !== 'number' || typeof v.zoom !== 'number') return null
    if (![v.lng, v.lat, v.zoom].every(Number.isFinite)) return null
    if (Math.abs(v.lat) > 85 || Math.abs(v.lng) > 180 || v.zoom < 0 || v.zoom > 19) return null
    return {center: [v.lng, v.lat], zoom: v.zoom}
  } catch {
    return null
  }
}
const savedView = loadView()

const map = new GLMap({
  container: 'map',
  style: {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }
    },
    layers: [{id: 'osm', type: 'raster', source: 'osm'}]
  },
  center: savedView?.center ?? [13.405, 52.52],
  zoom: savedView?.zoom ?? 12,
  maxZoom: 19
})


map.on('moveend', () => {
  const c = map.getCenter()
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({lng: c.lng, lat: c.lat, zoom: map.getZoom()}))
  } catch {
    // storage unavailable (private mode etc.) — view just won't persist
  }
})


// --- vehicle markers (line-labeled badges) ---
const markers = new Map<string, Marker>()
/** Active line-name filter (empty = all lines). */
const filters: Record<Product, boolean> = {suburban: true, subway: true, tram: true}
/** Active line-name filter (empty = all lines). */
let lineFilter = new Set(['M10', 'U8'])
const visibleVehicles = () => filterVehicles(vehicles, filters, lineFilter)
let vehicles: Vehicle[] = []
let lastUpdate = 0
let conn: 'live' | 'stale' | 'offline' = 'offline'

// --- smooth track-following animation ---
// speedFactor 1.0 = real-time pace (from realtime stop times); acceleration
// limits smooth out all speed changes (data updates, pauses, factor changes)
const ANIM = {speedFactor: 1, maxAccel: 0.01, maxDecel: 0.01}
const animStates = new Map<string, AnimState>()
let lineShapes: LineShapes = {}

const statusEl = document.getElementById('statusbar')!
function updateStatus() {
  const ago = lastUpdate ? Math.round((Date.now() - lastUpdate) / 1000) : 0
  const count = visibleVehicles().length
  statusEl.textContent = `${conn} · ${count} vehicles · updated ${ago}s ago`
}
setInterval(updateStatus, 1000)

function badgeElement(v: Vehicle): HTMLElement {
  const el = document.createElement('div')
  el.className = 'veh'
  el.style.background = lineColors[v.line] ?? PRODUCT_COLORS[v.product]
  el.textContent = v.line
  return el
}

function popupHtml(v: Vehicle): string {
  return (
    `<b>${v.line}</b> ${PRODUCT_LABELS[v.product]}<br>→ ${v.direction}<br>next: ${v.nextStop ?? '—'}` +
    (v.delayMs != null
      ? `<br><span style="color:${v.delayMs >= 300000 ? '#c62828' : '#333'}">delay: ${Math.round(v.delayMs / 60000)} min</span>`
      : '')
  )
}

/** (Re)build a vehicle's animation chain from its latest data, continuing
 * from the current animated position (never jumps). */
function updateSegment(v: Vehicle, m: Marker) {
  const prev = animStates.get(v.id)
  if (!v.stops || v.stops.length < 2) {
    // no stop-chain data: static marker at the polled position
    animStates.delete(v.id)
    m.setLngLat([v.lon, v.lat])
    return
  }
  const from = prev ? pointAlongPath(prev.path, prev.progress) : [v.lat, v.lon]
  const fromPos = {lat: from[0], lon: from[1]}
  const k = firstStopAhead(lineShapes, v.line, fromPos, v.stops)
  if (k < 1) {
    // no known stop ahead — hold at the current position
    animStates.delete(v.id)
    m.setLngLat([from[0], from[1]])
    return
  }
  const target = v.stops[k]
  const path = buildSegmentPath(lineShapes, v.line, fromPos, {lat: target.lat, lon: target.lon})
  animStates.set(v.id, {
    progress: 0,
    velocity: Math.max(0, prev?.velocity ?? 0), // keep momentum across re-anchors
    start: fromPos,
    end: {lat: target.lat, lon: target.lon},
    endT: Date.now() + timeDiffMs(v.stops[k - 1].t, target.t),
    endName: target.name,
    path,
    stops: v.stops,
    segIndex: k,
    line: v.line
  })
}

function render() {
  const visible = visibleVehicles()
  const seen = new Set<string>()
  for (const v of visible) {
    seen.add(v.id)
    let m = markers.get(v.id)
    if (!m) {
      m = new Marker({element: badgeElement(v)})
        .setLngLat([v.lon, v.lat])
        .setPopup(new Popup({offset: 20}).setHTML(popupHtml(v)))
        .addTo(map)
      markers.set(v.id, m)
    }
    updateSegment(v, m)
    m.getPopup()?.setHTML(popupHtml(v))
  }
  for (const [id, m] of markers) {
    if (!seen.has(id)) {
      m.remove()
      markers.delete(id)
      animStates.delete(id)
    }
  }
  updateTargetsFeatures()
  updateStatus()
}

// --- animation loop: smooth, forward-only, track-following movement ---
let lastFrame = performance.now()
let lastPathsUpdate = 0
function frame(now: number) {

  const dt = Math.min(now - lastFrame, 100) // clamp gaps (e.g. after tab hidden)
  lastFrame = now
  if (animStates.size > 0) {
    for (const [id, s] of animStates) {
      const next = advanceAnimation(s, Date.now(), dt, ANIM)
      const stops = next.stops
      const segIndex = next.segIndex ?? 0
      if (next.progress >= 1 && stops && stops.length >= 2 && segIndex < stops.length - 1) {
        // arrived at the target: continue to the FOLLOWING stop so the tram
        // keeps moving until fresh data arrives
        const k = segIndex + 1
        const fromPos = {lat: stops[k].lat, lon: stops[k].lon}
        const target = stops[k + 1]
        const path = buildSegmentPath(lineShapes, next.line, fromPos, {lat: target.lat, lon: target.lon})
        animStates.set(id, {
          ...next,
          progress: 0,
          velocity: Math.max(0, next.velocity), // keep momentum
          start: fromPos,
          end: {lat: target.lat, lon: target.lon},
          endT: Date.now() + timeDiffMs(stops[k].t, target.t),
          endName: target.name,
          segIndex: k,
          path
        })
      } else {
        animStates.set(id, next)
      }
      const m = markers.get(id)
      if (m) {
        const s2 = animStates.get(id)!
        const [lat, lon] = pointAlongPath(s2.path, s2.progress)
        m.setLngLat([lon, lat])
      }
    }
    // refresh the current-position → target paths a few times per second
    if (now - lastPathsUpdate > 500) {
      lastPathsUpdate = now
      updateTargetsFeatures()
    }
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

// --- debug/test: show each vehicle's next target (stop) + segment path ---
function addTargetsLayers() {
  map.addSource('targets', {type: 'geojson', data: {type: 'FeatureCollection', features: []}})
  // white casing underneath for contrast on any map background
  map.addLayer({
    id: 'anim-paths-casing',
    type: 'line',
    source: 'targets',
    paint: {'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9}
  })
  map.addLayer({
    id: 'anim-paths-layer',
    type: 'line',
    source: 'targets',
    paint: {'line-color': '#ff6d00', 'line-width': 3.5, 'line-opacity': 0.95}
  })
  map.addLayer({
    id: 'targets-layer',
    type: 'circle',
    source: 'targets',
    paint: {'circle-radius': 7, 'circle-color': '#ff6d00', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5}
  })
  map.on('click', 'targets-layer', (e: MapLayerMouseEvent) => {
    const name = e.features?.[0]?.properties?.name
    if (name) new Popup({offset: 10}).setLngLat(e.lngLat).setHTML(String(name)).addTo(map)
  })
}
map.on('load', addTargetsLayers)


function updateTargetsFeatures() {
  if (!map.getLayer('targets-layer') || map.getLayoutProperty('targets-layer', 'visibility') === 'none') return
  const features: Array<{type: 'Feature'; geometry: {type: 'Point' | 'LineString'; coordinates: unknown}; properties: Record<string, unknown>}> = []
  for (const v of vehicles) {
    const s = animStates.get(v.id)
    if (!s) continue
    features.push({
      type: 'Feature',
      geometry: {type: 'Point', coordinates: [s.end.lon, s.end.lat]},
      properties: {name: s.endName ?? v.nextStop ?? v.id}
    })
    // path from the vehicle's CURRENT animated position to the target
    const cur = pointAlongPath(s.path, s.progress)
    const last = s.path[s.path.length - 1]
    const total = projectOntoPath(s.path, {lat: last[0], lon: last[1]}).along
    const along = projectOntoPath(s.path, {lat: cur[0], lon: cur[1]}).along
    const remaining = slicePath(s.path, along, total)
    features.push({
      type: 'Feature',
      geometry: {type: 'LineString', coordinates: remaining.map(([lat, lon]) => [lon, lat])},
      properties: {}
    })
  }
  const src = map.getSource('targets') as {setData(data: unknown): void} | undefined
  src?.setData({type: 'FeatureCollection', features})
}

// --- track shapes only (stations/routes RENDERING commented out for testing) ---
async function loadNetworkLayers() {
  // TESTING: stations layer disabled — only targets render
  // try {
  //   const stations = await (await fetch('/stations.json')).json()
  //   map.addSource('stations', {type: 'geojson', data: stations})
  //   map.addLayer({
  //     id: 'stations-layer',
  //     type: 'circle',
  //     source: 'stations',
  //     layout: {visibility: 'none'},
  //     paint: {'circle-radius': 3, 'circle-color': '#888', 'circle-stroke-color': '#555', 'circle-stroke-width': 1}
  //   })
  //   map.on('click', 'stations-layer', (e: MapLayerMouseEvent) => {
  //     const name = e.features?.[0]?.properties?.name
  //     if (name) {
  //       new Popup({offset: 10}).setLngLat(e.lngLat).setHTML(String(name)).addTo(map)
  //     }
  //   })
  //   map.on('mouseenter', 'stations-layer', () => { map.getCanvas().style.cursor = 'pointer' })
  //   map.on('mouseleave', 'stations-layer', () => { map.getCanvas().style.cursor = '' })
  // } catch (err) {
  //   console.warn('stations layer unavailable', err)
  // }
  try {
    const routes = await (await fetch('/routes.json')).json()
    lineShapes = {}
    for (const f of routes.features ?? []) {
      const line = f.properties?.line
      const coords = f.geometry?.coordinates
      if (line && Array.isArray(coords)) {
        // GeoJSON [lon, lat] -> [lat, lon]
        lineShapes[line] = coords.map((c: [number, number]) => [c[1], c[0]])
      }
    }
    // TESTING: routes layer disabled — only targets render
    // for (const f of routes.features ?? []) {
    //   const line = f.properties?.line
    //   const product = f.properties?.product as Product | undefined
    //   f.properties = {...f.properties, color: lineColors[line] ?? (product ? PRODUCT_COLORS[product] : undefined) ?? '#888'}
    // }
    // map.addSource('routes', {type: 'geojson', data: routes})
    // map.addLayer({
    //   id: 'routes-layer',
    //   type: 'line',
    //   source: 'routes',
    //   layout: {visibility: 'none'},
    //   paint: {'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.75}
    // })
  } catch (err) {
    console.warn('routes layer unavailable', err)
  }
}
loadNetworkLayers()

// --- polling with client-side backoff ---
let nextDelay = POLL_INTERVAL_MS
let failures = 0
let controller: AbortController | null = null
async function poll() {
  controller = new AbortController()
  const t = setTimeout(() => controller!.abort(), 15000)
  try {
    // ?all=1: include every returned vehicle (e.g. FEX) for animation testing
    vehicles = await fetchVehicles(BERLIN_BBOX, 2000, controller.signal, !TEST_ALL)
    lastUpdate = Date.now()
    failures = 0
    nextDelay = POLL_INTERVAL_MS
    conn = 'live'
    render()
  } catch (err) {
    failures++
    conn = 'offline'
    nextDelay = Math.min(POLL_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS)
    console.warn('[poll]', err)
  } finally {
    clearTimeout(t)
    setTimeout(() => void poll(), nextDelay)
  }
}

void poll()

// --- mode filters + layer toggles ---
const filterEl = document.getElementById('filters')!
const modeRow = document.createElement('div')
modeRow.className = 'mode'
;(Object.keys(PRODUCT_LABELS) as Product[]).forEach(p => {
  const label = document.createElement('label')
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = true
  cb.onchange = () => {
    filters[p] = cb.checked
    render()
  }
  label.append(cb, ` ${PRODUCT_LABELS[p]}`, ` <span style="color:${PRODUCT_COLORS[p]}">●</span>`)
  modeRow.append(label)
})
// Line-name filter: comma/space-separated, empty = all lines
const parseLines = (s: string): Set<string> =>
  new Set(s.split(/[,;\s]+/).map(t => t.trim().toUpperCase()).filter(Boolean))
const lineInput = document.createElement('input')
lineInput.type = 'text'
lineInput.value = 'M10, U8'
lineInput.placeholder = 'lines, e.g. M10, U8 (empty = all)'
lineInput.oninput = () => {
  lineFilter = parseLines(lineInput.value)
  render()
}
const lineRow = document.createElement('div')
lineRow.className = 'mode'
const lineLabel = document.createElement('label')
lineLabel.append('Lines:')
lineRow.append(lineLabel, lineInput)
filterEl.append(lineRow)

const toggleLayer = (layerId: string, name: string) => {
  const label = document.createElement('label')
  label.className = 'layer'
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.onchange = () => {
    if (!map.getLayer(layerId)) return // layers load async
    map.setLayoutProperty(layerId, 'visibility', cb.checked ? 'visible' : 'none')
  }
  label.append(cb, ` ${name}`)
  filterEl.append(label)
}
// TESTING: stations/routes layers disabled — only targets render
// toggleLayer('stations-layer', 'Stations')
// toggleLayer('routes-layer', 'Routes')

// Targets: next-stop dots + animated segment paths (debug/test view)
const targetsLabel = document.createElement('label')
targetsLabel.className = 'layer'
const targetsCb = document.createElement('input')
targetsCb.type = 'checkbox'
targetsCb.checked = true
targetsCb.onchange = () => {
  for (const id of ['targets-layer', 'anim-paths-layer', 'anim-paths-casing']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', targetsCb.checked ? 'visible' : 'none')
  }
}
targetsLabel.append(targetsCb, ' Targets')

filterEl.append(targetsLabel)

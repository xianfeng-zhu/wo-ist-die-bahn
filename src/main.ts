import {Map as GLMap, Marker, Popup, setWorkerUrl, type FilterSpecification, type MapLayerMouseEvent} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import {fetchVehicles, BBox} from './hci.js'
import {filterVehicles, Product, shortId, Vehicle} from './vehicle.js'
import {lineColors} from './line-colors.js'
import {advanceAlong, AnimState, pointAlongPath, projectOntoPath, slicePath} from './motion.js'
import {buildSegmentPath, LineShapes} from './track.js'

// MapLibre loads its tile-processing worker from an external file relative to
// the module; Vite doesn't emit it, so point it at the copy we ship in
// public/ (see public/maplibre-gl-worker.mjs).
setWorkerUrl('/maplibre-gl-worker.mjs')

const BERLIN_BBOX: BBox = {north: 52.68, west: 13.08, south: 52.34, east: 13.76}
const POLL_INTERVAL_MS = 10000 // matches the official VBB livemap (Livemap.timeout = 10)
const MAX_BACKOFF_MS = 60000
// ?all=1 shows every returned vehicle (incl. FEX, bus) for testing the animation.
// The product mask has to widen too: mask 7 excludes them server-side, so
// relaxing only the client-side name gate would change nothing.
const TEST_ALL = new URLSearchParams(location.search).has('all')
const RAIL_ONLY = 7
const EVERY_PRODUCT = 1023

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
        attribution: 'Live data: VBB &middot; &copy; OpenStreetMap contributors'
      }
    },
    layers: [{id: 'osm', type: 'raster', source: 'osm'}]
  },
  center: savedView?.center ?? [13.405, 52.52],
  zoom: savedView?.zoom ?? 12,
  maxZoom: 19
})


// MapLibre tracks window resize, but not a container that changes size on its
// own (devtools docking, split view, DPR change on monitor switch).
new ResizeObserver(() => map.resize()).observe(map.getContainer())

// Below this zoom, badges outnumber the space for them: 38% overlapped at z12
// with labels on. The official VBB livemap hides labels under z13 too.
const LABEL_MIN_ZOOM = 13
const applyZoomClass = () => document.body.classList.toggle('dense', map.getZoom() < LABEL_MIN_ZOOM)
map.on('zoom', applyZoomClass)
applyZoomClass()

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
/** Active product filter (one flag per mode; all on by default). */
const filters: Record<Product, boolean> = {suburban: true, subway: true, tram: true}
/** Active line-name filter (empty = all lines). */
let lineFilter = new Set<string>()
const visibleVehicles = () => filterVehicles(vehicles, filters, lineFilter)
let vehicles: Vehicle[] = []
let lastUpdate = 0
let conn: 'live' | 'stale' | 'offline' = 'offline'

// --- forecast-driven, track-following animation ---
// Position comes from the operator's own ~30 s forecast (Vehicle.forecast),
// projected onto the GTFS track: their timing, our smooth geometry. Nothing
// here is schedule-paced or invented.
const animStates = new Map<string, AnimState>()
let lineShapes: LineShapes = {}

// --- error log (debug view): visible in-page and readable via __lb.logs ---
const logEl = document.getElementById('debuglog')!
const logs: Array<{at: string; msg: string}> = []
function logError(msg: string) {
  const at = new Date().toTimeString().slice(0, 8)
  logs.push({at, msg})
  if (logs.length > 50) logs.shift()
  console.warn('[liveberlin]', msg)
  logEl.hidden = false
  logEl.textContent = logs.slice(-8).map(l => `${l.at}  ${l.msg}`).join('\n')
}
window.addEventListener('error', e => logError(`uncaught: ${e.message}`))
window.addEventListener('unhandledrejection', e => logError(`unhandled rejection: ${e.reason}`))

const statusEl = document.getElementById('statusbar')!
function updateStatus() {
  const ago = lastUpdate ? Math.round((Date.now() - lastUpdate) / 1000) : 0
  const count = visibleVehicles().length
  statusEl.textContent = `${conn} · ${count} vehicles · updated ${ago}s ago`
  statusEl.dataset.state = conn
}
setInterval(updateStatus, 1000)

function badgeElement(v: Vehicle): HTMLElement {
  const el = document.createElement('div')
  el.className = 'veh'
  el.style.background = lineColors[v.line] ?? PRODUCT_COLORS[v.product]
  el.textContent = v.line
  // debugging handles: the full jid for headless queries, the short id on hover
  el.dataset.vehicleId = v.id
  el.title = `${v.line} · ${shortId(v.id)}`
  // caption under the badge, shown only while the "IDs" toggle is on
  const vid = document.createElement('span')
  vid.className = 'vid'
  vid.textContent = shortId(v.id)
  el.append(vid)
  return el
}

function popupHtml(v: Vehicle): string {
  return (
    // toStop is what HAFAS declares; nextStop is inferred from times and picks
    // the terminus when the real next stop's time has just passed
    `<b>${v.line}</b> ${PRODUCT_LABELS[v.product]}<br>→ ${v.direction}<br>next: ${v.toStop?.name ?? v.nextStop ?? '—'}` +
    (v.delayMs != null
      ? `<br><span style="color:${v.delayMs >= 300000 ? '#c62828' : '#333'}">delay: ${Math.round(v.delayMs / 60000)} min</span>`
      : '') +
    `<br><span class="pid">id: <b>${shortId(v.id)}</b><br>${v.id}</span>`
  )
}

/**
 * Furthest (metres) a forecast point may sit from the chosen track before we
 * treat the track as the wrong one.
 *
 * Measured over 259 vehicles the residual is bimodal: real noise between the
 * decimated GTFS shape and the track runs to ~100 m (a whole line is capped at
 * 500 points), while branch mismatches start at ~300 m and reach 6.5 km. 250 m
 * sits in the empty valley between them. A tighter limit put ~46 vehicles on
 * the boundary, flipping path source between polls and jolting the marker.
 */
const SHAPE_FIT_LIMIT_M = 250

/** Metres between two lat/lon points (local flat approximation). */
const metres = (a: [number, number], b: [number, number]): number =>
  Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * Math.cos(a[0] * Math.PI / 180))

const maxResidualM = (path: Array<[number, number]>, pts: Array<[number, number]>): number => {
  let worst = 0
  for (const pt of pts) worst = Math.max(worst, metres(pt, projectOntoPath(path, {lat: pt[0], lon: pt[1]}).point))
  return worst
}

/** Forecast points -> distance along `path`, forced non-decreasing so a point
 *  that projects backwards (a curve doubling back) cannot stall the motion. */
const alongsOnPath = (path: Array<[number, number]>, pts: Array<[number, number]>): number[] => {
  const out: number[] = []
  for (const [lat, lon] of pts) {
    const a = projectOntoPath(path, {lat, lon}).along
    out.push(out.length === 0 ? a : Math.max(a, out[out.length - 1]))
  }
  return out
}

/**
 * (Re)build a vehicle's animation segment from its latest data.
 *
 * The segment is the one HAFAS declares (`fromStop` -> `toStop`) and the pacing
 * is the operator's own forecast, snapped onto the GTFS track so curves stay
 * smooth. We anchor on the reported position rather than the previously drawn
 * one: being truthful matters more than hiding a small correction, and the
 * forecast makes the correction small.
 */
function updateSegment(v: Vehicle, m: Marker) {
  const target = v.toStop
  const f = v.forecast
  if (!target || !f || f.pts.length === 0) {
    // no declared segment or no forecast: static marker at the reported position
    animStates.delete(v.id)
    m.setLngLat([v.lon, v.lat])
    return
  }
  const start = {lat: f.pts[0][0], lon: f.pts[0][1]}
  let path = buildSegmentPath(lineShapes, v.line, start, {lat: target.lat, lon: target.lon})
  // Does that GTFS track actually pass through the forecast? prepare-data.mjs
  // keeps one shape per line (the longest), so branch variants (S1, M5, tram 12)
  // do not match and projection would snap kilometres away. When it doesn't fit,
  // follow the operator's own forecast points instead of a wrong track.
  if (maxResidualM(path, f.pts) > SHAPE_FIT_LIMIT_M) {
    // Wrong track. Follow the forecast points, then continue straight to the
    // target: the forecast alone only spans ~30 s, so a path that stopped there
    // would strand the vehicle short of its stop.
    const last = f.pts[f.pts.length - 1]
    const to: [number, number] = [target.lat, target.lon]
    path = metres(last, to) > 25 ? [...f.pts, to] : [...f.pts]
  }
  const alongs = alongsOnPath(path, f.pts)
  const total = projectOntoPath(path, {lat: path[path.length - 1][0], lon: path[path.length - 1][1]}).along
  // Carry the on-screen position across the re-anchor. The reported position can
  // sit behind what we extrapolated; without this the marker visibly reverses.
  const prev = animStates.get(v.id)
  const drawn = prev ? pointAlongPath(prev.path, prev.total > 0 ? prev.drawnAlong / prev.total : 0) : null
  const drawnAlong = drawn ? Math.min(projectOntoPath(path, {lat: drawn[0], lon: drawn[1]}).along, total) : 0
  animStates.set(v.id, {
    drawnAlong,
    reportT: Date.now(),
    ms: f.ms,
    alongs,
    total,
    start,
    end: {lat: target.lat, lon: target.lon},
    endName: target.name,
    path,
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

// --- animation loop: replay the operator forecast along the track ---
let lastPathsUpdate = 0
function frame(rafNow: number) {
  if (animStates.size > 0) {
    const now = Date.now()
    for (const [id, s] of animStates) {
      const m = markers.get(id)
      if (!m) continue
      const along = advanceAlong(s, now)
      s.drawnAlong = along
      const [lat, lon] = pointAlongPath(s.path, s.total > 0 ? along / s.total : 0)
      m.setLngLat([lon, lat])
    }
    // refresh the current-position → target paths a few times per second
    if (rafNow - lastPathsUpdate > 500) {
      lastPathsUpdate = rafNow
      updateTargetsFeatures()
    }
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

// --- debug/test: show each vehicle's next target (stop) + segment path ---
// One source holds both geometries, so every layer MUST filter by $type: a
// circle layer draws one circle per geometry position, so without the filter
// `targets-layer` would also dot every vertex of every path (~10x the circles,
// and path vertices would swallow the target clicks).
const POINTS_ONLY: FilterSpecification = ['==', '$type', 'Point']
const LINES_ONLY: FilterSpecification = ['==', '$type', 'LineString']
// Zoomed out the annotations must stay smaller than the vehicle dots they
// belong to, or the debug overlay reads as the vehicles.
const ZOOM_WIDTH = (full: number) =>
  ['interpolate', ['linear'], ['zoom'], 10, full * 0.35, LABEL_MIN_ZOOM, full] as unknown as number
function addTargetsLayers() {
  map.addSource('targets', {type: 'geojson', data: {type: 'FeatureCollection', features: []}})
  // white casing underneath for contrast on any map background
  map.addLayer({
    id: 'anim-paths-casing',
    type: 'line',
    source: 'targets',
    filter: LINES_ONLY,
    paint: {'line-color': '#ffffff', 'line-width': ZOOM_WIDTH(7), 'line-opacity': 0.9}
  })
  map.addLayer({
    id: 'anim-paths-layer',
    type: 'line',
    source: 'targets',
    filter: LINES_ONLY,
    paint: {'line-color': '#ff6d00', 'line-width': ZOOM_WIDTH(3.5), 'line-opacity': 0.95}
  })
  map.addLayer({
    id: 'targets-layer',
    type: 'circle',
    source: 'targets',
    filter: POINTS_ONLY,
    paint: {'circle-radius': ZOOM_WIDTH(7), 'circle-color': '#ff6d00', 'circle-stroke-color': '#fff', 'circle-stroke-width': ZOOM_WIDTH(2.5)}
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
    const remaining = slicePath(s.path, s.drawnAlong, s.total)
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
    logError(`routes.json unavailable (animation falls back to straight lines): ${err instanceof Error ? err.message : String(err)}`)
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
    vehicles = await fetchVehicles(BERLIN_BBOX, 2000, controller.signal, !TEST_ALL, TEST_ALL ? EVERY_PRODUCT : RAIL_ONLY)
    lastUpdate = Date.now()
    failures = 0
    nextDelay = POLL_INTERVAL_MS
    conn = 'live'
    render()
  } catch (err) {
    failures++
    // one hiccup is stale data, not an outage; say so honestly
    conn = failures >= 3 ? 'offline' : 'stale'
    logError(`poll failed (${failures}x): ${err instanceof Error ? err.message : String(err)}`)
    nextDelay = Math.min(POLL_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS)
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
  const dot = document.createElement('span')
  dot.style.color = PRODUCT_COLORS[p]
  dot.textContent = '●'
  label.append(cb, ` ${PRODUCT_LABELS[p]} `, dot)
  modeRow.append(label)
})
filterEl.append(modeRow)
// Line-name filter: comma/space-separated, empty = all lines
const parseLines = (s: string): Set<string> =>
  new Set(s.split(/[,;\s]+/).map(t => t.trim().toUpperCase()).filter(Boolean))
const lineInput = document.createElement('input')
lineInput.type = 'text'
lineInput.value = ''
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

// Vehicle IDs: short unique label attached under each badge (see shortId). On
// by default for debugging; uncheck, or narrow with Lines, when it gets busy.
const idsLabel = document.createElement('label')
idsLabel.className = 'layer'
const idsCb = document.createElement('input')
idsCb.type = 'checkbox'
idsCb.checked = true
idsCb.onchange = () => document.body.classList.toggle('show-vids', idsCb.checked)
document.body.classList.toggle('show-vids', idsCb.checked)
idsLabel.append(idsCb, ' IDs')
filterEl.append(idsLabel)

/**
 * Debug handle for headless checks (console capture is unreliable — see
 * AGENTS.md). Read-only by convention; `byId` takes a full jid or a shortId.
 */
;(window as unknown as {__lb: unknown}).__lb = {
  map,
  animStates,
  get vehicles() { return vehicles },
  get lineShapes() { return lineShapes },
  get logs() { return logs },
  byId: (q: string) => {
    const v = vehicles.find(x => x.id === q || shortId(x.id) === q)
    return v ? {vehicle: v, anim: animStates.get(v.id)} : null
  }
}

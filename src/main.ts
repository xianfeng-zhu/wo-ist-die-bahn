import {Map as GLMap, Marker, Popup, setWorkerUrl, type FilterSpecification, type MapLayerMouseEvent} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import {fetchVehicles, BBox} from './hci.js'
import {compareLineNames, filterVehicles, Product, shortId, Vehicle} from './vehicle.js'
import {lineColors} from './line-colors.js'
import {advanceAlong, AnimState, forwardStep, impliedSpeed, maxResidualM, metresBetween, pointAlongPath, projectOntoPath, slicePath, SPEED_SANITY_MPS} from './motion.js'
import {buildSegmentPath, LineShapes} from './track.js'
import {MotionRecorder} from './recorder.js'
import type {FrameEntry} from './recorder.js'

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
/**
 * Active line-name selection. An EMPTY set means nothing is picked and so shows
 * nothing, exactly as unticking every type does.
 *
 * `lineMode` tracks whether the user has narrowed it. In `'all'` the selection
 * follows the network: every known line of every enabled type stays ticked, and
 * a line discovered later joins it. That also keeps the app correct before
 * tracks.json has loaded, when nothing is known yet.
 */
let lineFilter = new Set<string>()
let lineMode: 'all' | 'custom' = 'all'
const visibleVehicles = () =>
  filterVehicles(vehicles, filters, lineMode === 'all' ? undefined : lineFilter)
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

// --- motion recorder (debug): logs what the map DRAWS, for offline analysis ---
// ?traceHz=N sets the position-sample rate (detection always runs every frame).
const TRACE_HZ = Number(new URLSearchParams(location.search).get('traceHz')) || 5
let recorder: MotionRecorder | null = null

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

/**
 * How often the fit/speed guards rejected the GTFS track, so the effect of
 * shipping per-variant shapes can be measured rather than assumed. Read it from
 * `window.__lb.guardStats`.
 */
const guardStats = {rebuilds: 0, badFit: 0, tooFast: 0}

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
  let path = buildSegmentPath(lineShapes, v.line, start, {lat: target.lat, lon: target.lon}, f.pts)
  // Does the chosen GTFS track actually pass through the forecast? pickShape
  // takes the best of the line's variants, but a line can still be missing the
  // exact variant this vehicle is on (prepare-data.mjs caps how many it ships).
  // When nothing fits, follow the operator's own forecast points instead of a
  // wrong track.
  const badFit = () => maxResidualM(path, f.pts) > SHAPE_FIT_LIMIT_M
  const tooFast = () => {
    const a = alongsOnPath(path, f.pts)
    const t = projectOntoPath(path, {lat: path[path.length - 1][0], lon: path[path.length - 1][1]}).along
    return impliedSpeed(f.ms, a, t, path) > SPEED_SANITY_MPS
  }
  guardStats.rebuilds++
  const unfit = badFit()
  const fast = !unfit && tooFast()
  if (unfit) guardStats.badFit++
  if (fast) guardStats.tooFast++
  if (unfit || fast) {
    // Wrong track: either the forecast does not lie on it, or following it
    // would need an impossible speed (a shape that takes the long way round, or
    // a ring line where projection wraps). Follow the forecast points, then
    // continue straight to the target: the forecast alone spans only ~30 s, so a
    // path that stopped there would strand the vehicle short of its stop.
    const last = f.pts[f.pts.length - 1]
    const to: [number, number] = [target.lat, target.lon]
    path = metresBetween(last, to) > 25 ? [...f.pts, to] : [...f.pts]
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
    drawnT: Date.now(),
    renderPos: prev?.renderPos, // keep what is on screen; frame() glides to the fix
    heading: prev?.heading,     // and keep its direction, so it is never dragged back
    heldMs: prev?.heldMs,       // and how long it has been stalled, so a hold cannot restart forever
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
      const dtMs = now - s.drawnT
      const along = advanceAlong(s, now)
      s.drawnAlong = along
      s.drawnT = now
      const target = pointAlongPath(s.path, s.total > 0 ? along / s.total : 0)
      const from = s.renderPos
      if (from) {
        const step = forwardStep(from, target, s.heading ?? null, dtMs, s.heldMs ?? 0)
        s.renderPos = step.pos
        // reset on any move, so the allowance is per stall rather than cumulative
        s.heldMs = step.held ? (s.heldMs ?? 0) + dtMs : 0
      } else {
        s.renderPos = target
        s.heldMs = 0
      }
      if (from && metresBetween(from, s.renderPos) >= 0.3) {
        s.heading = [s.renderPos[0] - from[0], s.renderPos[1] - from[1]]
      }
      // still short of the computed position => the limiter is correcting
      s.correcting = metresBetween(s.renderPos, target) > 1e-9
      m.setLngLat([s.renderPos[1], s.renderPos[0]])
    }
    if (recorder) {
      const entries: FrameEntry[] = []
      for (const v of vehicles) {
        const s = animStates.get(v.id)
        if (s?.renderPos) entries.push({id: v.id, line: v.line, pos: s.renderPos,
          atTarget: s.total > 0 && s.drawnAlong >= s.total - 1e-9, target: s.endName,
          correcting: s.correcting})
      }
      recorder.frame(now, entries)
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
  /*
   * These paths are one per VEHICLE, not one per route, so on a shared corridor
   * they stack as deep as the traffic on it. With ~270 vehicles that merges into
   * a solid orange band below about z13, which hides the very thing it is drawn
   * to show. Hidden below the same threshold the badges use for dense mode; the
   * target dots stay, because discrete points do not smear. Narrow with the Lines
   * box when a single corridor is still too busy.
   */
  // white casing underneath for contrast on any map background
  map.addLayer({
    id: 'anim-paths-casing',
    type: 'line',
    source: 'targets',
    filter: LINES_ONLY,
    minzoom: LABEL_MIN_ZOOM,
    paint: {'line-color': '#ffffff', 'line-width': ZOOM_WIDTH(7), 'line-opacity': 0.9}
  })
  map.addLayer({
    id: 'anim-paths-layer',
    type: 'line',
    source: 'targets',
    filter: LINES_ONLY,
    minzoom: LABEL_MIN_ZOOM,
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

// --- network layers: route lines and station dots ---
/**
 * Keep the debug overlay (target dots, animated paths) above the network. The
 * two are added from different callbacks — `addTargetsLayers` on map `load`,
 * these after a fetch — so whichever loses the race has to insert itself below.
 */
const belowDebug = (): string | undefined =>
  ['anim-paths-casing', 'anim-paths-layer', 'targets-layer'].find(id => map.getLayer(id))

async function loadNetworkLayers() {
  // routes.json is ANIMATION data: one entry per route variant, because each
  // vehicle needs a short, unambiguous shape to project onto. It is not drawn.
  try {
    const routes = await (await fetch('/routes.json')).json()
    lineShapes = {}
    for (const f of routes.features ?? []) {
      const line = f.properties?.line
      const coords = f.geometry?.coordinates
      if (line && Array.isArray(coords) && coords.length >= 2) {
        // Several features share a line name — one per route variant — so collect
        // them all. GeoJSON [lon, lat] -> [lat, lon].
        ;(lineShapes[line] ??= []).push(coords.map((c: [number, number]) => [c[1], c[0]]))
      }
    }
  } catch (err) {
    logError(`routes.json unavailable (animation falls back to straight lines): ${err instanceof Error ? err.message : String(err)}`)
  }
  // tracks.json is DRAWING data: each line's variants merged into the track it
  // actually runs on, so one set of rails gets one stroke. Drawing routes.json
  // instead put a dozen strokes on a shared tram street, and stacked strokes
  // compound their opacity into a solid smear.
  try {
    const tracks = await (await fetch('/tracks.json')).json()
    const learned: Array<[string, Product]> = []
    for (const f of tracks.features ?? []) {
      const line = f.properties?.line
      const product = f.properties?.product as Product | undefined
      f.properties = {
        ...f.properties,
        color: lineColors[line] ?? (product ? PRODUCT_COLORS[product] : undefined) ?? '#888'
      }
      if (line && product) learned.push([line, product])
    }
    // the menus list every line in the network, not just the ones running now
    learnLines(learned)
    map.addSource('routes', {type: 'geojson', data: tracks})
    map.addLayer({
      id: 'routes-layer',
      type: 'line',
      source: 'routes',
      // Still faint, and still absent city-wide: below ~z11 the whole tram network
      // falls inside a few hundred pixels, where even one stroke per track is an
      // unreadable mass, and vehicles are what you are there to see.
      minzoom: 11,
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 14, 1.8, 16, 2.6],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.3, 14, 0.55, 16, 0.7]
      }
    }, belowDebug())
  } catch (err) {
    logError(`tracks.json unavailable (route lines hidden): ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    const stations = await (await fetch('/stations.json')).json()
    map.addSource('stations', {type: 'geojson', data: stations})
    map.addLayer({
      id: 'stations-layer',
      type: 'circle',
      source: 'stations',
      // 1,573 stops: hide them when zoomed out, where they would out-number and
      // obscure the vehicles the map is actually for.
      minzoom: 12,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 1.5, 15, 3.5],
        'circle-color': '#fff',
        'circle-stroke-color': '#666',
        'circle-stroke-width': 1
      }
    }, belowDebug())
    map.on('click', 'stations-layer', (e: MapLayerMouseEvent) => {
      const name = e.features?.[0]?.properties?.name
      if (name) new Popup({offset: 10}).setLngLat(e.lngLat).setHTML(String(name)).addTo(map)
    })
    map.on('mouseenter', 'stations-layer', () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', 'stations-layer', () => { map.getCanvas().style.cursor = '' })
  } catch (err) {
    logError(`stations.json unavailable (station dots hidden): ${err instanceof Error ? err.message : String(err)}`)
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
    // top up the menus: a line running now but absent from tracks.json (a new
    // service, or ?all=1 widening the product mask) must still be selectable
    learnLines(vehicles.map(v => [v.line, v.product] as [string, Product]))
    if (recorder) {
      const drawn = new Map<string, [number, number]>()
      for (const [id, s] of animStates) if (s.renderPos) drawn.set(id, s.renderPos)
      recorder.poll(drawn, new Map(vehicles.map(v => [v.id, [v.lat, v.lon] as [number, number]])))
    }
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

/*
 * Responsive controls. The filter panel needs ~270 px and the status bar ~220 px;
 * below the sum of those (plus margins) they would overlap, so the panel
 * collapses behind a button instead of being squeezed or pushed off-window.
 * Panels are also capped against the viewport in style.css, so any window that
 * can show the button can show the panel.
 */
const COMPACT_MAX_WIDTH = 720
const compactQuery = matchMedia(`(max-width: ${COMPACT_MAX_WIDTH}px)`)

const settingsToggle = document.createElement('button')
settingsToggle.id = 'settings-toggle'
settingsToggle.type = 'button'
settingsToggle.textContent = '\u2699'
settingsToggle.title = 'Settings'
settingsToggle.setAttribute('aria-label', 'Settings')
settingsToggle.setAttribute('aria-controls', 'filters')
document.body.append(settingsToggle)

function setSettingsOpen(open: boolean) {
  document.body.classList.toggle('settings-open', open)
  settingsToggle.setAttribute('aria-expanded', String(open))
}
settingsToggle.onclick = () => setSettingsOpen(!document.body.classList.contains('settings-open'))

function applyCompact() {
  document.body.classList.toggle('compact', compactQuery.matches)
  // leaving compact: the panel is always visible again, so drop the open state
  if (!compactQuery.matches) setSettingsOpen(false)
}
compactQuery.addEventListener('change', applyCompact)
applyCompact()
setSettingsOpen(false)
// tapping the map dismisses the panel, like any other overlay
map.on('click', () => { if (document.body.classList.contains('settings-open')) setSettingsOpen(false) })
/*
 * Two multi-select dropdowns: pick any set of types, then any set of lines.
 *
 * These replaced a free-text box that needed you to know a line's exact name and
 * spell it (`M10, U8`), and showed you nothing about what existed.
 *
 * Built from <details> plus checkboxes rather than <select multiple>, which needs
 * ctrl/cmd-click to pick more than one and is close to unusable on a touch
 * screen. The summary shows the current choice, so the panel stays compact.
 *
 * Both still drive the same `filterVehicles(vehicles, filters, lineFilter)`: every
 * type ticked sets all products true, and no line ticked leaves the line set
 * empty, which already means "all". So the filter logic and its tests are
 * unchanged.
 */

/**
 * Every line the app knows about, with its type. Seeded from tracks.json so the
 * list is complete and stable rather than only what happens to be running, then
 * topped up from live data so a line can never be missing from the menu.
 */
const knownLines = new Map<string, Product>()

/** A dropdown holding a checkbox list. Returns the parts the caller fills in. */
function multiSelect(title: string) {
  const box = document.createElement('details')
  box.className = 'multi'
  const head = document.createElement('summary')
  const caption = document.createElement('span')
  caption.className = 'multi-caption'
  head.append(`${title}: `, caption)
  const body = document.createElement('div')
  body.className = 'multi-body'
  box.append(head, body)
  filterEl.append(box)
  return {box, caption, body}
}

const typeUi = multiSelect('Type')
const lineUi = multiSelect('Line')

/** Types that actually have lines, in the order PRODUCT_LABELS declares them. */
const presentTypes = (): Product[] => {
  const have = new Set(knownLines.values())
  return (Object.keys(PRODUCT_LABELS) as Product[]).filter(p => have.has(p))
}

/** One checkbox row. `onSet` receives the new checked state. */
function checkRow(text: string, checked: boolean, onSet: (on: boolean) => void, colour?: string) {
  const label = document.createElement('label')
  label.className = 'layer'
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = checked
  cb.onchange = () => onSet(cb.checked)
  label.append(cb, ` ${text}`)
  if (colour) {
    const dot = document.createElement('span')
    dot.style.color = colour
    dot.textContent = ' ●'
    label.append(dot)
  }
  return label
}

function describeTypes(): string {
  const on = presentTypes().filter(p => filters[p])
  if (on.length === 0) return 'none'
  if (on.length === presentTypes().length) return 'all'
  return on.map(p => PRODUCT_LABELS[p]).join(', ')
}

/** Lines that could be shown right now: those of the ticked types. */
const selectableLines = (): string[] =>
  [...knownLines].filter(([, p]) => filters[p]).map(([n]) => n)

function describeLines(): string {
  if (lineMode === 'all') return 'all'
  if (lineFilter.size === 0) return 'none'
  const names = [...lineFilter].sort(compareLineNames)
  return names.length <= 3 ? names.join(', ') : `${names.length} lines`
}

function rebuildTypes() {
  const types = presentTypes()
  const allOn = types.length > 0 && types.every(p => filters[p])
  typeUi.body.replaceChildren(
    checkRow('All types', allOn, on => {
      for (const p of types) filters[p] = on
      // a line whose type just went away must stop filtering, or the map empties
      // with no visible reason why
      dropHiddenLines()
      rebuildTypes()
      rebuildLines()
      render()
    })
  )
  for (const p of types) {
    typeUi.body.append(checkRow(PRODUCT_LABELS[p], filters[p], on => {
      filters[p] = on
      dropHiddenLines()
      rebuildTypes()
      rebuildLines()
      render()
    }, PRODUCT_COLORS[p]))
  }
  typeUi.caption.textContent = describeTypes()
}

/** Forget any picked line whose type is no longer shown. */
function dropHiddenLines() {
  for (const name of [...lineFilter]) {
    const p = knownLines.get(name)
    if (p && !filters[p]) lineFilter.delete(name)
  }
}

/** A line is ticked when the mode is `all`, or when it is in the selection. */
const lineTicked = (name: string): boolean => lineMode === 'all' || lineFilter.has(name)

/** Move to an explicit selection, seeded from whatever is ticked right now. */
function makeSelectionExplicit() {
  if (lineMode === 'custom') return
  lineMode = 'custom'
  lineFilter = new Set(selectableLines())
}

function rebuildLines() {
  const all = selectableLines()
  const everyOne = all.length > 0 && all.every(lineTicked)
  lineUi.body.replaceChildren(
    // Ticks and unticks every line, like "All types" does for the types. Before,
    // this only ticked itself: the selection meant "all" by being empty, so the
    // line boxes stayed blank and unticking it did nothing.
    checkRow('All lines', everyOne, on => {
      if (on) {
        lineMode = 'all'
        lineFilter = new Set(all)
      } else {
        lineMode = 'custom'
        lineFilter = new Set()
      }
      rebuildLines()
      render()
    })
  )
  for (const p of presentTypes()) {
    if (!filters[p]) continue // only offer lines you could actually see
    const names = [...knownLines].filter(([, prod]) => prod === p).map(([n]) => n).sort(compareLineNames)
    if (names.length === 0) continue
    const head = document.createElement('div')
    head.className = 'multi-group'
    head.textContent = PRODUCT_LABELS[p]
    lineUi.body.append(head)
    for (const n of names) {
      lineUi.body.append(checkRow(n, lineTicked(n), on => {
        makeSelectionExplicit()
        if (on) lineFilter.add(n)
        else lineFilter.delete(n)
        // back to every line ticked: return to `all`, so a line added later joins
        if (all.every(x => lineFilter.has(x))) lineMode = 'all'
        rebuildLines()
        render()
      }))
    }
  }
  lineUi.caption.textContent = describeLines()
}

/** Add any lines we have not seen before; rebuild the menus only if that happens. */
function learnLines(entries: Iterable<[string, Product]>) {
  let added = false
  for (const [name, product] of entries) {
    if (!name || knownLines.has(name)) continue
    knownLines.set(name, product)
    added = true
  }
  if (!added) return
  rebuildTypes()
  rebuildLines()
}
rebuildTypes()
rebuildLines()

/** A checkbox that shows or hides one map layer, appended to `parent`. */
const toggleLayer = (layerId: string, name: string, on: boolean, parent: HTMLElement) => {
  const label = document.createElement('label')
  label.className = 'layer'
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = on
  const apply = () => {
    if (!map.getLayer(layerId)) return // layers load async
    map.setLayoutProperty(layerId, 'visibility', cb.checked ? 'visible' : 'none')
  }
  cb.onchange = apply
  map.on('idle', apply) // re-assert once the layer exists
  label.append(cb, ` ${name}`)
  parent.append(label)
  return cb
}
toggleLayer('routes-layer', 'Routes', true, filterEl)
toggleLayer('stations-layer', 'Stations', true, filterEl)

// --- one Debug switch for the whole test overlay ---
// Four separate switches were confusing, and the network layers had none at all
// because their code sat commented out. Everything for testing now lives behind
// this one control: target dots, animated paths, vehicle IDs, the error panel and
// the motion recorder. Off by default so the map looks finished; the setting is
// remembered, and `?debug=1` forces it on.
const DEBUG_KEY = 'liveberlin.debug'
const debugRequested = new URLSearchParams(location.search).has('debug')
const debugGroup = document.createElement('div')
debugGroup.id = 'debug-group'

const debugLabel = document.createElement('label')
debugLabel.className = 'layer'
const debugCb = document.createElement('input')
debugCb.type = 'checkbox'
debugCb.checked = debugRequested || localStorage.getItem(DEBUG_KEY) === '1'
debugLabel.append(debugCb, ' Debug view')
filterEl.append(debugLabel, debugGroup)

// Targets: next-stop dots + animated segment paths. Not built with toggleLayer,
// because these three layers depend on the Debug switch as well as their own box.
const targetsLabel = document.createElement('label')
targetsLabel.className = 'layer'
const targetsCb = document.createElement('input')
targetsCb.type = 'checkbox'
targetsCb.checked = true
targetsLabel.append(targetsCb, ' Targets')
debugGroup.append(targetsLabel)
const TARGET_LAYERS = ['targets-layer', 'anim-paths-layer', 'anim-paths-casing']
const applyTargets = () => {
  const vis = debugCb.checked && targetsCb.checked ? 'visible' : 'none'
  for (const id of TARGET_LAYERS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis)
  }
}
targetsCb.onchange = applyTargets
map.on('idle', applyTargets) // re-assert once the layers exist

// Vehicle IDs: short unique label under each badge (see shortId), so a specific
// vehicle can be reported by name.
const idsLabel = document.createElement('label')
idsLabel.className = 'layer'
const idsCb = document.createElement('input')
idsCb.type = 'checkbox'
idsCb.checked = true
idsLabel.append(idsCb, ' IDs')
debugGroup.append(idsLabel)

function applyDebug() {
  const on = debugCb.checked
  document.body.classList.toggle('debug', on)
  document.body.classList.toggle('show-vids', on && idsCb.checked)
  applyTargets()
  localStorage.setItem(DEBUG_KEY, on ? '1' : '0')
}
debugCb.onchange = applyDebug
idsCb.onchange = applyDebug
applyDebug()

// --- motion recording controls (inside the debug group) ---
const recRow = document.createElement('div')
recRow.className = 'mode'
const recLabel = document.createElement('label')
recLabel.className = 'layer'
const recCb = document.createElement('input')
recCb.type = 'checkbox'
const recStatus = document.createElement('span')
recStatus.className = 'rec-status'
const saveBtn = document.createElement('button')
saveBtn.type = 'button'
saveBtn.textContent = 'Save log'
saveBtn.disabled = true

function saveRecording() {
  if (!recorder) return
  const blob = new Blob([recorder.toNdjson(Date.now())], {type: 'application/x-ndjson'})
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `motion-${new Date(recorder.startedAt).toISOString().replace(/[:.]/g, '-')}.ndjson`
  a.click()
  URL.revokeObjectURL(a.href)
}
saveBtn.onclick = saveRecording

recCb.onchange = () => {
  if (recCb.checked) {
    recorder = new MotionRecorder(Date.now(), Math.round(1000 / TRACE_HZ))
    saveBtn.disabled = false
  }
  recStatus.textContent = recCb.checked ? ' recording…' : ' stopped'
}
setInterval(() => {
  if (!recorder || !recCb.checked) return
  const s = recorder.summary(Date.now())
  const faults = (s.events.jump ?? 0) + (s.events.reversal ?? 0) + (s.events.overspeed ?? 0) + (s.events.freeze ?? 0)
  recStatus.textContent = ` ${s.seconds}s · ${s.vehiclesSeen} veh · ${faults} faults`
}, 1000)

recLabel.append(recCb, ' Record motion', recStatus)
recRow.append(recLabel, saveBtn)
debugGroup.append(recRow)

/**
 * Debug handle for headless checks (console capture is unreliable — see
 * AGENTS.md). Read-only by convention; `byId` takes a full jid or a shortId.
 */
;(window as unknown as {__lb: unknown}).__lb = {
  map,
  animStates,
  get vehicles() { return vehicles },
  get lineShapes() { return lineShapes },
  get guardStats() { return guardStats },
  get logs() { return logs },
  get recorder() { return recorder },
  startRecording: (hz = TRACE_HZ) => { recorder = new MotionRecorder(Date.now(), Math.round(1000 / hz))
    recCb.checked = true; saveBtn.disabled = false; return true },
  stopRecording: () => { recCb.checked = false; return recorder?.summary(Date.now()) ?? null },
  saveRecording,
  byId: (q: string) => {
    const v = vehicles.find(x => x.id === q || shortId(x.id) === q)
    return v ? {vehicle: v, anim: animStates.get(v.id)} : null
  }
}

import {Map as GLMap, Marker, Popup, setWorkerUrl, type FilterSpecification, type MapLayerMouseEvent} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import {fetchAllVehicles, BBox, JNY_CAP} from './hci.js'
import {compareLineNames, filterVehicles, Forecast, lineKey, LineSighting, Product, recordLineSightings, shortId, StopRef, Vehicle} from './vehicle.js'
import {lineColors} from './line-colors.js'
import {textOn} from './contrast.js'
import {fetchJourneyDetail, fetchStationBoard} from './hci.js'
import {markProgress, type Departure, type JourneyDetail} from './journey.js'
import {berlinSecondsOfDay} from './format.js'
import {Panel} from './panel.js'
import {noticeBody, stationView, vehicleView, type VehicleView} from './views.js'
import {search} from './search.js'
import {advanceAlong, AnimState, forwardStep, impliedSpeed, maxResidualM, metresBetween, pointAlongPath, projectOntoPath, slicePath, SPEED_SANITY_MPS} from './motion.js'
import {buildSegmentPath, LineShapes} from './track.js'
import {MotionRecorder} from './recorder.js'
import type {FrameEntry} from './recorder.js'

// Everything under public/ is served from the deployment's base path, which is
// NOT the domain root on GitHub Pages (a project site lives at /<repo>/). Vite
// rewrites index.html for us, but URLs built at runtime have to add it here.
const asset = (name: string): string => `${import.meta.env.BASE_URL}${name}`

// MapLibre loads its tile-processing worker from an external file relative to
// the module; Vite doesn't emit it, so point it at the copy we ship in
// public/ (see public/maplibre-gl-worker.mjs).
setWorkerUrl(asset('maplibre-gl-worker.mjs'))

const BERLIN_BBOX: BBox = {north: 52.68, west: 13.08, south: 52.34, east: 13.76}
/**
 * Gap between polls.
 *
 * Each response carries a 30 s forecast (`ani.mSec` = 0/10/20/30 s), and the
 * animation replays it against the wall clock, so the poll only has to come back
 * before the forecast runs out. At 10 s — copied from the official VBB livemap,
 * whose `Livemap.timeout` is 10 — the cycle was ~12 s with request time, so about
 * 60% of every forecast was fetched and thrown away. That mattered once the app
 * started fetching every mode: their livemap asks for the visible viewport, we ask
 * for all of Berlin, so we had copied their cadence without their payload.
 *
 * 20 s gives a ~22 s cycle: still 8 s inside the forecast when the network is
 * slow, and half the traffic (11 -> 6 MB a minute, 15 -> 8 requests a minute).
 * The cost is that a revision to a delay estimate can be up to 10 s staler. That
 * is affordable because most polls carry no revision at all — HAFAS's 30 s
 * forecast matches the position it later calculates to a median 7 m for trams,
 * with only 5.4% of samples over 50 m.
 *
 * Do not raise it past ~25 s. Beyond that the cycle overruns the forecast and
 * vehicles start coasting on `COAST_GRACE_MS`, which is an outage cushion, not a
 * normal operating mode.
 */
const POLL_INTERVAL_MS = 20000
/**
 * First retry after a failed poll, doubling per consecutive failure.
 *
 * Deliberately NOT a multiple of POLL_INTERVAL_MS. It used to be
 * `POLL_INTERVAL_MS * 2 ** failures`, which at a 20 s interval would wait 40 s
 * after a single hiccup — well past the forecast plus its grace, so every marker
 * would freeze over one dropped request. Data is already stale when a poll fails,
 * so the first retry should be sooner than a normal poll, not later.
 */
const RETRY_BASE_MS = 5000
const MAX_BACKOFF_MS = 60000

/**
 * Badge colour for a line with no colour of its own (`lineColors`).
 *
 * Bus and ferry are VBB's official values, from the linienfarben CSV rows named
 * `Bus` (#a5027d) and `Fähre` (#009bd5). The CSV has no row for long distance,
 * and its RE/RB rows are per line, so those two fall back to greys — dark for
 * ICE/IC, mid for a regional line the CSV does not list. The three rail colours
 * predate the CSV and stay as they are: every S-Bahn and U-Bahn line has its own
 * colour, so in practice only trams read this table.
 */
const PRODUCT_COLORS: Record<Product, string> = {
  suburban: '#2e7d32',
  subway: '#1565c0',
  tram: '#c62828',
  bus: '#a5027d',
  ferry: '#009bd5',
  express: '#7d8185', // the grey VBB's own maps use for ICE/IC; we had invented one
  regional: '#5e5e5d'
}

/** Menu order too: local modes first, then the ones that leave the city. */
const PRODUCT_LABELS: Record<Product, string> = {
  suburban: 'S-Bahn',
  subway: 'U-Bahn',
  tram: 'Tram',
  bus: 'Bus',
  ferry: 'Ferry',
  regional: 'Regional',
  express: 'ICE / IC'
}

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
        /*
         * Both credits must be links, not plain text.
         *
         * CC BY 4.0 requires the VBB credit to name the licence and be traceable
         * to the source. The OSM Foundation attribution guidelines require a way
         * to reach the licence and data origin — plain text gave a visitor no
         * route to either. See ATTRIBUTION.md.
         */
        attribution:
          'Data: <a href="https://unternehmen.vbb.de/digitale-services/datensaetze/" ' +
          'target="_blank" rel="noopener">VBB</a> (CC BY 4.0, modified) &middot; ' +
          '&copy; <a href="https://www.openstreetmap.org/copyright" ' +
          'target="_blank" rel="noopener">OpenStreetMap</a> contributors'
      }
    },
    /*
     * Mute the base map so the transit data is the subject.
     *
     * OSM's own styling is loud — bright yellow and orange roads, pink casings,
     * strong greens — and at city scale it competes with ~700 vehicle dots for
     * attention. Desaturating and lifting the black point pushes the city into
     * the background without hiding it: street names stay readable, and the
     * badges and route lines stop fighting the roads underneath.
     *
     * Done on the existing raster layer rather than by switching tile provider:
     * no new dependency, no new attribution, nothing extra to serve.
     */
    layers: [{
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: {'raster-saturation': -0.62, 'raster-contrast': -0.08, 'raster-brightness-min': 0.06}
    }]
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
  // Following moves the map every frame; persisting that would hammer localStorage
  // and store a position the user never chose.
  if (followSelected) return
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
const filters: Record<Product, boolean> = {
  suburban: true, subway: true, tram: true, bus: true, ferry: true, express: true, regional: true
}
/**
 * Active line-name selection. An EMPTY set means nothing is picked and so shows
 * nothing, exactly as unticking every type does.
 *
 * `lineMode` tracks whether the user has narrowed it. In `'all'` the selection
 * follows the network: every line of every enabled type stays ticked, and a line
 * that starts running later joins it. That also keeps the app correct before the
 * first poll has answered, when no line is known yet.
 */
let lineFilter = new Set<string>()
let lineMode: 'all' | 'custom' = 'all'
const visibleVehicles = () =>
  filterVehicles(vehicles, filters, lineMode === 'all' ? undefined : lineFilter)
let vehicles: Vehicle[] = []
let lastUpdate = 0
let conn: 'live' | 'stale' | 'offline' = 'offline'
/** Product masks whose last response hit the gate's journey cap (see `JNY_CAP`). */
let capped: number[] = []

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
/**
 * The status bar.
 *
 * Counts and "updated Ns ago" are engineering facts, and with a 20 s poll the age
 * sits at 15-20 s most of the time, which reads as stale to someone who does not
 * know the design. So the full line belongs to the debug view.
 *
 * What stays for everyone is the one thing a rider needs: is this live? And it
 * only appears when the answer is no. A map whose vehicles have quietly stopped
 * moving looks exactly like a working one, which is the failure worth naming.
 */
function updateStatus() {
  const ago = lastUpdate ? Math.round((Date.now() - lastUpdate) / 1000) : 0
  const count = visibleVehicles().length
  const capNote = capped.length > 0 ? ' · feed capped' : ''
  if (DEBUG_AVAILABLE && debugCb.checked) {
    statusEl.textContent = `${conn} · ${count} vehicles · updated ${ago}s ago${capNote}`
    statusEl.hidden = false
  } else if (conn === 'live' && capped.length === 0) {
    statusEl.hidden = true
  } else {
    statusEl.textContent = conn === 'live' ? 'some vehicles missing' : `${conn} — positions may be old`
    statusEl.hidden = false
  }
  statusEl.dataset.state = conn
}
setInterval(updateStatus, 1000)

function badgeElement(v: Vehicle): HTMLElement {
  const el = document.createElement('div')
  el.className = 'veh'
  const bg = lineColors[v.line] ?? PRODUCT_COLORS[v.product]
  el.style.background = bg
  // Not always white: 47 of the 89 colours the app ships fail WCAG 4.5:1 against
  // white text, and U4's yellow scored 1.45:1 — a badge you could not read.
  el.style.color = textOn(bg)
  el.textContent = v.line
  // debugging handles: the full jid for headless queries, the short id on hover
  el.dataset.vehicleId = v.id
  el.title = `${v.line} · ${shortId(v.id)}`
  /*
   * Say what this is, once, properly.
   *
   * MapLibre makes the marker focusable, so it is already in the tab order. But
   * the badge read out as "S4291274-0": the debug caption below is `display:none`
   * and so still part of `textContent`, running straight into the line name. An
   * explicit label fixes the reading, and `aria-hidden` keeps the caption out of
   * it whether it is visible or not.
   */
  el.setAttribute('role', 'button')
  el.setAttribute('aria-label',
    `${v.line} ${PRODUCT_LABELS[v.product]} to ${v.direction || 'unknown'} — open details`)
  // caption under the badge, shown only while the "IDs" toggle is on
  const vid = document.createElement('span')
  vid.className = 'vid'
  vid.setAttribute('aria-hidden', 'true')
  vid.textContent = shortId(v.id)
  el.append(vid)
  el.onclick = e => {
    e.stopPropagation()
    void showVehicle(v.id)
  }
  el.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      void showVehicle(v.id)
    }
  }
  return el
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
const guardStats = {rebuilds: 0, badFit: 0, tooFast: 0, noShape: 0}

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
  /*
   * The operator's own forecast as the path, continued straight to the target.
   *
   * The forecast IS road geometry: four points along the way the vehicle is
   * about to take. It only spans ~30 s though, so a path that stopped there
   * would strand the vehicle short of its stop.
   */
  const forecastPath = (): Array<[number, number]> => {
    const last = f.pts[f.pts.length - 1]
    const to: [number, number] = [target.lat, target.lon]
    return metresBetween(last, to) > 25 ? [...f.pts, to] : [...f.pts]
  }
  guardStats.rebuilds++
  // Bus, ferry, regional and long-distance ship no GTFS shapes — see AGENTS.md
  // for the payload measurement behind that. Their forecast beats a straight line
  // between stops, so use it directly instead of asking buildSegmentPath for a
  // shape that is not there.
  // Look the shapes up by MODE AND NAME. By name alone, the bus called S9 got
  // the S-Bahn S9's rails, the bus called 21 got tram 21's, and so on for M1, M2,
  // M8, 27 and U6 — a bus drawn along a railway. Measured before the fix: of 519
  // live buses, 33 matched a rail line's name and sat a median 159 m from the
  // track they had been given.
  const key = lineKey(v)
  if (!(lineShapes[key] ?? []).some(s => s.length >= 2)) {
    guardStats.noShape++
    setSegment(v, forecastPath(), f, target, start)
    return
  }
  let path = buildSegmentPath(lineShapes, key, start, {lat: target.lat, lon: target.lon}, f.pts)
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
  const unfit = badFit()
  const fast = !unfit && tooFast()
  if (unfit) guardStats.badFit++
  if (fast) guardStats.tooFast++
  if (unfit || fast) {
    // Wrong track: either the forecast does not lie on it, or following it
    // would need an impossible speed (a shape that takes the long way round, or
    // a ring line where projection wraps).
    path = forecastPath()
  }
  setSegment(v, path, f, target, start)
}

/** Store the animation state for one vehicle against a chosen path. */
function setSegment(v: Vehicle, path: Array<[number, number]>, f: Forecast, target: StopRef, start: {lat: number; lon: number}) {
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
        .addTo(map)
      // a marker created after the selection was made still has to reflect it
      if (selectedVehicleId !== null) {
        if (v.id === selectedVehicleId) m.getElement().classList.add('is-selected')
        else m.setOpacity(DIM_OPACITY)
      }
      markers.set(v.id, m)
    }
    updateSegment(v, m)
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
      // Follow on the DRAWN position, not the reported one, so the map recentres
      // on the badge you can see rather than the one the feed reported.
      if (followSelected && id === selectedVehicleId) {
        keepVehicleInView([s.renderPos[1], s.renderPos[0]])
      }
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
    markMapTapHandled()
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
    const routes = await (await fetch(asset('routes.json'))).json()
    lineShapes = {}
    for (const f of routes.features ?? []) {
      const line = f.properties?.line
      const product = f.properties?.product as Product | undefined
      const coords = f.geometry?.coordinates
      if (line && product && Array.isArray(coords) && coords.length >= 2) {
        // Keyed by mode AND name (`lineKey`), never the name alone: routes.json
        // holds rail geometry, and a bus shares its name with a rail line often
        // enough to matter. Several features share one key — one per route
        // variant — so collect them all. GeoJSON [lon, lat] -> [lat, lon].
        ;(lineShapes[lineKey({product, line})] ??= []).push(coords.map((c: [number, number]) => [c[1], c[0]]))
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
    const tracks = await (await fetch(asset('tracks.json'))).json()
    for (const f of tracks.features ?? []) {
      // One feature per rendered COLOUR, covering every line that shares it, so a
      // street used by ten tram lines gets one stroke rather than ten identical
      // ones. `group` is either a hex (the line has its own official colour) or a
      // product name (it falls back), which keeps the product hexes in this file
      // only — see prepare-data.mjs.
      const group = f.properties?.group as string | undefined
      const product = f.properties?.product as Product | undefined
      f.properties = {
        ...f.properties,
        color: group?.startsWith('#')
          ? group
          : (product ? PRODUCT_COLORS[product] : undefined) ?? '#888'
      }
    }
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
    const stations = await (await fetch(asset('stations.json'))).json()
    // Keep the names, so a shared `?stop=` link has a title before its board loads
    // and the search box has something to match on.
    for (const f of stations.features ?? []) {
      const id = f.properties?.id
      const name = f.properties?.name
      const c = f.geometry?.coordinates
      if (id && name && Array.isArray(c)) {
        stationIndex.set(String(id), {name: String(name), lat: c[1], lon: c[0]})
      }
    }
    map.addSource('stations', {type: 'geojson', data: stations})
    map.addLayer({
      id: 'stations-layer',
      type: 'circle',
      source: 'stations',
      // 1,573 stops: hide them when zoomed out, where they would out-number and
      // obscure the vehicles the map is actually for.
      minzoom: 12,
      paint: {
        // Was 1.5 px at z12 and 3.5 at z15, which is too small to see and far too
        // small to hit. Now a dot you can read at a glance, and the ring is dark
        // enough to hold against the desaturated base map.
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 14, 5, 16, 7],
        'circle-color': '#ffffff',
        'circle-stroke-color': '#37474f',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 1.5, 16, 2.5],
        'circle-opacity': 0.95
      }
    }, belowDebug())
    /*
     * A separate, invisible circle that is only there to be tapped.
     *
     * A finger is about 44 px and a station dot is 6-14 px, so hit-testing the
     * visible dot means missing it. MapLibre hit-tests geometry, not paint, so a
     * transparent circle of a comfortable radius takes the tap without changing
     * how anything looks. It sits below the visible dot so the dot stays crisp.
     */
    map.addLayer({
      id: 'stations-hit',
      type: 'circle',
      source: 'stations',
      minzoom: 12,
      paint: {'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 16], 'circle-opacity': 0}
    }, 'stations-layer')
    map.on('click', 'stations-hit', (e: MapLayerMouseEvent) => {
      markMapTapHandled()
      const props = e.features?.[0]?.properties
      const id = props?.id
      const name = props?.name
      // `id` is the HAFAS extId that stations.json now ships, so the board needs
      // no name lookup. Without one there is nothing useful to show.
      if (id && name) void showStop(String(id), String(name))
    })
    map.on('mouseenter', 'stations-hit', () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', 'stations-hit', () => { map.getCanvas().style.cursor = '' })
  } catch (err) {
    logError(`stations.json unavailable (station dots hidden): ${err instanceof Error ? err.message : String(err)}`)
  }
}
loadNetworkLayers()

// ─────────── detail panel: a vehicle's journey, a stop's departures ───────────
//
// Replaces the map popups. A popup can hold a line name and a next stop; it
// cannot hold 31 stops with times, and it is the wrong shape on a phone.
//
// The panel is addressable: `?vehicle=<shortId>` and `?stop=<extId>`. That is
// what makes the phone back gesture close it instead of leaving the site, and it
// makes a stop's board a link someone can send.

const panel = new Panel()

/**
 * Stops by extId, from stations.json.
 *
 * Holds the name so a shared `?stop=` link has a title before its board loads, and
 * the position so opening a board can take the map there — a panel describing
 * Alexanderplatz while the map shows Köpenick is just confusing.
 */
const stationIndex = new Map<string, {name: string; lat: number; lon: number}>()

type DetailTarget =
  | {kind: 'vehicle'; id: string}
  | {kind: 'stop'; id: string; name: string}

let detailTarget: DetailTarget | null = null
/** Cached journey for the open vehicle, so a poll can re-render without refetching. */
let detailJourney: JourneyDetail | null = null
let detailStrip: VehicleView | null = null
let detailBoard: Departure[] = []
let detailFetchedAt = 0
let detailAbort: AbortController | null = null

const urlFor = (t: DetailTarget | null): string => {
  const base = location.pathname
  if (!t) return base
  return t.kind === 'vehicle' ? `${base}?vehicle=${encodeURIComponent(shortId(t.id))}`
    : `${base}?stop=${encodeURIComponent(t.id)}`
}

/** Open a target and push it onto history, so Back closes it. */
/**
 * How many of our panels are stacked in history.
 *
 * Kept IN the history state rather than in a variable, because `popstate` does not
 * say which way the user went — reading the depth back off the entry is the only
 * reliable answer. It decides whether Back is offered, and lets Close unwind the
 * whole stack in one press.
 */
let navDepth = 0
const depthOf = (): number => (history.state as {depth?: number} | null)?.depth ?? 0

function navigate(t: DetailTarget): void {
  navDepth = depthOf() + 1
  history.pushState({detail: t, depth: navDepth}, '', urlFor(t))
  void applyTarget(t)
}


/**
 * Close the panel.
 *
 * Prefer going Back, so the history entry the open panel created is consumed
 * rather than left behind. With no entry of ours to unwind — someone arrived
 * straight at `?vehicle=…` — rewrite the URL instead, because `history.back()`
 * would take them off the site.
 */
function closeDetail(): void {
  const depth = depthOf()
  // Unwind every entry we pushed, in one go: someone three panels deep wants the
  // map back, not three presses of Back.
  if (depth > 0) history.go(-depth)
  else {
    history.replaceState(null, '', urlFor(null))
    clearDetail()
  }
}

function clearDetail(): void {
  detailAbort?.abort()
  detailAbort = null
  detailTarget = null
  detailJourney = null
  detailStrip = null
  detailBoard = []
  navDepth = 0
  followSelected = false
  setSelectedVehicle(null)
  panel.hide()
  setFocusRoute(null)
  setFocusStop(null)
}
panel.onClose = () => closeDetail()
panel.onBack = () => history.back()

const showVehicle = (id: string): void => navigate({kind: 'vehicle', id})
const showStop = (id: string, name: string): void =>
  navigate({kind: 'stop', id, name: name || stationIndex.get(id)?.name || 'Stop'})

/** Render whatever the URL asks for. */
async function applyTarget(t: DetailTarget | null): Promise<void> {
  detailAbort?.abort()
  detailAbort = new AbortController()
  const signal = detailAbort.signal
  detailTarget = t
  detailJourney = null
  detailStrip = null
  detailBoard = []
  detailFetchedAt = 0
  if (!t) { clearDetail(); return }

  if (t.kind === 'vehicle') {
    const v = vehicles.find(x => x.id === t.id || shortId(x.id) === shortId(t.id))
    if (!v) {
      panel.show({title: 'Vehicle', subtitle: 'not running now', canGoBack: depthOf() > 1, body: noticeBody(
        'That vehicle is not on the map any more. Journeys end, and a link to one only lasts as long as the journey.', 'empty')})
      return
    }
    // keep the real id, in case we arrived from a short one in the URL
    detailTarget = {kind: 'vehicle', id: v.id}
    const bg = lineColors[v.line] ?? PRODUCT_COLORS[v.product]
    panel.show({
      title: `${v.line} · ${PRODUCT_LABELS[v.product]}`,
      subtitle: v.direction ? `to ${v.direction}` : undefined,
      accent: bg,
      accentText: textOn(bg),
      canGoBack: depthOf() > 1,
      body: noticeBody('Loading the route…', 'loading')
    })
    setSelectedVehicle(v.id)
    try {
      const detail = await fetchJourneyDetail(v.id, signal)
      if (signal.aborted) return
      detailJourney = detail
      renderVehicleDetail()?.scrollToVehicle()
      setFocusRoute(detail?.path ?? null)
      setFocusStop(null)
      // Glide there once, then follow. Snapping straight into follow mode makes the
      // opening feel like a fault rather than a move.
      const drawn = animStates.get(v.id)?.renderPos
      centreOnVisible(drawn ? [drawn[1], drawn[0]] : [v.lon, v.lat], 600)
      setTimeout(() => { if (detailTarget?.kind === 'vehicle') followSelected = true }, 650)
    } catch (err) {
      if (signal.aborted) return
      panel.updateBody(noticeBody('Could not load the route just now.', 'error'))
      logError(`journey detail failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return
  }

  panel.show({
    title: t.name,
    subtitle: 'departures',
    accent: '#37474f',
    accentText: '#ffffff',
    canGoBack: depthOf() > 1,
    body: noticeBody('Loading departures…', 'loading')
  })
  setSelectedVehicle(null)
  setFocusRoute(null)
  followSelected = false
  const at = stationIndex.get(t.id)
  setFocusStop(at ?? null)
  if (at) {
    /*
     * Go to the stop, but do not zoom in past what is useful.
     *
     * A board reached from search can be anywhere in the city, and leaving the map
     * where it was makes the panel look like it belongs to somewhere else. Zoom
     * only if we are further out than street level; zooming OUT to a fixed level
     * would throw away a view the user had chosen.
     */
    const zoom = Math.max(map.getZoom(), 14)
    map.easeTo({center: [at.lon, at.lat], zoom, duration: 600})
    // let the ease finish before deciding whether the panel covers it
    setTimeout(() => keepClearOfPanel([at.lon, at.lat]), 650)
  }
  try {
    const board = await fetchStationBoard(t.id, 60, 30, signal)
    if (signal.aborted) return
    detailBoard = board
    detailFetchedAt = Date.now()
    renderStopDetail()
  } catch (err) {
    if (signal.aborted) return
    panel.updateBody(noticeBody('Could not load departures just now.', 'error'))
    logError(`station board failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Rebuild the vehicle body from the latest poll. Returns the view, for the caller
 *  that wants to scroll it into place on first open. */
function renderVehicleDetail(): VehicleView | null {
  const t = detailTarget
  if (t?.kind !== 'vehicle') return null
  const v = vehicles.find(x => x.id === t.id)
  if (!v) {
    // The journey ended, or the vehicle left the box, while its panel was open.
    // Saying so beats leaving times on screen that have stopped meaning anything.
    panel.updateBody(noticeBody('This journey has finished, so there is nothing left to follow.', 'empty'))
    setSelectedVehicle(null)
    setFocusRoute(null)
    detailStrip = null
    return null
  }
  const stops = detailJourney?.stops ?? []
  const target = markProgress(stops, v.fromStop?.name, v.toStop?.name)
  detailStrip = vehicleView(v, detailJourney, target, {
    onStop: (id, name) => navigate({kind: 'stop', id, name})
  })
  panel.updateBody(detailStrip.body)
  updateStripMarker()
  return detailStrip
}

function renderStopDetail(): void {
  if (detailTarget?.kind !== 'stop') return
  panel.updateBody(stationView(detailBoard, berlinSecondsOfDay(new Date()), {
    labels: PRODUCT_LABELS,
    colourFor: d => lineColors[d.line] ?? (d.product ? PRODUCT_COLORS[d.product] : '#666666'),
    textFor: textOn,
    onPick: d => {
      // The board's jid is the same id the radar uses, so a departure that is
      // already moving opens its journey. One that has not left yet is not on the
      // map, and there is nothing to show.
      const onMap = vehicles.find(x => x.id === d.jid)
      if (onMap) navigate({kind: 'vehicle', id: onMap.id})
    }
  }))
}

/**
 * Nudge the map so a point is not hidden behind the panel.
 *
 * The panel covers the left third of a wide window and most of a phone screen, so
 * tapping a vehicle near that edge would hide the very thing you tapped. Only
 * moves when the point is actually behind the panel, and only far enough to clear
 * it — an unconditional recentre on every tap is disorienting.
 */
function keepClearOfPanel(lngLat: [number, number]): void {
  const box = panel.occupies
  if (!box) return
  const pt = map.project(lngLat)
  const margin = 24
  let dx = 0
  let dy = 0
  if (Panel.isCompact) {
    // sheet from the bottom: push the point up above its top edge
    if (pt.y > box.top - margin) dy = pt.y - (box.top - margin)
  } else {
    // column on the left: push the point right of its edge
    if (pt.x < box.right + margin) dx = pt.x - (box.right + margin)
  }
  if (dx === 0 && dy === 0) return
  map.panBy([dx, dy], {duration: 400})
}

/** The vehicle whose panel is open, so its badge can be picked out on the map. */
let selectedVehicleId: string | null = null

/**
 * While a vehicle's panel is open, keep the vehicle on screen.
 *
 * The map does NOT move with the vehicle. Recentring on every frame worked, but it
 * felt heavy: the whole city crawled sideways the entire time a panel was open,
 * and nothing around the vehicle ever held still long enough to read.
 *
 * So the vehicle is left to move, and the map only follows when the vehicle is
 * about to leave the part of the map you can see. Then it glides once, putting the
 * vehicle back in the middle, and goes quiet again. The result is a still map most
 * of the time and one deliberate move now and then.
 *
 * "The part you can see" is the map MINUS the panel: a 380 px column on a wide
 * window, everything below ~150 px on a phone. The container centre would park the
 * vehicle underneath the panel.
 *
 * A drag or a pinch releases it. Following that ignored the user would make the
 * map impossible to look around while a panel was open, which is worse than the
 * problem it solves.
 */
let followSelected = false

/** How near an edge the vehicle may get before the map moves. */
const KEEP_IN_MARGIN_PX = 72
/** Length of the one catch-up glide. Long enough to read as a move, not a jump. */
const RECENTRE_MS = 700
/** True while our own catch-up glide is running, so it is not restarted mid-flight. */
let recentring = false

/** The map you can actually see: the container minus whatever the panel covers. */
function visibleRect(): {left: number; top: number; right: number; bottom: number} {
  const full = {left: 0, top: 0, right: innerWidth, bottom: innerHeight}
  const box = panel.occupies
  if (!box) return full
  // sheet along the bottom vs column down the left
  return Panel.isCompact ? {...full, bottom: box.top} : {...full, left: box.right}
}

/** Pixel offset from the container centre to the centre of the uncovered map. */
function visibleCentreOffset(): [number, number] {
  const r = visibleRect()
  return [(r.left + r.right) / 2 - innerWidth / 2, (r.top + r.bottom) / 2 - innerHeight / 2]
}

/** Put `lngLat` in the middle of the map you can actually see. */
function centreOnVisible(lngLat: [number, number], duration = 0): void {
  map.easeTo({center: lngLat, offset: visibleCentreOffset(), duration})
}

/**
 * Recentre only when `lngLat` is close to leaving the visible map.
 *
 * The margin is capped against the box, because on a phone the uncovered strip can
 * be shorter than twice the margin — with a fixed 72 px there the test would never
 * pass and the map would glide without end.
 */
function keepVehicleInView(lngLat: [number, number]): void {
  if (recentring) return
  const r = visibleRect()
  const m = Math.min(KEEP_IN_MARGIN_PX, (r.right - r.left) / 4, (r.bottom - r.top) / 4)
  const p = map.project(lngLat)
  const inside = p.x > r.left + m && p.x < r.right - m && p.y > r.top + m && p.y < r.bottom - m
  if (inside) return
  recentring = true
  // A user gesture during the glide fires moveend too, and releases follow itself.
  map.once('moveend', () => { recentring = false })
  centreOnVisible(lngLat, RECENTRE_MS)
}

// A user gesture always wins. Programmatic moves carry no originalEvent, so this
// does not fire on our own following.
map.on('movestart', e => {
  if ((e as {originalEvent?: unknown}).originalEvent) followSelected = false
})

/**
 * Pick the selected vehicle out of the crowd.
 *
 * With ~700 badges on screen, "the one you tapped" is otherwise impossible to
 * follow: it is the same size and colour as its neighbours and it keeps moving.
 * So the chosen badge gets a ring and the rest fade back.
 *
 * Two rules about how, both learned the hard way:
 *
 * The ring and the size go through a CLASS, never `transform`. `.veh` IS the
 * MapLibre marker element and MapLibre owns its transform inline for positioning,
 * so a CSS transform is either ignored or breaks placement. Growing the box stays
 * centred, because the marker is anchored with a percentage translate.
 *
 * The dimming goes through `Marker.setOpacity`, not CSS. MapLibre writes marker
 * opacity INLINE on every update (it has an `opacityWhenCovered` feature), so a
 * stylesheet rule simply loses — measured: the other badges stayed at opacity 1.
 * Using the library's own setter is the supported way to say this.
 */
const DIM_OPACITY = '0.3'
function setSelectedVehicle(id: string | null): void {
  if (selectedVehicleId === id) return
  selectedVehicleId = id
  document.body.classList.toggle('has-selection', id !== null)
  for (const [vid, m] of markers) {
    const chosen = vid === id
    m.getElement().classList.toggle('is-selected', chosen)
    m.setOpacity(id === null || chosen ? undefined : DIM_OPACITY)
  }
}

/** Move the strip marker to match the vehicle's progress on the map. */
function updateStripMarker(): void {
  if (!detailStrip || detailTarget?.kind !== 'vehicle') return
  const s = animStates.get(detailTarget.id)
  detailStrip.setProgress(s && s.total > 0 ? s.drawnAlong / s.total : 0)
}

/**
 * The route of the vehicle whose panel is open, drawn on the map.
 *
 * HAFAS returns it with the journey detail, so this needs no GTFS geometry — which
 * matters, because we ship none for bus, ferry, regional or long distance. Drawn
 * under the debug overlay and over the faint network lines.
 */
function setFocusRoute(path: Array<[number, number]> | null): void {
  const src = map.getSource('focus-route') as {setData(d: unknown): void} | undefined
  if (!src) return
  src.setData({
    type: 'FeatureCollection',
    features: path && path.length >= 2
      ? [{type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates: path.map(([lat, lon]) => [lon, lat])}}]
      : []
  })
}

/** Ring the stop whose board is open, so the panel and the map agree. */
function setFocusStop(at: {lat: number; lon: number} | null): void {
  const src = map.getSource('focus-stop') as {setData(d: unknown): void} | undefined
  if (!src) return
  src.setData({
    type: 'FeatureCollection',
    features: at
      ? [{type: 'Feature', properties: {}, geometry: {type: 'Point', coordinates: [at.lon, at.lat]}}]
      : []
  })
}

function addFocusRouteLayers(): void {
  map.addSource('focus-route', {type: 'geojson', data: {type: 'FeatureCollection', features: []}})
  map.addSource('focus-stop', {type: 'geojson', data: {type: 'FeatureCollection', features: []}})
  map.addLayer({
    id: 'focus-route-casing',
    type: 'line',
    source: 'focus-route',
    layout: {'line-cap': 'round', 'line-join': 'round'},
    paint: {'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9}
  }, belowDebug())
  map.addLayer({
    id: 'focus-route-line',
    type: 'line',
    source: 'focus-route',
    layout: {'line-cap': 'round', 'line-join': 'round'},
    paint: {'line-color': '#1565c0', 'line-width': 3.5, 'line-opacity': 0.95}
  }, belowDebug())
  map.addLayer({
    id: 'focus-stop-ring',
    type: 'circle',
    source: 'focus-stop',
    paint: {
      'circle-radius': 9,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#37474f',
      'circle-stroke-width': 3
    }
  }, belowDebug())
}
map.on('load', addFocusRouteLayers)

/** Read the URL and show what it names. Runs on first load and on Back/Forward. */
function applyUrl(): void {
  const q = new URLSearchParams(location.search)
  const vehicle = q.get('vehicle')
  const stop = q.get('stop')
  if (vehicle) {
    const v = vehicles.find(x => shortId(x.id) === vehicle || x.id === vehicle)
    void applyTarget({kind: 'vehicle', id: v?.id ?? vehicle})
  } else if (stop) {
    void applyTarget({kind: 'stop', id: stop, name: stationIndex.get(stop)?.name ?? 'Stop'})
  } else {
    clearDetail()
  }
}
window.addEventListener('popstate', applyUrl)
/** The URL is read once vehicles exist, and again on Back/Forward. */
let urlApplied = false

/*
 * Keep the open panel current.
 *
 * A vehicle panel re-renders on every poll — the delay changes, and the stop it is
 * approaching moves along the strip — but the stop list itself does not, so there
 * is no second request.
 *
 * A board has two clocks. Every 5 s it re-renders to tick its countdowns down from
 * times it already holds. Every 30 s it fetches the board again, because a delay
 * that grows, a cancellation, or a departure due later than the last look are all
 * new facts that no amount of counting down can produce.
 */
const BOARD_REFETCH_MS = 30000
let boardRefetching = false

/**
 * Fetch the open board again and swap in the new times, quietly.
 *
 * Quietly is the point, and it is why this is not `applyTarget`. That call rebuilds
 * the whole panel: it shows "Loading departures…" over a board you were reading, it
 * throws the scroll position back to the top, and it eases the map to the stop
 * again. Doing that every 30 s makes a live board unusable. `panel.updateBody`
 * keeps the header and the scroll position, so the only thing that changes is the
 * times.
 *
 * A failed refetch leaves the old board on screen. Stale times that keep counting
 * down are more use to someone waiting than an error page, and the next try is
 * 30 s away.
 */
async function refetchBoard(): Promise<void> {
  const t = detailTarget
  if (t?.kind !== 'stop' || boardRefetching) return
  const signal = detailAbort?.signal
  boardRefetching = true
  try {
    const board = await fetchStationBoard(t.id, 60, 30, signal)
    // the user may have moved on while this was in the air
    if (signal?.aborted || detailTarget?.kind !== 'stop' || detailTarget.id !== t.id) return
    detailBoard = board
    detailFetchedAt = Date.now()
    renderStopDetail()
  } catch (err) {
    if (signal?.aborted) return
    logError(`station board refresh failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    boardRefetching = false
  }
}

function refreshDetail(): void {
  if (detailTarget?.kind === 'vehicle') renderVehicleDetail()
  else if (detailTarget?.kind === 'stop') {
    renderStopDetail()
    if (Date.now() - detailFetchedAt > BOARD_REFETCH_MS) void refetchBoard()
  }
}
setInterval(() => { if (panel.isOpen) refreshDetail() }, 5000)
setInterval(() => { if (panel.isOpen) updateStripMarker() }, 250)

// ─────────── search: stops and lines, as you type ───────────
//
// Runs over data already in memory — 672 stations from stations.json and the lines
// currently running — so there is no request, no debounce and no spinner. Typing
// and results happen in the same frame.
//
// A stop result opens its departure board. A line result narrows the map to that
// line, which is the thing you wanted if you typed "M10".

const searchBox = document.createElement('div')
searchBox.id = 'search'
const searchInput = document.createElement('input')
searchInput.type = 'search'
searchInput.id = 'search-input'
searchInput.placeholder = 'Search a stop or line'
searchInput.setAttribute('aria-label', 'Search a stop or line')
searchInput.autocomplete = 'off'
const searchResults = document.createElement('ul')
searchResults.id = 'search-results'
searchResults.setAttribute('role', 'listbox')
searchResults.hidden = true
searchBox.append(searchInput, searchResults)
document.body.append(searchBox)

/**
 * Show only this line, and frame all of it.
 *
 * Narrowing the filter without moving the map leaves you looking at an empty
 * street while the line you asked for runs somewhere off-screen. So fit every
 * vehicle of it, with padding for whatever is on top of the map.
 */
function focusLine(hit: {line: string; product: Product; key: string}): void {
  // A panel about some other vehicle or stop is stale now, and its vehicle may be
  // about to be filtered off the map underneath it.
  if (panel.isOpen) closeDetail()
  filters[hit.product] = true
  lineMode = 'custom'
  lineFilter = new Set([hit.key])
  rebuildTypes()
  rebuildLines()
  render()

  const on = vehicles.filter(v => lineKey(v) === hit.key)
  if (on.length === 0) return
  // Room for the search box above, and for the panel if it is open.
  const compact = Panel.isCompact
  const box = panel.occupies
  const padding = {
    top: 70,
    bottom: compact && box ? Math.round(innerHeight - box.top) + 20 : 40,
    left: !compact && box ? Math.round(box.right) + 20 : 40,
    right: 40
  }
  if (on.length === 1) {
    map.easeTo({center: [on[0].lon, on[0].lat], zoom: Math.max(map.getZoom(), 13), duration: 700})
    return
  }
  let west = 180, east = -180, south = 90, north = -90
  for (const v of on) {
    west = Math.min(west, v.lon); east = Math.max(east, v.lon)
    south = Math.min(south, v.lat); north = Math.max(north, v.lat)
  }
  // maxZoom matters: two vehicles a street apart would otherwise fill the screen
  // with one block and no sense of the line.
  map.fitBounds([[west, south], [east, north]], {padding, maxZoom: 14, duration: 700})
}

function closeSearch(): void {
  searchResults.hidden = true
  searchResults.replaceChildren()
}

function runSearch(): void {
  const hits = search(searchInput.value, [...stationIndex].map(([id, v]) => ({id, name: v.name})), liveLines.values())
  if (hits.length === 0) {
    if (searchInput.value.trim().length === 0) { closeSearch(); return }
    searchResults.hidden = false
    const none = document.createElement('li')
    none.className = 'search-none'
    none.textContent = 'Nothing found'
    searchResults.replaceChildren(none)
    return
  }
  searchResults.hidden = false
  const rows = hits.map(hit => {
    const li = document.createElement('li')
    li.className = 'search-hit'
    li.setAttribute('role', 'option')
    li.tabIndex = -1
    const tag = document.createElement('span')
    tag.className = 'search-tag'
    if (hit.kind === 'line') {
      const bg = lineColors[hit.line] ?? PRODUCT_COLORS[hit.product]
      tag.style.background = bg
      tag.style.color = textOn(bg)
      tag.textContent = hit.line
      li.append(tag, label(PRODUCT_LABELS[hit.product], 'search-kind'))
      li.onclick = () => { focusLine(hit); done() }
    } else {
      tag.classList.add('is-stop')
      tag.textContent = '◎'
      tag.setAttribute('aria-hidden', 'true')
      li.append(tag, label(hit.name, 'search-name'))
      li.onclick = () => { showStop(hit.id, hit.name); done() }
    }
    return li
  })
  searchResults.replaceChildren(...rows)

  function done(): void {
    searchInput.value = ''
    searchInput.blur()
    closeSearch()
  }
  function label(text: string, cls: string): HTMLElement {
    const el = document.createElement('span')
    el.className = cls
    el.textContent = text
    return el
  }
}

searchInput.oninput = runSearch
searchInput.onfocus = () => { if (searchInput.value) runSearch() }
searchInput.onkeydown = e => {
  if (e.key === 'Escape') { searchInput.value = ''; closeSearch(); searchInput.blur() }
  // Enter takes the top hit, which is what a list ranked by relevance is for
  if (e.key === 'Enter') {
    const first = searchResults.querySelector('.search-hit') as HTMLElement | null
    first?.click()
  }
}
/*
 * Tapping the map puts the map back in charge: the search list closes, and so does
 * the panel. A sheet covering most of a phone screen needs a way out that is not a
 * 44 px button in the corner.
 *
 * But a tap on a station dot must open its board, not dismiss — and MapLibre fires
 * BOTH the layer handler and the general one for the same tap, in an order that is
 * not guaranteed.
 *
 * The first attempt asked `queryRenderedFeatures` whether the tap had hit
 * anything. That failed in practice: station hit circles are 10-16 px and Berlin's
 * stations are dense, so a probe at four unrelated points found station features at
 * every one of them, and the panel could never be dismissed. So the layer handlers
 * simply declare that they dealt with it, and the dismissal waits a tick to hear
 * that — which works whichever order the two handlers run in.
 */
let mapTapHandled = false
const markMapTapHandled = (): void => { mapTapHandled = true }

map.on('click', () => {
  closeSearch()
  setTimeout(() => {
    if (!mapTapHandled && panel.isOpen) closeDetail()
    mapTapHandled = false
  }, 0)
})

// --- polling with client-side backoff ---
let nextDelay = POLL_INTERVAL_MS
let failures = 0
let controller: AbortController | null = null
let inFlight = false
/** The one pending poll. Replacing it, never adding, keeps a single loop. */
let pollTimer: ReturnType<typeof setTimeout> | undefined
const schedule = (delay: number) => {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(() => void poll(), delay)
}
async function poll() {
  /*
   * Nothing is drawn in a hidden tab, so nothing needs fetching.
   *
   * With every mode on, a poll moves about 2.2 MB, so a forgotten background tab
   * would pull roughly 6 MB a minute for no viewer. The animation loop already
   * stops on its own — the browser does not run rAF in a hidden tab — so this is
   * the other half of the same idea. Becoming visible polls at once, and until it
   * answers the status bar says how old the data is.
   */
  if (document.hidden) {
    schedule(POLL_INTERVAL_MS)
    return
  }
  if (inFlight) return // a visibility change can ask while one is already running
  inFlight = true
  controller = new AbortController()
  const t = setTimeout(() => controller!.abort(), 15000)
  try {
    // every mode, fetched as several product groups because one request is capped
    const sweep = await fetchAllVehicles(BERLIN_BBOX, 2000, controller.signal)
    vehicles = sweep.vehicles
    capped = sweep.capped
    if (capped.length > 0) {
      logError(`feed capped at ${JNY_CAP} journeys for product mask ${capped.join(', ')} — some vehicles are missing`)
    }
    lastUpdate = Date.now()
    failures = 0
    nextDelay = POLL_INTERVAL_MS
    conn = 'live'
    // the menus offer exactly what is running, so refresh them from every poll
    updateLiveLines(vehicles)
    // A `?vehicle=` link can only be resolved once there are vehicles to resolve
    // it against, so the first poll is the earliest this can run.
    if (!urlApplied) { urlApplied = true; applyUrl() }
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
    nextDelay = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), MAX_BACKOFF_MS)
  } finally {
    clearTimeout(t)
    inFlight = false
    schedule(nextDelay)
  }
}

void poll()
// Coming back to the tab: refresh now rather than waiting out the interval.
// `schedule` replaces the pending timer instead of adding one, so this can never
// leave two poll loops running side by side.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  if (Date.now() - lastUpdate > POLL_INTERVAL_MS) schedule(0)
  // A hidden tab has its timers throttled to about one a minute, so an open panel
  // can come back showing countdowns a minute out of date. Put it right at once,
  // rather than leaving the wrong number on screen for another 5 s.
  if (panel.isOpen) refreshDetail()
})

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
 * Both menus list only what is running right now — see `liveLines`. There is no
 * point offering a line that cannot put a vehicle on the map.
 *
 * Both drive the same `filterVehicles(vehicles, filters, lineFilter)`. An empty
 * line set means NONE, not all, which is what lets "All lines" untick everything
 * the way "All types" does; `lineMode` carries "all" instead.
 *
 * The Line menu also has a search field, because with every mode on the network
 * runs about 260 lines at once and 187 of them are buses. Scrolling that list to
 * find one route is not a filter, it is a haystack.
 */

/**
 * The lines that are running right now, keyed by `lineKey` (mode AND name, never
 * the name alone — a rail replacement bus takes the name of the line it
 * replaces). Built from the live polls, and from nothing else.
 *
 * It used to be seeded from tracks.json, which listed all 190 lines in the
 * network. Most of them select nothing: a Sunday morning has about 90 lines out,
 * and a night has far fewer, so the menu was mostly dead entries and you could
 * not tell which was which.
 */
const liveLines = new Map<string, LineSighting>()

/**
 * Keep a line in the menu this long after its last sighting.
 *
 * Without it the menu would rebuild whenever one poll missed a line's only
 * vehicle, and rows would move under the pointer. Six polls of silence is a line
 * that has really stopped.
 */
const LINE_LINGER_MS = 60000

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

/*
 * The Line menu is a fixed search field over a rebuilt list.
 *
 * The list has to be replaced on every tick (the master box, the group headings
 * and the captions all change), and replacing the search field with it would
 * take the focus and the caret away mid-word. So the field lives outside the
 * part that gets rebuilt.
 */
const lineSearch = document.createElement('input')
lineSearch.type = 'search'
lineSearch.className = 'multi-search'
lineSearch.placeholder = 'search lines'
lineSearch.setAttribute('aria-label', 'Search lines')
const lineList = document.createElement('div')
lineList.className = 'multi-list'
lineUi.body.append(lineSearch, lineList)
lineSearch.oninput = () => rebuildLines()
/** Rows the search field allows through. Empty query matches everything. */
const matchesSearch = (name: string): boolean =>
  name.toLowerCase().includes(lineSearch.value.trim().toLowerCase())

/** Types with a line running now, in the order PRODUCT_LABELS declares them. */
const presentTypes = (): Product[] => {
  const have = new Set([...liveLines.values()].map(e => e.product))
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
  const types = presentTypes()
  const on = types.filter(p => filters[p])
  if (on.length === 0) return 'none'
  if (on.length === types.length) return 'all'
  // seven modes named in full overflow the panel, so switch to a count
  return on.length <= 2 ? on.map(p => PRODUCT_LABELS[p]).join(', ') : `${on.length} types`
}

/** Lines that could be shown right now: running, and of a ticked type. Keys. */
const selectableLines = (): LineSighting[] =>
  [...liveLines.values()].filter(e => filters[e.product])

function describeLines(): string {
  if (lineMode === 'all') return 'all'
  // count only what the menu offers: a line the user picked can stop running,
  // and it stays in the selection so it returns ticked, but naming it here would
  // report vehicles that are not on the map
  const picked = selectableLines().filter(e => lineFilter.has(lineKey(e)))
  if (picked.length === 0) return 'none'
  if (picked.length > 3) return `${picked.length} lines`
  return picked.map(e => e.line).sort(compareLineNames).join(', ')
}

/** A greyed line of explanation, for a menu that has nothing to offer yet. */
function hint(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'multi-hint'
  el.textContent = text
  return el
}

/** Shown until the first poll answers, and if the feed goes down before it does. */
const WAITING = 'waiting for live data…'

function rebuildTypes() {
  const types = presentTypes()
  if (types.length === 0) {
    typeUi.body.replaceChildren(hint(WAITING))
    typeUi.caption.textContent = '…'
    return
  }
  const allOn = types.every(p => filters[p])
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
  for (const key of [...lineFilter]) {
    const p = liveLines.get(key)?.product
    if (p && !filters[p]) lineFilter.delete(key)
  }
}

/** A line is ticked when the mode is `all`, or when it is in the selection. */
const lineTicked = (e: LineSighting): boolean => lineMode === 'all' || lineFilter.has(lineKey(e))

/** Move to an explicit selection, seeded from whatever is ticked right now. */
function makeSelectionExplicit() {
  if (lineMode === 'custom') return
  lineMode = 'custom'
  lineFilter = new Set(selectableLines().map(lineKey))
}

function rebuildLines() {
  const all = selectableLines()
  const query = lineSearch.value.trim()
  lineSearch.hidden = liveLines.size === 0
  if (all.length === 0) {
    // no line to offer: either no data yet, or every type is switched off
    lineList.replaceChildren(hint(liveLines.size === 0 ? WAITING : 'no type selected'))
    lineUi.caption.textContent = describeLines()
    return
  }
  const everyOne = all.every(lineTicked)
  lineList.replaceChildren(
    // Ticks and unticks every line, like "All types" does for the types. Before,
    // this only ticked itself: the selection meant "all" by being empty, so the
    // line boxes stayed blank and unticking it did nothing.
    //
    // It covers EVERY selectable line, not just the ones the search shows. A box
    // labelled "All lines" that quietly meant "the 4 lines matching bus" would be
    // a trap; the search narrows what you can see, not what this means.
    checkRow('All lines', everyOne, on => {
      if (on) {
        lineMode = 'all'
        lineFilter = new Set(all.map(lineKey))
      } else {
        lineMode = 'custom'
        lineFilter = new Set()
      }
      rebuildLines()
      render()
    })
  )
  let shown = 0
  for (const p of presentTypes()) {
    if (!filters[p]) continue // only offer lines you could actually see
    const group = [...liveLines.values()]
      .filter(e => e.product === p && matchesSearch(e.line))
      .sort((a, b) => compareLineNames(a.line, b.line))
    if (group.length === 0) continue
    const head = document.createElement('div')
    head.className = 'multi-group'
    head.textContent = `${PRODUCT_LABELS[p]} (${group.length})`
    lineList.append(head)
    for (const e of group) {
      shown++
      lineList.append(checkRow(e.line, lineTicked(e), on => {
        makeSelectionExplicit()
        if (on) lineFilter.add(lineKey(e))
        else lineFilter.delete(lineKey(e))
        // back to every line ticked: return to `all`, so a line added later joins
        if (all.every(x => lineFilter.has(lineKey(x)))) lineMode = 'all'
        rebuildLines()
        render()
      }))
    }
  }
  if (shown === 0) lineList.append(hint(`no line matches "${query}"`))
  lineUi.caption.textContent = describeLines()
}

/** Record the lines seen in a poll, and rebuild the menus if the list changed. */
function updateLiveLines(seen: Iterable<Vehicle>) {
  if (!recordLineSightings(liveLines, seen, Date.now(), LINE_LINGER_MS)) return
  rebuildTypes()
  rebuildLines()
}
rebuildTypes()
rebuildLines()

/** A checkbox that shows or hides one map layer, appended to `parent`. */
const toggleLayer = (layerId: string, name: string, on: boolean, parent: HTMLElement, also: string[] = []) => {
  const label = document.createElement('label')
  label.className = 'layer'
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = on
  const apply = () => {
    // `also` carries layers that belong to the same thing — the invisible circle
    // that takes taps for the station dots must hide with them, or an unticked
    // Stations layer would still swallow clicks.
    for (const id of [layerId, ...also]) {
      if (!map.getLayer(id)) continue // layers load async
      map.setLayoutProperty(id, 'visibility', cb.checked ? 'visible' : 'none')
    }
  }
  cb.onchange = apply
  map.on('idle', apply) // re-assert once the layer exists
  label.append(cb, ` ${name}`)
  parent.append(label)
  return cb
}
toggleLayer('routes-layer', 'Routes', true, filterEl)
toggleLayer('stations-layer', 'Stations', true, filterEl, ['stations-hit'])

// --- one Debug switch for the whole test overlay ---
// Four separate switches were confusing, and the network layers had none at all
// because their code sat commented out. Everything for testing now lives behind
// this one control: target dots, animated paths, vehicle IDs, the error panel and
// the motion recorder.
//
// The site is published, so a visitor should never meet these controls. They are
// added to the panel only in a DEV build, or when `?debug=1` asks for them — the
// hatch that lets the built site be diagnosed without shipping a test switch to
// everybody.
const DEBUG_KEY = 'liveberlin.debug'
const debugRequested = new URLSearchParams(location.search).has('debug')
/** Are the debug controls on screen at all? */
const DEBUG_AVAILABLE = import.meta.env.DEV || debugRequested
const debugGroup = document.createElement('div')
debugGroup.id = 'debug-group'

const debugLabel = document.createElement('label')
debugLabel.className = 'layer'
const debugCb = document.createElement('input')
debugCb.type = 'checkbox'
// The remembered setting only counts when the switch is on screen. Otherwise a
// visitor who ticked the box once — back when the published site offered it —
// would keep the overlay for good, with nothing to turn it off with.
debugCb.checked = DEBUG_AVAILABLE && (debugRequested || localStorage.getItem(DEBUG_KEY) === '1')
debugLabel.append(debugCb, ' Debug view')
if (DEBUG_AVAILABLE) filterEl.append(debugLabel, debugGroup)

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
  // do not overwrite a developer's preference from a build that cannot show it
  if (DEBUG_AVAILABLE) localStorage.setItem(DEBUG_KEY, on ? '1' : '0')
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

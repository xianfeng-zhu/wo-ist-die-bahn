import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './style.css'
import {fetchVehicles, BBox} from './hci.js'
import {Product, Vehicle} from './vehicle.js'
import {lineColors} from './line-colors.js'
import {enableSmoothWheelZoom} from './wheel-zoom.js'

const BERLIN_BBOX: BBox = {north: 52.68, west: 13.08, south: 52.34, east: 13.76}
const POLL_INTERVAL_MS = 20000
const MAX_BACKOFF_MS = 60000

const PRODUCT_COLORS: Record<Product, string> = {suburban: '#2e7d32', subway: '#1565c0', tram: '#c62828'}
const PRODUCT_LABELS: Record<Product, string> = {suburban: 'S-Bahn', subway: 'U-Bahn', tram: 'Tram'}

const map = L.map('map', {
  scrollWheelZoom: false, // replaced by enableSmoothWheelZoom below
  zoomSnap: 0
}).setView([52.52, 13.405], 12)
const tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map)
// During continuous fractional zoom (see wheel-zoom.ts), Leaflet fires `zoom`
// on every fractional step; the tile layer's `_resetView` then wipes and
// re-fetches all tiles, which shows as white flashing while scrolling. Keep
// the tiles (Leaflet scales them to the fractional zoom) for the whole
// gesture — including integer-level crossings and the fling glide — and
// refresh once when the gesture ends. (Monkeypatch of a private API — cast
// is deliberate, see ts-no-any.)
let zoomGestureActive = false
const tileInternals = tileLayer as unknown as {
  _tileZoom?: number
  _invalidateAll(): void
  _onMoveEnd(): void
  _update(center?: L.LatLng): void
  _updateLevels(): void
  _setZoomTransforms(center: L.LatLng, zoom: number): void
  _setView(center: L.LatLng, zoom: number, noPrune?: boolean, noUpdate?: boolean): void
}
const origInvalidateAll = tileInternals._invalidateAll.bind(tileLayer)
const origTileSetView = tileInternals._setView.bind(tileLayer)
const origTileOnMoveEnd = tileInternals._onMoveEnd.bind(tileLayer)
const origTileUpdate = tileInternals._update.bind(tileLayer)
// During a zoom gesture Leaflet fires `viewprereset`/`viewreset`/`moveend` on
// every (fractional) zoom step; each can wipe and re-fetch tiles
// (`_invalidateAll`, `_setView` → `_resetGrid`, `_update` → `_pruneTiles`),
// which shows as white flashing while scrolling. Keep the tiles and let
// Leaflet scale them to the fractional zoom; refresh once at gesture end.
// (Monkeypatch of a private API — casts are deliberate, see ts-no-any.)
tileInternals._invalidateAll = () => {
  if (zoomGestureActive) return
  origInvalidateAll()
}
// The layer's `viewprereset` handler was registered on the MAP at add-time
// (`map.on(getEvents(), layer)`), capturing the original prototype
// `_invalidateAll` — which wipes every tile. Instance patches can't reach
// that captured reference, and `off` needs the exact fn to remove it.
// (Unchecked cast: Leaflet's own private API shape.)
const protoInvalidateAll = (Object.getPrototypeOf(tileLayer) as {_invalidateAll(): void})._invalidateAll
map.off('viewprereset', protoInvalidateAll, tileLayer)
map.on('viewprereset', () => {
  if (zoomGestureActive) return
  protoInvalidateAll.call(tileLayer)
})
tileInternals._setView = (center, zoom, noPrune, noUpdate) => {
  if (!noUpdate && (zoomGestureActive || Math.round(zoom) === tileInternals._tileZoom)) {
    tileInternals._setZoomTransforms(center, zoom)
    return
  }
  origTileSetView(center, zoom, noPrune, noUpdate)
}
tileInternals._onMoveEnd = () => {
  if (zoomGestureActive) return
  origTileOnMoveEnd()
}
tileInternals._update = (center) => {
  if (zoomGestureActive) return
  origTileUpdate(center)
}
const refreshTiles = (): void => {
  // OpenLayers-style non-destructive settle: load the new integer zoom
  // level's tiles WITHOUT clearing the current ones (no `_abortLoading`, no
  // `_resetGrid` wipe) — old tiles stay visible while the new level loads,
  // so the settle never flashes white. Old tiles are retained by Leaflet's
  // own parent-tile pruning and pruned on the next regular update.
  const rounded = Math.round(map.getZoom())
  if (rounded === tileInternals._tileZoom) return // already settled
  tileInternals._tileZoom = rounded
  tileInternals._updateLevels()
  tileInternals._update(map.getCenter())
}
enableSmoothWheelZoom(map, {
  onGestureStart: () => {
    zoomGestureActive = true
  },
  onGestureEnd: () => {
    zoomGestureActive = false
    refreshTiles()
  }
})

const vehicleLayer = L.layerGroup().addTo(map)
const markers = new Map<string, L.Marker>()
const filters: Record<Product, boolean> = {suburban: true, subway: true, tram: true}
let vehicles: Vehicle[] = []
let lastUpdate = 0
let conn: 'live' | 'stale' | 'offline' = 'offline'

const statusEl = document.getElementById('statusbar')!
function updateStatus() {
  const ago = lastUpdate ? Math.round((Date.now() - lastUpdate) / 1000) : 0
  const count = vehicles.filter(v => filters[v.product]).length
  statusEl.textContent = `${conn} · ${count} vehicles · updated ${ago}s ago`
}
setInterval(updateStatus, 1000)

function badgeHtml(v: Vehicle): string {
  const color = lineColors[v.line] ?? PRODUCT_COLORS[v.product]
  return `<div class="veh" style="background:${color}">${v.line}</div>`
}

function render() {
  const visible = vehicles.filter(v => filters[v.product])
  const seen = new Set<string>()
  for (const v of visible) {
    seen.add(v.id)
    let m = markers.get(v.id)
    if (!m) {
      m = L.marker([v.lat, v.lon], {icon: L.divIcon({className: 'veh-icon', html: badgeHtml(v)})}).bindPopup('')
      m.addTo(vehicleLayer)
      markers.set(v.id, m)
    }
    m.setLatLng([v.lat, v.lon])
    m.setIcon(L.divIcon({className: 'veh-icon', html: badgeHtml(v)}))
    m.setPopupContent(
      `<b>${v.line}</b> ${PRODUCT_LABELS[v.product]}<br>→ ${v.direction}<br>next: ${v.nextStop ?? '—'}` +
      (v.delayMs != null ? `<br><span style="color:${v.delayMs >= 300000 ? '#c62828' : '#333'}">delay: ${Math.round(v.delayMs / 60000)} min</span>` : '')
    )
  }
  for (const [id, m] of markers) {
    if (!seen.has(id)) { m.remove(); markers.delete(id) }
  }
}

const stationLayer = L.layerGroup()
const routeLayer = L.layerGroup()
async function loadNetworkLayers() {
  try {
    const stations = await (await fetch('/stations.json')).json()
    L.geoJSON(stations, {
      pointToLayer: (_f, latlng) => L.circleMarker(latlng, {radius: 3, color: '#555', weight: 1, fillColor: '#888', fillOpacity: 0.8}),
      onEachFeature: (f, layer) => f.properties?.name && layer.bindPopup(f.properties.name)
    }).addTo(stationLayer)
  } catch (err) { console.warn('stations layer unavailable', err) }
  try {
    const routes = await (await fetch('/routes.json')).json()
    L.geoJSON(routes, {
      style: f => {
        const props = (f?.properties ?? {}) as Record<string, unknown>
        const line = typeof props.line === 'string' ? props.line : undefined
        const product = props.product === 'suburban' || props.product === 'subway' || props.product === 'tram' ? props.product : undefined
        return {color: (line ? lineColors[line] : undefined) ?? (product ? PRODUCT_COLORS[product] : undefined) ?? '#888', weight: 2, opacity: 0.75}
      }
    }).addTo(routeLayer)
  } catch (err) { console.warn('routes layer unavailable', err) }
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
    vehicles = await fetchVehicles(BERLIN_BBOX, 2000, controller.signal)
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
  cb.onchange = () => { filters[p] = cb.checked; render() }
  label.append(cb, ` ${PRODUCT_LABELS[p]}`, ` <span style="color:${PRODUCT_COLORS[p]}">●</span>`)
  modeRow.append(label)
})
filterEl.append(modeRow)
const toggleLayer = (name: string, layer: L.LayerGroup) => {
  const label = document.createElement('label')
  label.className = 'layer'
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = false
  cb.onchange = () => cb.checked ? layer.addTo(map) : layer.remove()
  label.append(cb, ` ${name}`)
  filterEl.append(label)
}
toggleLayer('Stations', stationLayer)
toggleLayer('Routes', routeLayer)

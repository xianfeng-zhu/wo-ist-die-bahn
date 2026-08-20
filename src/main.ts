import {Map as GLMap, Marker, Popup, setWorkerUrl, type MapLayerMouseEvent} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import {fetchVehicles, BBox} from './hci.js'
import {filterVehicles, Product, Vehicle} from './vehicle.js'
import {lineColors} from './line-colors.js'

// MapLibre loads its tile-processing worker from an external file relative to
// the module; Vite doesn't emit it, so point it at the copy we ship in
// public/ (see public/maplibre-gl-worker.mjs).
setWorkerUrl('/maplibre-gl-worker.mjs')

const BERLIN_BBOX: BBox = {north: 52.68, west: 13.08, south: 52.34, east: 13.76}
const POLL_INTERVAL_MS = 20000
const MAX_BACKOFF_MS = 60000

const PRODUCT_COLORS: Record<Product, string> = {suburban: '#2e7d32', subway: '#1565c0', tram: '#c62828'}
const PRODUCT_LABELS: Record<Product, string> = {suburban: 'S-Bahn', subway: 'U-Bahn', tram: 'Tram'}

// MapLibre GL: native smooth trackpad zoom, WebGL tile rendering (no white
// flashing, no tile-management gaps), tile overscaling capped by the engine.
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
  center: [13.405, 52.52],
  zoom: 12,
  maxZoom: 19
})

// --- vehicle markers (line-labeled badges) ---
const markers = new Map<string, Marker>()
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

function render() {
  const visible = filterVehicles(vehicles, filters)
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
    } else {
      m.setLngLat([v.lon, v.lat])
      m.getPopup()?.setHTML(popupHtml(v))
    }
  }
  for (const [id, m] of markers) {
    if (!seen.has(id)) {
      m.remove()
      markers.delete(id)
    }
  }
  updateStatus()
}

// --- station + route layers (GeoJSON, toggleable) ---
async function loadNetworkLayers() {
  try {
    const stations = await (await fetch('/stations.json')).json()
    map.addSource('stations', {type: 'geojson', data: stations})
    map.addLayer({
      id: 'stations-layer',
      type: 'circle',
      source: 'stations',
      paint: {'circle-radius': 3, 'circle-color': '#888', 'circle-stroke-color': '#555', 'circle-stroke-width': 1}
    })
    map.on('click', 'stations-layer', (e: MapLayerMouseEvent) => {
      const name = e.features?.[0]?.properties?.name
      if (name) {
        new Popup({offset: 10}).setLngLat(e.lngLat).setHTML(String(name)).addTo(map)
      }
    })
    map.on('mouseenter', 'stations-layer', () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', 'stations-layer', () => { map.getCanvas().style.cursor = '' })
  } catch (err) {
    console.warn('stations layer unavailable', err)
  }
  try {
    const routes = await (await fetch('/routes.json')).json()
    for (const f of routes.features ?? []) {
      const line = f.properties?.line
      const product = f.properties?.product as Product | undefined
      f.properties = {...f.properties, color: lineColors[line] ?? (product ? PRODUCT_COLORS[product] : undefined) ?? '#888'}
    }
    map.addSource('routes', {type: 'geojson', data: routes})
    map.addLayer({
      id: 'routes-layer',
      type: 'line',
      source: 'routes',
      paint: {'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.75}
    })
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
  cb.onchange = () => {
    filters[p] = cb.checked
    render()
  }
  label.append(cb, ` ${PRODUCT_LABELS[p]}`, ` <span style="color:${PRODUCT_COLORS[p]}">●</span>`)
  modeRow.append(label)
})
filterEl.append(modeRow)

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
toggleLayer('stations-layer', 'Stations')
toggleLayer('routes-layer', 'Routes')

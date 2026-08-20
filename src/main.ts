import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './style.css'
import {fetchVehicles, BBox} from './hci.js'
import {Product, Vehicle} from './vehicle.js'
import {lineColors} from './line-colors.js'

const BERLIN_BBOX: BBox = {north: 52.68, west: 13.08, south: 52.34, east: 13.76}
const POLL_INTERVAL_MS = 20000
const MAX_BACKOFF_MS = 60000

const PRODUCT_COLORS: Record<Product, string> = {suburban: '#2e7d32', subway: '#1565c0', tram: '#c62828'}
const PRODUCT_LABELS: Record<Product, string> = {suburban: 'S-Bahn', subway: 'U-Bahn', tram: 'Tram'}

const mapOptions: L.MapOptions & {smoothWheelZoom?: boolean} = {
  smoothWheelZoom: true,
  zoomSnap: 0,
  wheelPxPerZoomLevel: 60
}
const map = L.map('map', mapOptions).setView([52.52, 13.405], 12)
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map)

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

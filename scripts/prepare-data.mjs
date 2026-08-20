// One-off data prep: VBB GTFS + line colors -> committed static assets.
// Refresh (GTFS updates 2x weekly): npm run prepare:data
//
// Real-data findings (inspected 2026-08-20, VBB GTFS + linienfarben):
// - VBB GTFS does NOT use the standard GTFS route_type values (0 tram / 1 subway / 2 rail).
//   It uses VBB-extended values (routes.txt column "route_type"):
//     109 = S-Bahn   (S1..S9, S15, S25, S26, S41, S42, S46, S47, S75, S85) — restricted to
//                     S-Bahn Berlin GmbH (agency 1); 109 also lists DB Regio S-lines (Leipzig
//                     S4, an S1 variant to Stendal) that are NOT Berlin rail and are excluded
//     400 = U-Bahn   (U1..U9, U12; operator BVG only)
//     900 = tram     (all tram operators; Berlin lines restricted to BVG agency 796)
//     100 = regional express (RE/FEX), 106 = regional (RB), 700 = bus, 3 = bus, 1000 = ferry
// - S-Bahn vs regional: distinguished by route_type 109 (regional uses 100/106) — no name regex needed.
// - linienfarben CSV (20260428-linienfarben.csv): ';'-separated, ISO-8859-1 encoded.
//   Column 0 = line name ("Linie"), column 10 = "background_Hex" (#RRGGBB). No per-tram-line
//   colors — only a generic "Tram" row — so M-lines fall back to product colors in the UI.
import {createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs'
import {createInterface} from 'node:readline'
import {execSync} from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const TMP = mkdtempSync(path.join(os.tmpdir(), 'vbb-'))
const run = c => execSync(c, {stdio: 'inherit', cwd: TMP})

const GTFS = path.join(TMP, 'gtfs')
const LF = path.join(TMP, 'lf')

// --- minimal CSV parsing (quoted fields, "" escapes) ---
function parseCsv(text) {
  const rows = []
  let row = [], field = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false
      } else field += c
    } else if (c === '"') inQ = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

function parseLine(line) {
  const fields = []
  let field = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++ } else inQ = false
      } else field += c
    } else if (c === '"') inQ = true
    else if (c === ',') { fields.push(field); field = '' }
    else field += c
  }
  fields.push(field)
  return fields
}

async function streamLines(file, onLine) {
  const rl = createInterface({input: createReadStream(file), crlfDelay: Infinity})
  let header = null
  for await (const line of rl) {
    if (header === null) { header = parseLine(line); continue }
    onLine(line, header)
  }
  return header
}

try {
  console.log('downloading GTFS + line colors…')
  run(`curl -sL -o vbb.zip https://unternehmen.vbb.de/gtfs`)
  run(`unzip -o -q vbb.zip -d gtfs`)
  run(`curl -sL -o lf.zip https://unternehmen.vbb.de/fileadmin/user_upload/VBB/Dokumente/API-Datensaetze/linienfarben.zip`)
  run(`unzip -o -q lf.zip -d lf`)

  // ---- routes.txt: rail routes (route_id -> {shortName, product}) ----
  const routesText = readFileSync(path.join(GTFS, 'routes.txt'), 'utf8')
  const routeRows = parseCsv(routesText)
  const railRoutes = new Map() // route_id -> {shortName, product}
  for (const r of routeRows.slice(1)) {
    const [routeId, agencyId, shortName, , routeType] = r
    let product = null
    // S-Bahn: type 109 restricted to S-Bahn Berlin GmbH (agency 1) — the feed also lists
    // DB Regio S-lines under 109 (Leipzig S4, an S1 variant to Stendal) that are not Berlin rail.
    if (routeType === '109' && agencyId === '1') product = 'suburban'
    else if (routeType === '400') product = 'subway' // U-Bahn (BVG only)
    else if (routeType === '900' && agencyId === '796') product = 'tram' // BVG Berlin trams
    if (product && shortName) railRoutes.set(routeId, {shortName, product})
  }
  console.log(`rail routes (route_id): ${railRoutes.size} (lines: ${new Set([...railRoutes.values()].map(v => v.shortName)).size})`)

  // ---- trips.txt: rail trip_id -> {routeId, shapeId}; routeId -> trips ----
  const tripsText = readFileSync(path.join(GTFS, 'trips.txt'), 'utf8')
  const railTrips = new Map() // trip_id -> routeId
  const routeTrips = new Map() // route_id -> [{tripId, shapeId}]
  for (const t of parseCsv(tripsText).slice(1)) {
    const [routeId, , tripId, , , , , shapeId] = t
    if (!railRoutes.has(routeId)) continue
    railTrips.set(tripId, routeId)
    const list = routeTrips.get(routeId) ?? []
    list.push({tripId, shapeId})
    routeTrips.set(routeId, list)
  }
  console.log(`rail trips: ${railTrips.size}`)

  // ---- shapes.txt (180 MB) + stop_times.txt (440 MB), streamed in parallel ----
  const neededShapes = new Set()
  for (const list of routeTrips.values()) for (const t of list) if (t.shapeId) neededShapes.add(t.shapeId)
  console.log(`needed shapes: ${neededShapes.size}`)

  const shapePts = new Map() // shape_id -> [[lat, lon], …] (ordered by sequence)
  const railStopIds = new Set()

  const parseShapes = () => streamLines(path.join(GTFS, 'shapes.txt'), line => {
    if (line[0] === '"') return // header-ish/quoted safety; data rows are unquoted
    const comma = line.indexOf(',')
    const shapeId = comma === -1 ? line : line.slice(0, comma)
    if (!neededShapes.has(shapeId)) return
    const f = parseLine(line)
    const pts = shapePts.get(shapeId)
    const pt = [Number(f[1]), Number(f[2])]
    if (pts) pts.push(pt)
    else shapePts.set(shapeId, [pt])
  })

  const parseStopTimes = () => streamLines(path.join(GTFS, 'stop_times.txt'), line => {
    const comma = line.indexOf(',')
    if (comma === -1) return
    const tripId = line.slice(0, comma)
    if (!railTrips.has(tripId)) return
    const f = parseLine(line)
    railStopIds.add(f[1]) // stop_id
  })

  await Promise.all([parseShapes(), parseStopTimes()])
  console.log(`rail stops (stop_id): ${railStopIds.size}`)

  // ---- stops.txt: stop_id -> {name, lat, lon} ----
  const stopsText = readFileSync(path.join(GTFS, 'stops.txt'), 'utf8')
  const stopById = new Map()
  for (const s of parseCsv(stopsText).slice(1)) {
    if (!railStopIds.has(s[0])) continue
    stopById.set(s[0], {name: s[2], lat: Number(s[4]), lon: Number(s[5])})
  }
  console.log(`rail stops with coords: ${stopById.size}`)

  // ---- routes.json: one LineString per line name, from the longest shape ----
  const lineBest = new Map() // shortName -> {product, pts}
  for (const [routeId, {shortName, product}] of railRoutes) {
    for (const t of routeTrips.get(routeId) ?? []) {
      const pts = t.shapeId ? shapePts.get(t.shapeId) : undefined
      if (!pts || pts.length < 2) continue
      const cur = lineBest.get(shortName)
      if (!cur || pts.length > cur.pts.length) lineBest.set(shortName, {product, pts})
    }
  }

  const decimate = (pts, max) => {
    if (pts.length <= max) return pts
    const step = (pts.length - 1) / (max - 1)
    const out = []
    for (let i = 0; i < max; i++) out.push(pts[Math.round(i * step)])
    return out
  }

  const routeFeatures = []
  for (const [line, {product, pts}] of [...lineBest.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const deduped = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1])
    const kept = decimate(deduped, 500)
    routeFeatures.push({
      type: 'Feature',
      geometry: {type: 'LineString', coordinates: kept.map(([lat, lon]) => [lon, lat])},
      properties: {line, product}
    })
  }

  // ---- stations.json: Point per rail stop ----
  const stationFeatures = [...stopById.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([stopId, s]) => ({
      type: 'Feature',
      geometry: {type: 'Point', coordinates: [s.lon, s.lat]},
      properties: {name: s.name}
    }))

  const routesJson = {type: 'FeatureCollection', features: routeFeatures}
  const stationsJson = {type: 'FeatureCollection', features: stationFeatures}

  // ---- src/line-colors.ts: linienfarben CSV (';'-separated, latin1) ----
  const lfFile = readFileSync(path.join(LF, readdirSync(LF).find(f => f.endsWith('.csv'))), 'latin1')
  const lfRows = lfFile.split(/\r?\n/).filter(l => l.length > 0).map(l => l.split(';'))
  const lfHeader = lfRows[0]
  const nameCol = lfHeader.indexOf('Linie')
  const hexCol = lfHeader.indexOf('background_Hex')
  // Keep only colors for lines the app renders (rail lines + the generic Tram entry);
  // regional/bus/ferry rows are unused by liveberlin.
  const railNames = new Set(routeFeatures.map(f => f.properties.line))
  const colorEntries = []
  for (const row of lfRows.slice(1)) {
    const name = row[nameCol]?.trim()
    const hex = (row[hexCol] ?? '').trim().toUpperCase()
    if (name && /^#[0-9A-F]{6}$/.test(hex) && (railNames.has(name) || name === 'Tram')) {
      colorEntries.push([name, hex])
    }
  }
  const colorsTs = [
    '// Generated by scripts/prepare-data.mjs from VBB linienfarben CSV.',
    '// Line name -> official color (CSS hex). Missing lines fall back to product colors in the UI.',
    `export const lineColors: Record<string, string> = {`,
    ...colorEntries.map(([n, h]) => `  ${JSON.stringify(n)}: '${h}',`),
    `}`
  ].join('\n') + '\n'

  // ---- sanity gates (BEFORE any write: never overwrite committed assets with bad data) ----
  const lineNames = routeFeatures.map(f => f.properties.line)
  const bad = lineNames.filter(n => /^(RE|RB|FEX|ICE)/.test(n))
  const tramLines = lineNames.filter(n => lineBest.get(n).product === 'tram')
  const missingU = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9'].filter(n => !lineNames.includes(n))
  const checks = [
    ['stations in low thousands', stationFeatures.length >= 500 && stationFeatures.length <= 15000],
    ['routes 40-60', routeFeatures.length >= 40 && routeFeatures.length <= 60],
    ['no RE/RB/FEX/ICE routes', bad.length === 0],
    ['S41/S42 present', lineNames.includes('S41') && lineNames.includes('S42')],
    ['U1-U9 present', missingU.length === 0],
    ['trams present (>=10)', tramLines.length >= 10]
  ]
  for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (checks.some(([, ok]) => !ok)) {
    console.error('sanity gates failed — outputs were not written, fix inputs/filter')
    process.exitCode = 1
  } else {
    mkdirSync('public', {recursive: true})
    writeFileSync(path.join('public', 'stations.json'), JSON.stringify(stationsJson))
    writeFileSync(path.join('public', 'routes.json'), JSON.stringify(routesJson))
    writeFileSync(path.join('src', 'line-colors.ts'), colorsTs)
    console.log(`stations: ${stationFeatures.length} · routes: ${routeFeatures.length} · lineColors: ${colorEntries.length}`)
    console.log('sample lines:', lineNames.filter(n => ['S41', 'S42', 'U1', 'U9', 'M1', 'M10', '12'].includes(n)).join(', '))
  }
} finally {
  rmSync(TMP, {recursive: true, force: true})
  console.log('cleaned up tmp:', TMP)
}

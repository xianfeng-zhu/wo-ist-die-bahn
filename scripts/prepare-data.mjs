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
import zlib from 'node:zlib'
import {simplifyPath} from './simplify.mjs'
import {corridorKey, isContainedIn, pathMetres as shapeMetres} from './variants.mjs'

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

  // ---- inventory report: how many distinct variants per line, and at what cost? ----
  // Writes nothing. Payload size is the deciding constraint for shipping every
  // variant, so measure it before changing any output.
  {
    const perLine = new Map() // shortName -> Set(shapeId)
    for (const [routeId, {shortName}] of railRoutes) {
      for (const t of routeTrips.get(routeId) ?? []) {
        if (!t.shapeId || !shapePts.has(t.shapeId)) continue
        if (!perLine.has(shortName)) perLine.set(shortName, new Set())
        perLine.get(shortName).add(t.shapeId)
      }
    }
    const counts = [...perLine].map(([l, s]) => [l, s.size]).sort((a, b) => b[1] - a[1])
    const totalShapes = counts.reduce((n, [, c]) => n + c, 0)
    let rawPts = 0
    let simpPts = 0
    for (const s of perLine.values()) {
      for (const id of s) {
        const pts = shapePts.get(id)
        rawPts += pts.length
        simpPts += simplifyPath(pts, 10).length
      }
    }
    console.log(`\n--- shape inventory`)
    console.log(`  distinct shapes across rail lines: ${totalShapes} (across ${perLine.size} lines)`)
    console.log(`  points: ${rawPts.toLocaleString('en-US')} raw -> ${simpPts.toLocaleString('en-US')} simplified at 10 m`)
    console.log(`  most variants: ${counts.slice(0, 8).map(([l, c]) => `${l}:${c}`).join('  ')}`)
    console.log(`  median variants per line: ${counts[Math.floor(counts.length / 2)]?.[1]}\n`)
  }

  // ---- routes.json: every distinct route variant per line ----
  // One shape per line NAME was the old behaviour and the root cause of the
  // runtime fit guards in main.ts: branch variants (S1, M5, tram 12) and the two
  // ring directions (S41/S42) do not share geometry, so projecting a vehicle
  // onto the wrong one landed it up to 6.5 km away. Ship them all; the runtime
  // picks by forecast fit (see track.ts pickShape).
  //
  // GTFS has 2,179 distinct rail shape_ids, far too many to ship (117k points
  // simplified). Most are the same corridor recorded per service pattern, so
  // collapse by corridor first, then cap.
  const SIMPLIFY_M = 10
  // A backstop, not a truncation: pruning contained variants already brings every
  // line under it (worst is M4 at 20), and all 264 cost 37 KB gzipped. Before
  // pruning, 41 of 48 lines hit a cap of 12 and real branch geometry was lost.
  const MAX_VARIANTS_PER_LINE = 24
  const CONTAINED_TOL_M = 50

  const lineVariants = new Map() // shortName -> {product, corridors: Map(key -> pts)}
  const seenShapeIds = new Set()
  for (const [routeId, {shortName, product}] of railRoutes) {
    for (const t of routeTrips.get(routeId) ?? []) {
      const raw = t.shapeId ? shapePts.get(t.shapeId) : undefined
      if (!raw || raw.length < 2) continue
      if (seenShapeIds.has(t.shapeId)) continue // once per shape_id, not per trip
      seenShapeIds.add(t.shapeId)
      const deduped = raw.filter((p, i) => i === 0 || p[0] !== raw[i - 1][0] || p[1] !== raw[i - 1][1])
      if (deduped.length < 2) continue
      const pts = simplifyPath(deduped, SIMPLIFY_M)
      if (!lineVariants.has(shortName)) lineVariants.set(shortName, {product, corridors: new Map()})
      const c = lineVariants.get(shortName).corridors
      const key = corridorKey(pts)
      // Rank by METRES, not point count. After Douglas-Peucker, point count
      // tracks curviness, not length: the two disagreed on 14% of pairs, and
      // S7's 48 km full-line variant has only 117 points -- it survived at rank
      // 11 of 12, one slot from being dropped and stranding its own subsets.
      const cur = c.get(key)
      if (!cur || shapeMetres(pts) > shapeMetres(cur)) c.set(key, pts)
    }
  }

  const toFeature = (line, product, pts) => ({
    type: 'Feature',
    geometry: {type: 'LineString', coordinates: pts.map(([lat, lon]) => [lon, lat])},
    properties: {line, product}
  })

  const sortedLines = [...lineVariants.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const corridorTotal = sortedLines.reduce((n, [, v]) => n + v.corridors.size, 0)

  // Drop any variant that runs entirely along a longer one. It can tell a vehicle
  // nothing the longer variant cannot, and shipping both is what made pickShape's
  // choice ambiguous: 365 of 533 shipped variants were contained this way, each
  // simplified independently so their vertices differ by sub-metre amounts, so
  // residuals tied to float noise and the chosen path flipped between polls.
  let contained = 0
  const keptPerLine = new Map()
  for (const [line, {corridors}] of sortedLines) {
    const byLength = [...corridors.values()].sort((a, b) => shapeMetres(b) - shapeMetres(a))
    const keep = []
    for (const pts of byLength) {
      if (keep.some(longer => isContainedIn(pts, longer, CONTAINED_TOL_M))) { contained++; continue }
      keep.push(pts)
    }
    keptPerLine.set(line, keep)
  }
  const keptTotal = [...keptPerLine.values()].reduce((n, k) => n + k.length, 0)
  console.log(`--- variants: ${seenShapeIds.size} shape_ids -> ${corridorTotal} corridors -> ${keptTotal} after dropping ${contained} contained in a longer one`)
  const worstLines = [...keptPerLine].map(([l, k]) => [l, k.length]).sort((a, b) => b[1] - a[1])
  console.log(`  most variants: ${worstLines.slice(0, 8).map(([l, c]) => `${l}:${c}`).join('  ')}`)

  // Cost at several caps, so the cap can be retuned without another 600 MB download.
  const buildAt = cap => {
    const out = []
    for (const [line, keep] of keptPerLine) {
      const product = lineVariants.get(line).product
      for (const pts of keep.slice(0, cap)) out.push(toFeature(line, product, pts))
    }
    return out
  }
  console.log(`  cap  variants   raw KB   gzip KB`)
  for (const cap of [4, 8, 12, 16, 9999]) {
    const f = buildAt(cap)
    const json = JSON.stringify({type: 'FeatureCollection', features: f})
    console.log(`  ${String(cap === 9999 ? 'all' : cap).padStart(4)} ${String(f.length).padStart(9)} ${String(Math.round(Buffer.byteLength(json) / 1024)).padStart(8)} ${String(Math.round(zlib.gzipSync(json).length / 1024)).padStart(9)}`)
  }

  const routeFeatures = buildAt(MAX_VARIANTS_PER_LINE)
  const atCap = worstLines.filter(([, c]) => c > MAX_VARIANTS_PER_LINE)
  console.log(`route variants shipped: ${routeFeatures.length} (cap ${MAX_VARIANTS_PER_LINE} per line)`)
  console.log(`  lines still at the cap: ${atCap.length}${atCap.length ? ' -> ' + atCap.map(([l, c]) => `${l}:${c}`).join(' ') : ''}`)

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
  // routeFeatures now holds several variants per line, so line-level checks work
  // on the distinct set while size checks work on the whole payload.
  const lineNames = [...new Set(routeFeatures.map(f => f.properties.line))]
  const bad = lineNames.filter(n => /^(RE|RB|FEX|ICE)/.test(n))
  const tramLines = lineNames.filter(n => lineVariants.get(n).product === 'tram')
  const missingU = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9'].filter(n => !lineNames.includes(n))
  const routesOut = JSON.stringify(routesJson)
  const routesGz = zlib.gzipSync(routesOut).length
  // Gates need FLOORS, not just ceilings. Collapsing every shape to its two
  // endpoints -- the symptom of a units or tolerance bug in SIMPLIFY_M or the
  // distance metric -- passed every previous gate at 4.7 KB against a real 54 KB,
  // and would have shipped 533 straight chords.
  const allCoords = routeFeatures.flatMap(f => f.geometry.coordinates)
  const inBerlin = ([lon, lat]) => Number.isFinite(lat) && Number.isFinite(lon) &&
    lat > 51.8 && lat < 53.2 && lon > 12.5 && lon < 14.5
  const meanPts = allCoords.length / Math.max(1, routeFeatures.length)
  const checks = [
    ['stations in low thousands', stationFeatures.length >= 500 && stationFeatures.length <= 15000],
    ['lines 40-60', lineNames.length >= 40 && lineNames.length <= 60],
    ['route variants 60-900', routeFeatures.length >= 60 && routeFeatures.length <= 900],
    ['shapes carry real geometry (mean >=15 pts)', meanPts >= 15],
    ['routes.json 20-250 KB gzipped', routesGz >= 20 * 1024 && routesGz <= 250 * 1024],
    ['all coordinates finite and inside Berlin', allCoords.every(inBerlin)],
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
    writeFileSync(path.join('public', 'routes.json'), routesOut)
    writeFileSync(path.join('src', 'line-colors.ts'), colorsTs)
    console.log(`stations: ${stationFeatures.length} · route variants: ${routeFeatures.length} across ${lineNames.length} lines · lineColors: ${colorEntries.length}`)
    console.log(`routes.json: ${Math.round(Buffer.byteLength(routesOut) / 1024)} KB raw / ${Math.round(routesGz / 1024)} KB gzipped`)
    const per = {}
    for (const f of routeFeatures) per[f.properties.line] = (per[f.properties.line] ?? 0) + 1
    console.log('variants for:', ['S41', 'S42', 'S1', 'U1', 'U9', 'M5', 'M10', '12'].map(n => `${n}:${per[n] ?? 0}`).join('  '))
  }
} finally {
  rmSync(TMP, {recursive: true, force: true})
  console.log('cleaned up tmp:', TMP)
}

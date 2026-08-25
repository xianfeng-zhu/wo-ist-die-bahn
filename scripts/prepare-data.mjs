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
import {mergeToTracks} from './tracks.mjs'

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
  const MAX_VARIANTS_PER_LINE = 12

  /**
   * Corridor fingerprint: the route sampled at 12 fractions, rounded to ~100 m.
   * Two trips over the same track get the same key however their shape_ids or
   * point counts differ. Deliberately NOT keyed on point count — that was an
   * early mistake: it made near-duplicates look distinct, which is the opposite
   * of what this is for.
   */
  const corridorKey = pts => {
    const k = []
    for (let i = 0; i < 12; i++) {
      const p = pts[Math.round((i / 11) * (pts.length - 1))]
      k.push(`${p[0].toFixed(3)},${p[1].toFixed(3)}`) // 3 dp ~ 100 m
    }
    return k.join(';')
  }

  const lineVariants = new Map() // shortName -> {product, corridors: Map(key -> pts)}
  let seenShapes = 0
  for (const [routeId, {shortName, product}] of railRoutes) {
    for (const t of routeTrips.get(routeId) ?? []) {
      const raw = t.shapeId ? shapePts.get(t.shapeId) : undefined
      if (!raw || raw.length < 2) continue
      const deduped = raw.filter((p, i) => i === 0 || p[0] !== raw[i - 1][0] || p[1] !== raw[i - 1][1])
      if (deduped.length < 2) continue
      seenShapes++
      const pts = simplifyPath(deduped, SIMPLIFY_M)
      if (!lineVariants.has(shortName)) lineVariants.set(shortName, {product, corridors: new Map()})
      const c = lineVariants.get(shortName).corridors
      const key = corridorKey(pts)
      // keep the longest of each corridor group: it covers the most track, so a
      // vehicle near either end still projects onto it
      const cur = c.get(key)
      if (!cur || pts.length > cur.length) c.set(key, pts)
    }
  }

  const toFeature = (line, product, pts) => ({
    type: 'Feature',
    geometry: {type: 'LineString', coordinates: pts.map(([lat, lon]) => [lon, lat])},
    properties: {line, product}
  })

  // Report the cost at several caps, so the cap can be tuned without another
  // 600 MB GTFS download.
  const sortedLines = [...lineVariants.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const buildAt = cap => {
    const out = []
    for (const [line, {product, corridors}] of sortedLines) {
      const kept = [...corridors.values()].sort((a, b) => b.length - a.length).slice(0, cap)
      for (const pts of kept) out.push(toFeature(line, product, pts))
    }
    return out
  }
  const corridorTotal = sortedLines.reduce((n, [, v]) => n + v.corridors.size, 0)
  console.log(`--- corridor dedupe: ${seenShapes} shapes -> ${corridorTotal} corridors across ${sortedLines.length} lines`)
  const worstLines = sortedLines.map(([l, v]) => [l, v.corridors.size]).sort((a, b) => b[1] - a[1])
  console.log(`  most corridors: ${worstLines.slice(0, 8).map(([l, c]) => `${l}:${c}`).join('  ')}`)
  console.log(`  cap  variants   raw KB   gzip KB`)
  for (const cap of [4, 6, 8, 12, 16, 9999]) {
    const f = buildAt(cap)
    const json = JSON.stringify({type: 'FeatureCollection', features: f})
    const gz = zlib.gzipSync(json).length
    console.log(`  ${String(cap === 9999 ? 'all' : cap).padStart(4)} ${String(f.length).padStart(9)} ${String(Math.round(Buffer.byteLength(json) / 1024)).padStart(8)} ${String(Math.round(gz / 1024)).padStart(9)}`)
  }

  const routeFeatures = buildAt(MAX_VARIANTS_PER_LINE)
  console.log(`route variants shipped: ${routeFeatures.length} (cap ${MAX_VARIANTS_PER_LINE} per line)`)

  // ---- stations.json: Point per rail stop ----
  const stationFeatures = [...stopById.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([stopId, s]) => ({
      type: 'Feature',
      geometry: {type: 'Point', coordinates: [s.lon, s.lat]},
      properties: {name: s.name}
    }))

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

  // ---- tracks.json: what to DRAW, one stroke per track ----
  // Separate from routes.json on purpose. routes.json is animation data: one
  // entry per route variant, because each vehicle needs a short, unambiguous
  // shape to project onto. That is the wrong thing to draw — a tram line has
  // about a dozen variants sharing the same rails, so drawing each one puts a
  // dozen strokes on one track and they compound into a solid smear.
  // A faint backdrop line does not need the animation's 10 m accuracy, and the
  // merge resamples at 8 m, so simplify the drawn result harder.
  const DRAW_SIMPLIFY_M = 25

  /*
   * Merge by RENDERED COLOUR, not by line. Merging per line still left up to ten
   * strokes on one tram street — measured on Bernauer Str. and elsewhere, e.g.
   * 18+21+27+37+62+67+M17+M4+M5+M8 sharing rails in 32 places. All 22 tram lines
   * render in the same red (linienfarben has no per-tram-line colour, only a
   * generic "Tram" row), so those ten strokes were indistinguishable: one set of
   * rails drawn ten times. Lines that DO have their own colour stay separate,
   * and the small same-colour families (S2/S25/S26, S46/S47, S7/S75, S8/S85)
   * merge correctly because they really are one colour.
   *
   * The key is a hex for a line with its own colour, or the product name for one
   * that falls back. That way no product hex has to be duplicated here — the UI
   * resolves a non-hex key through its own PRODUCT_COLORS.
   */
  const ownColour = new Map(colorEntries.filter(([n]) => n !== 'Tram'))
  const colourGroups = new Map() // key -> {product, lines: [], variants: []}
  for (const [line, {product}] of sortedLines) {
    const key = ownColour.get(line) ?? product
    const g = colourGroups.get(key) ?? {product, lines: [], variants: []}
    g.lines.push(line)
    g.variants.push(...lineVariants.get(line).corridors.values())
    colourGroups.set(key, g)
  }
  const mergedPerGroup = new Map()
  for (const [key, g] of colourGroups) mergedPerGroup.set(key, mergeToTracks(g.variants))

  const buildTracks = tol => {
    const out = []
    for (const [key, g] of colourGroups) {
      const runs = mergedPerGroup.get(key).map(r => simplifyPath(r, tol)).filter(r => r.length >= 2)
      if (runs.length === 0) continue
      out.push({
        type: 'Feature',
        geometry: {type: 'MultiLineString', coordinates: runs.map(r => r.map(([lat, lon]) => [lon, lat]))},
        // `group` is a hex or a product name; the UI turns it into a colour
        properties: {group: key, product: g.product, lines: g.lines.slice().sort()}
      })
    }
    return out
  }
  console.log(`--- colour groups: ${colourGroups.size} (from ${sortedLines.length} lines)`)
  console.log(`    largest: ${[...colourGroups].sort((a, b) => b[1].lines.length - a[1].lines.length)[0][1].lines.length} lines share one colour`)
  console.log(`  tol  groups    points   raw KB   gzip KB`)
  for (const tol of [10, 25, 40, 60]) {
    const f = buildTracks(tol)
    const pts = f.reduce((n, x) => n + x.geometry.coordinates.reduce((m, r) => m + r.length, 0), 0)
    const json = JSON.stringify({type: 'FeatureCollection', features: f})
    console.log(`  ${String(tol).padStart(4)} ${String(f.length).padStart(7)} ${String(pts).padStart(9)} ${String(Math.round(Buffer.byteLength(json) / 1024)).padStart(8)} ${String(Math.round(zlib.gzipSync(json).length / 1024)).padStart(9)}`)
  }

  const trackFeatures = buildTracks(DRAW_SIMPLIFY_M)

  // length of a [lon, lat] ring, in metres
  const ringM = c => {
    let s = 0
    for (let i = 1; i < c.length; i++) {
      const [lo0, la0] = c[i - 1]
      const [lo1, la1] = c[i]
      s += Math.hypot((la0 - la1) * 111320, (lo0 - lo1) * 111320 * Math.cos((la0 * Math.PI) / 180))
    }
    return s
  }
  const drawnKm = trackFeatures.reduce((n, f) =>
    n + f.geometry.coordinates.reduce((m, r) => m + ringM(r), 0), 0) / 1000
  const variantKm = routeFeatures.reduce((n, f) => n + ringM(f.geometry.coordinates), 0) / 1000
  console.log(`--- tracks.json: ${trackFeatures.length} lines, ${drawnKm.toFixed(0)} km drawn`)
  console.log(`    (drawing every variant instead would be ${variantKm.toFixed(0)} km, ${(variantKm / drawnKm).toFixed(1)}x over the same rails)`)

  const routesJson = {type: 'FeatureCollection', features: routeFeatures}
  const tracksJson = {type: 'FeatureCollection', features: trackFeatures}
  const stationsJson = {type: 'FeatureCollection', features: stationFeatures}

  // ---- sanity gates (BEFORE any write: never overwrite committed assets with bad data) ----
  // routeFeatures now holds several variants per line, so line-level checks work
  // on the distinct set while size checks work on the whole payload.
  const lineNames = [...new Set(routeFeatures.map(f => f.properties.line))]
  const bad = lineNames.filter(n => /^(RE|RB|FEX|ICE)/.test(n))
  const tramLines = lineNames.filter(n => lineVariants.get(n).product === 'tram')
  const missingU = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9'].filter(n => !lineNames.includes(n))
  const routesOut = JSON.stringify(routesJson)
  const routesGz = zlib.gzipSync(routesOut).length
  const tracksOut = JSON.stringify(tracksJson)
  const tracksGz = zlib.gzipSync(tracksOut).length
  const trackCoords = trackFeatures.flatMap(f => f.geometry.coordinates.flat())
  // Gates need FLOORS, not just ceilings. Collapsing every shape to its two
  // endpoints -- the symptom of a units or tolerance bug in SIMPLIFY_M or the
  // distance metric -- passed every earlier gate at 4.7 KB against a real 54 KB,
  // and would have shipped straight chords for the whole network. Verified by
  // deliberate sabotage: it now FAILS and routes.json is left untouched.
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
    ['tracks.json covers 15-60 colour groups', trackFeatures.length >= 15 && trackFeatures.length <= 60],
    ['every rail line appears in tracks.json', new Set(trackFeatures.flatMap(f => f.properties.lines)).size === lineNames.length],
    ['tracks.json 8-120 KB gzipped', tracksGz >= 8 * 1024 && tracksGz <= 120 * 1024],
    ['tracks drawn shorter than all variants', drawnKm < variantKm * 0.75],
    ['track coordinates finite and inside Berlin', trackCoords.every(inBerlin)],
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
    writeFileSync(path.join('public', 'tracks.json'), tracksOut)
    writeFileSync(path.join('src', 'line-colors.ts'), colorsTs)
    console.log(`stations: ${stationFeatures.length} · route variants: ${routeFeatures.length} across ${lineNames.length} lines · lineColors: ${colorEntries.length}`)
    console.log(`routes.json: ${Math.round(Buffer.byteLength(routesOut) / 1024)} KB raw / ${Math.round(routesGz / 1024)} KB gzipped`)
    console.log(`tracks.json: ${Math.round(Buffer.byteLength(tracksOut) / 1024)} KB raw / ${Math.round(tracksGz / 1024)} KB gzipped`)
    const per = {}
    for (const f of routeFeatures) per[f.properties.line] = (per[f.properties.line] ?? 0) + 1
    console.log('variants for:', ['S41', 'S42', 'S1', 'U1', 'U9', 'M5', 'M10', '12'].map(n => `${n}:${per[n] ?? 0}`).join('  '))
  }
} finally {
  rmSync(TMP, {recursive: true, force: true})
  console.log('cleaned up tmp:', TMP)
}

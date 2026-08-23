#!/usr/bin/env node
// Analyse a motion log saved by the "Record motion" control.
//
//   node scripts/analyse-motion.mjs logs/motion-....ndjson [--vehicle 75416-24]
//
// Reports every detected fault, per-vehicle journeys, and the drift between the
// position drawn on the map and the position the operator reported.

import {createReadStream} from 'node:fs'
import {createInterface} from 'node:readline'

const args = process.argv.slice(2)
const file = args.find(a => !a.startsWith('--'))
const only = args.includes('--vehicle') ? args[args.indexOf('--vehicle') + 1] : null
if (!file) {
  console.error('usage: node scripts/analyse-motion.mjs <log.ndjson> [--vehicle <shortId>]')
  process.exit(1)
}

const shortId = id => {
  const p = String(id).split('|')
  return p.length >= 3 && p[1] && p[2] ? `${p[1]}-${p[2]}` : id
}
const metres = (a, b) =>
  Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * Math.cos((a[0] * Math.PI) / 180))

let meta = null
const events = []
const tracks = new Map() // id -> {line, pts: [[t, lat, lon]]}

for await (const line of createInterface({input: createReadStream(file), crlfDelay: Infinity})) {
  if (!line.trim()) continue
  const r = JSON.parse(line)
  if (r.type === 'meta') meta = r
  else if (r.type === 'event') events.push(r)
  else if (r.type === 'pos') {
    const t = tracks.get(r.id) ?? {line: '', pts: []}
    t.pts.push([r.t, r.lat / 1e6, r.lon / 1e6])
    tracks.set(r.id, t)
  }
}
for (const e of events) {
  const t = tracks.get(e.id)
  if (t && e.line) t.line = e.line
}

const pct = (a, f) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length * f)] : 0
const num = n => (Math.round(n * 10) / 10).toLocaleString('en-US')

console.log(`\n=== motion log: ${file}`)
if (meta) {
  console.log(`duration      ${meta.seconds}s   frames ${meta.frames.toLocaleString('en-US')}   vehicles ${meta.vehiclesSeen}`)
  console.log(`trace samples ${meta.traceSamples.toLocaleString('en-US')}`)
  console.log(`max step      ${meta.maxStepM} m in one frame   (limit ${meta.limits.jumpM} m)`)
  console.log(`drift vs reported: median ${meta.drift.medianM} m  p90 ${meta.drift.p90M} m  max ${meta.drift.maxM} m  (n=${meta.drift.samples})`)
}

// --- faults -----------------------------------------------------------------
const faults = events.filter(e => ['jump', 'reversal', 'overspeed', 'freeze'].includes(e.kind))
console.log(`\n--- faults: ${faults.length}`)
const byKind = {}
for (const f of faults) (byKind[f.kind] ??= []).push(f)
for (const [kind, list] of Object.entries(byKind)) {
  const key = kind === 'freeze' ? 'seconds' : kind === 'overspeed' ? 'mps' : 'metres'
  const vals = list.map(f => f[key] ?? 0)
  const unit = key === 'seconds' ? 's' : key === 'mps' ? ' m/s' : ' m'
  console.log(`  ${kind.padEnd(10)} ${String(list.length).padStart(5)}   median ${num(pct(vals, 0.5))}${unit}   worst ${num(Math.max(...vals))}${unit}`)
  const lines = {}
  for (const f of list) lines[f.line || '?'] = (lines[f.line || '?'] ?? 0) + 1
  const top = Object.entries(lines).sort((a, b) => b[1] - a[1]).slice(0, 6)
  console.log(`             by line: ${top.map(([l, n]) => `${l}:${n}`).join('  ')}`)
  for (const f of list.slice(0, 3)) {
    console.log(`             e.g. ${f.line} ${shortId(f.id)} at ${(f.t / 1000).toFixed(1)}s ${key}=${f[key]}${unit}${f.at ? ` heading to ${f.at}` : ''}`)
  }
}
if (!faults.length) console.log('  none')

// --- dwells -----------------------------------------------------------------
const dwells = events.filter(e => e.kind === 'dwell').map(e => e.seconds)
if (dwells.length) {
  console.log(`\n--- dwells at declared stop: ${dwells.length}`)
  console.log(`  median ${num(pct(dwells, 0.5))}s  p90 ${num(pct(dwells, 0.9))}s  max ${num(Math.max(...dwells))}s`)
  const long = events.filter(e => e.kind === 'dwell' && e.seconds > 60)
  if (long.length) console.log(`  over 60s: ${long.length}  e.g. ${long.slice(0, 3).map(e => `${e.line} ${shortId(e.id)} ${e.seconds}s at ${e.at}`).join(' | ')}`)
}

// --- lifecycles -------------------------------------------------------------
const appears = events.filter(e => e.kind === 'appear')
const vanishes = events.filter(e => e.kind === 'vanish')
console.log(`\n--- lifecycle: ${appears.length} appeared, ${vanishes.length} vanished`)
if (vanishes.length) {
  const lives = vanishes.map(e => e.seconds)
  console.log(`  tracked for: median ${num(pct(lives, 0.5))}s  max ${num(Math.max(...lives))}s`)
}

// --- trajectories -----------------------------------------------------------
console.log(`\n--- trajectories (${tracks.size} vehicles traced)`)
const rows = []
for (const [id, t] of tracks) {
  if (t.pts.length < 3) continue
  let dist = 0
  let maxGap = 0
  const speeds = []
  for (let i = 1; i < t.pts.length; i++) {
    const [t0, la0, lo0] = t.pts[i - 1]
    const [t1, la1, lo1] = t.pts[i]
    const d = metres([la0, lo0], [la1, lo1])
    dist += d
    maxGap = Math.max(maxGap, d)
    const dt = (t1 - t0) / 1000
    if (dt > 0) speeds.push(d / dt)
  }
  const span = (t.pts[t.pts.length - 1][0] - t.pts[0][0]) / 1000
  // peak speed over a sampled trace is dominated by catch-up corrections
  // (they run at CATCHUP_MAX_SPEED by design), so report a robust percentile
  rows.push({id, line: t.line, samples: t.pts.length, spanSec: span, km: dist / 1000,
             avgKmh: span > 0 ? (dist / span) * 3.6 : 0,
             p95Kmh: pct(speeds, 0.95) * 3.6, maxGapM: maxGap})
}
rows.sort((a, b) => b.km - a.km)
console.log(`  ${'line'.padEnd(5)} ${'id'.padEnd(11)} ${'traced'.padStart(7)} ${'km'.padStart(6)} ${'avg'.padStart(6)} ${'p95'.padStart(7)} ${'maxgap'.padStart(7)}`)
for (const r of rows.slice(0, 12)) {
  console.log(`  ${(r.line || '?').padEnd(5)} ${shortId(r.id).padEnd(11)} ${(r.spanSec.toFixed(0) + 's').padStart(7)} ${r.km.toFixed(2).padStart(6)} ${(r.avgKmh.toFixed(0) + 'k').padStart(6)} ${(r.p95Kmh.toFixed(0) + 'k').padStart(7)} ${r.maxGapM.toFixed(0).padStart(7)}`)
}
const implausible = rows.filter(r => r.p95Kmh > 160)
console.log(implausible.length
  ? `  implausible sustained speed (p95 > 160 km/h): ${implausible.length} — ${implausible.slice(0, 5).map(r => `${r.line} ${shortId(r.id)} ${r.p95Kmh.toFixed(0)}k`).join(', ')}`
  : '  sustained speeds all plausible (p95 <= 160 km/h)')

// --- single vehicle ---------------------------------------------------------
if (only) {
  const hit = [...tracks].find(([id]) => shortId(id) === only || id === only)
  if (!hit) { console.log(`\n--- vehicle ${only}: not in this log`) }
  else {
    const [id, t] = hit
    console.log(`\n--- vehicle ${only} (${t.line}): ${t.pts.length} samples over ${((t.pts.at(-1)[0] - t.pts[0][0]) / 1000).toFixed(0)}s`)
    for (const e of events.filter(e => e.id === id)) {
      console.log(`  ${(e.t / 1000).toFixed(1).padStart(8)}s  ${e.kind.padEnd(9)} ${e.metres != null ? e.metres + 'm' : ''}${e.seconds != null ? e.seconds + 's' : ''}${e.mps != null ? e.mps + 'm/s' : ''} ${e.at ?? ''}`)
    }
  }
}
console.log()

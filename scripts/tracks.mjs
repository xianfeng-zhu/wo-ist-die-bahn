// Turn a line's route variants into the TRACK it runs on, drawn once.
//
// routes.json holds one entry per route variant, because the animation needs a
// short, unambiguous shape to project each vehicle onto. For drawing, that is
// wrong: a tram line has about a dozen variants — depot runs, short turns,
// different branch ends — and they all share the same rails through the middle of
// the city. Drawing each one puts a dozen strokes on one track, and stacked
// strokes compound their opacity into a solid smear.
//
// Matching the variants segment by segment does not work: each was simplified
// on its own, so two paths over the same rails have different vertices. So work
// in cells instead. Resample every variant to a fixed spacing, mark the cells it
// covers, and keep only the stretches that enter cells nothing has covered yet.

const MPD_LAT = 111320
const BERLIN_LAT = 52.5
const MPD_LON = MPD_LAT * Math.cos((BERLIN_LAT * Math.PI) / 180)

/**
 * Cell size for "already drawn".
 *
 * Each covered point marks its own cell AND the eight around it, which makes the
 * merge distance about 0.5-1.5 cells (6-18 m) instead of depending on where a
 * cell boundary happens to fall. Plain cell equality was boundary-sensitive: two
 * GTFS shapes for one street differ laterally by several metres, so a point near
 * an edge landed in the next cell, read as uncovered, and the track was drawn
 * twice. Measured on real data, 40% of tram segments still had a duplicate
 * within 12 m of them.
 */
const CELL_M = 12
/**
 * Sample spacing. Must be well under CELL_M, so a second variant over the same
 * rails lands in every cell the first one marked whatever its starting offset.
 */
const STEP_M = 8
/**
 * Break a run only after this many covered samples (8 m each), so a junction or a
 * short shared stretch does not shred it. At 3 the output came out in thousands
 * of 2-3 point fragments that simplification could not reduce: 42,000 points and
 * 662 KB gzipped. Continuing through ~64 m of already-drawn track costs a little
 * doubled line, which is invisible at these widths.
 */
const GAP_TOLERANCE = 8

/** Drop a finished run shorter than this. Below it, nothing is visible anyway. */
const MIN_RUN_M = 80

const metres = (a, b) =>
  Math.hypot((a[0] - b[0]) * MPD_LAT, (a[1] - b[1]) * MPD_LAT * Math.cos((a[0] * Math.PI) / 180))

/** Walk a path and place a point every `stepM`, keeping both ends. */
export function resampleByDistance(pts, stepM) {
  if (pts.length < 2) return pts.slice()
  const out = [pts[0]]
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const seg = metres(a, b)
    if (seg === 0) continue
    let t = stepM - carry
    while (t <= seg) {
      const f = t / seg
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])
      t += stepM
    }
    carry = (carry + seg) % stepM
  }
  const last = pts[pts.length - 1]
  if (metres(out[out.length - 1], last) > stepM / 2) out.push(last)
  if (out.length === 1 && metres(pts[0], last) === 0) return [pts[0]]
  return out
}

const cellOf = ([lat, lon]) =>
  [Math.round((lat * MPD_LAT) / CELL_M), Math.round((lon * MPD_LON) / CELL_M)]

const cellKey = p => {
  const [y, x] = cellOf(p)
  return `${y},${x}`
}

/** Mark a point's cell and the eight around it, so coverage is not edge-sensitive. */
const markCovered = (covered, p) => {
  const [y, x] = cellOf(p)
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) covered.add(`${y + dy},${x + dx}`)
}

/**
 * Merge route variants into the track they share, as a list of polylines.
 *
 * Longest first, so the main route is drawn whole and the short turns only
 * contribute what the main route does not already cover.
 */
export function mergeToTracks(variants) {
  const usable = variants.filter(v => v.length >= 2)
  if (usable.length === 0) return []
  const byLength = usable
    .map(v => ({v, len: resampleByDistance(v, STEP_M).length}))
    .sort((a, b) => b.len - a.len)
    .map(x => x.v)

  /** Length of a run in metres. */
  const runM = r => {
    let s = 0
    for (let i = 1; i < r.length; i++) s += metres(r[i - 1], r[i])
    return s
  }
  const covered = new Set()
  const runs = []
  const finish = run => {
    if (run.length >= 2 && runM(run) >= MIN_RUN_M) runs.push(run)
  }
  for (const variant of byLength) {
    const pts = resampleByDistance(variant, STEP_M)
    let run = []
    let skipped = 0
    for (const p of pts) {
      const key = cellKey(p)
      if (covered.has(key)) {
        skipped++
        // keep the point, so a run does not stop dead at a single covered cell
        if (run.length > 0) run.push(p)
        if (skipped >= GAP_TOLERANCE) {
          finish(run.slice(0, Math.max(0, run.length - skipped + 1)))
          run = []
          skipped = 0
        }
      } else {
        skipped = 0
        markCovered(covered, p)
        run.push(p)
      }
    }
    finish(run)
  }
  // ~1 m precision. Resampling produces full-precision floats, which are almost
  // incompressible: 17-digit coordinates cost 39 bytes each and gzip barely
  // touches them. GTFS itself only carries 6 decimals.
  return runs.map(r => r.map(([lat, lon]) => [+lat.toFixed(5), +lon.toFixed(5)]))
}

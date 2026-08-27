// Ranking for the search box: stops and lines, together, as you type.
//
// Pure and synchronous — it runs over data already in memory (672 stations from
// stations.json, plus whatever lines are running), so there is no request and no
// debounce needed. Kept out of the DOM so the ranking can be tested on its own,
// which matters: ranking is where a search feels clever or stupid.

import {compareLineNames, lineKey, type LineRef} from './vehicle.js'

export interface StopEntry {
  id: string
  name: string
}

export type SearchHit =
  | {kind: 'stop'; id: string; name: string; score: number}
  | {kind: 'line'; line: string; product: LineRef['product']; key: string; score: number}

/**
 * Fold a query and a candidate to the same shape before comparing.
 *
 * Berlin stop names are full of things nobody types: "S+U Alexanderplatz Bhf
 * (Berlin)" for a place people call "alex", and "Wilhelminenhofstr./Edisonstr."
 * with a slash in the middle. So strip the decoration, and fold the German
 * letters — someone typing "muggelsee" should find "Müggelsee".
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .replace(/str\./g, 'strasse')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Strip the decoration VBB adds to every stop name, so a comparison sees the name.
 *
 * "S+U Alexanderplatz Bhf (Berlin)" is a station people call Alexanderplatz. Left
 * as it is, a prefix match ranks "Alexanderplatz, Grunerstr./Karl-Liebknecht-Str.
 * (Berlin)" — a tram stop round the corner — ABOVE the station itself, because
 * that one happens to start with the word. Measured on the real names; the mode
 * marker, the "Bhf" and the "(Berlin)" carry no information a searcher typed.
 *
 * Applied to the candidate only, never to the query: someone typing a bare "s"
 * still means "s", and folding it to nothing would give them no results at all.
 */
export function nameKey(name: string): string {
  return normalise(name)
    .replace(/^(s u|u s|s|u) /, '')
    .replace(/ berlin$/, '')
    .replace(/ bhf$/, '')
    .trim()
}

/**
 * Score a candidate against a normalised query. Higher is better; 0 means no match.
 *
 * The ladder is deliberate, because these feel very different to use:
 *   exact              — you typed the whole thing
 *   prefix of the name — "alex" for "Alexanderplatz"
 *   prefix of a word   — "hbf" inside "S+U Berlin Hauptbahnhof"; a word start is
 *                        what people mean, and matching mid-word puts "Ostkreuz"
 *                        above "Ostbahnhof" for the query "bahn", which is wrong
 *   anywhere           — last resort, so nothing typed is ever a dead end
 *
 * Shorter names win ties: for "alex", "S+U Alexanderplatz" should beat
 * "Alexanderplatz, Grunerstr./Karl-Liebknecht-Str.".
 */
export function scoreName(name: string, query: string): number {
  if (!query) return 0
  const hay = nameKey(name)
  if (!hay) return 0
  if (hay === query) return 1000
  let base = 0
  if (hay.startsWith(query)) base = 800
  else if (hay.split(' ').some(word => word.startsWith(query))) base = 600
  else if (hay.includes(query)) base = 300
  else return 0
  // a shorter name is a closer answer; cap the bonus so it cannot outrank a tier
  return base + Math.max(0, 100 - hay.length)
}

/**
 * Rank stops and lines for `rawQuery`.
 *
 * Lines are checked first and given a lift, because a query like "M10" or "U6" is
 * almost always about the line: there is also a stop called "U Turmstr." and a
 * dozen containing "M10" would be noise above it.
 */
export function search(
  rawQuery: string,
  stops: Iterable<StopEntry>,
  lines: Iterable<LineRef>,
  limit = 20
): SearchHit[] {
  const query = normalise(rawQuery)
  if (query.length < 1) return []
  const hits: SearchHit[] = []

  for (const l of lines) {
    const score = scoreName(l.line, query)
    if (score > 0) hits.push({kind: 'line', line: l.line, product: l.product, key: lineKey(l), score: score + 150})
  }
  for (const s of stops) {
    const score = scoreName(s.name, query)
    if (score > 0) hits.push({kind: 'stop', id: s.id, name: s.name, score})
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // stable, readable order inside a tie
    if (a.kind === 'line' && b.kind === 'line') return compareLineNames(a.line, b.line)
    if (a.kind === 'stop' && b.kind === 'stop') return a.name.localeCompare(b.name)
    return a.kind === 'line' ? -1 : 1
  })
  return hits.slice(0, limit)
}

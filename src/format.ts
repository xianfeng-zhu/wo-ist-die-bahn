// Turning HAFAS time strings into something a rider reads.
//
// The feed gives `HHMMSS` (and sometimes `HH:MM:SS`), always on a whole minute —
// 1,762 of 1,762 strings checked, scheduled and realtime alike. So seconds are
// noise: never show them, and never imply precision the data does not have.

/** `HHMMSS` or `HH:MM:SS` -> seconds since midnight. `null` if unreadable. */
export function timeToSeconds(t: string | undefined): number | null {
  if (!t) return null
  const digits = t.replace(/:/g, '')
  if (!/^\d{4,6}$/.test(digits)) return null
  const padded = digits.padStart(6, '0')
  const h = Number(padded.slice(0, 2))
  const m = Number(padded.slice(2, 4))
  const s = Number(padded.slice(4, 6))
  if (m > 59 || s > 59) return null
  // HAFAS uses 24+ for times past midnight on the same day of operation
  return h * 3600 + m * 60 + s
}

/** `HHMMSS` -> `HH:MM`, wrapping HAFAS's 24+ hours back into a clock reading. */
export function clockTime(t: string | undefined): string {
  const sec = timeToSeconds(t)
  if (sec === null) return '—'
  const h = Math.floor(sec / 3600) % 24
  const m = Math.floor((sec % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * Whole minutes from `nowSec` until `t`, or null if unreadable.
 *
 * Handles the day boundary: a departure at 00:05 seen at 23:58 is in 7 minutes,
 * not minus 1,433. Anything more than 3 hours behind is treated as tomorrow,
 * which also covers HAFAS's 24+ hour notation.
 */
export function minutesUntil(t: string | undefined, nowSec: number): number | null {
  const target = timeToSeconds(t)
  if (target === null) return null
  let diff = target - nowSec
  if (diff < -3 * 3600) diff += 24 * 3600
  if (diff > 21 * 3600) diff -= 24 * 3600
  return Math.round(diff / 60)
}

/**
 * A departure countdown, the way a platform display puts it.
 *
 * `now` for anything due or a minute out, because "0 min" reads as a fault; a
 * negative value for something already gone, which a board should drop rather
 * than render.
 */
export function etaLabel(minutes: number | null): string {
  if (minutes === null) return '—'
  if (minutes < 0) return 'gone'
  if (minutes < 1) return 'now'
  return `${minutes} min`
}

/** Delay in ms -> a signed minute label, or `null` when the vehicle is on time. */
export function delayLabel(delayMs: number | null | undefined): string | null {
  if (delayMs == null) return null
  const min = Math.round(delayMs / 60000)
  if (min === 0) return null
  return min > 0 ? `+${min} min` : `${min} min`
}

/** Seconds since midnight, in Berlin, for `now`. */
const BERLIN_CLOCK = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})
export function berlinSecondsOfDay(now: Date): number {
  const parts: Record<string, string> = {}
  for (const p of BERLIN_CLOCK.formatToParts(now)) parts[p.type] = p.value
  return Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)
}

# UX backlog

Findings from a product review on 2026-08-27, walked through on a 390×844 phone
and a 1440×900 desktop, at street level and city-wide, with mouse and keyboard.

Every number here was measured, not estimated. Items are grouped by what they do
for a rider, not by effort.

Status: **scheduled** = agreed for the current round of work. **open** = recorded,
not yet agreed.

---

## 1. Arrival times are already in memory and never shown — scheduled

The vehicle popup says `next: S Westend`. Held for that same vehicle at that
moment: `toStop.t = 23:25`, plus a four-stop summary with a time on each —
`S Beusselstr. 23:18 · Jungfernheide 23:22 · Westend 23:25 · Südkreuz 23:40`.

"Arrives Westend 23:25" is the most useful sentence a transit map can produce,
and it needs no request, no new data and no key.

Beyond the four stopovers, `JourneyDetails` on the existing gate returns the
**full** journey — verified: 31 stops with times, plus a route polyline, against
the 4 the radar gives. One request per tapped vehicle.

## 2. Tapping a station tells you its name and nothing else — scheduled

The question people have while standing at a stop is *what is coming, and when*.
Station dots are currently decoration.

`StationBoard` on the existing gate answers it — verified: departures with line,
direction, realtime time and `jid`, resolved by `extId` alone. `extId` is the GTFS
`stop_id`, which `public/stations.json` does **not** currently carry (its only
property is `name`).

## 3. There is no "where am I" — open

No geolocate control. On a phone this is the first thing a transit map should
offer. MapLibre ships `GeolocateControl`; this is a control registration, not a
feature build.

## 4. No place search — scheduled

The only search box searches line names. You cannot find Alexanderplatz or your
own street. `public/stations.json` already ships 1,573 stops with coordinates, so
station search needs no API at all — but see item 2 on the missing ids.

## 5. The base map fights the data — scheduled

At city scale, OSM's bright yellow and orange roads compete with the vehicle dots
for attention. `raster-saturation` on the existing raster layer makes the city the
background and the transit the subject: one line, no new tile provider, no new
dependency.

Density for context: at z11 there are **596 badges on screen with 28% overlapping**.
That reads as the pulse of the city, which is fine — but only once the base map
stops shouting. Do this before considering clustering, which would break the
live-motion quality that makes the map worth watching.

## 6. Touch targets are too small in the filter list — open

Measured on a 390 px phone: checkboxes **13×13 px**, rows **19 px** tall, in a
210 px scroller holding 208 rows — about **21 screens** of scrolling. Apple and
Google both ask for 44–48 px.

Note the inconsistency: `.veh::after` already gives vehicle badges a 44 px tap
area on coarse pointers. The care was taken once and not carried into the panel.

## 7. Two small accessibility bugs — open

- A badge reads to a screen reader as **"S4291274-0"**: the debug id span is
  `display:none` but still in `textContent`, so it runs into the line name. It
  needs `aria-hidden`, and the badge needs a real `aria-label`
  ("S42 S-Bahn to Südkreuz").
- The badge is focusable (MapLibre sets `tabindex=0`) but has no `role`, so it
  does not announce as something you can activate.

Focus rings were checked with a real Tab press and are **fine**
(`outline: auto`, `:focus-visible` matches). Not a defect.

## 8. Nothing for sharing or installing — open

No `meta description`, no `theme-color`, no `og:image`, no manifest. Sharing the
URL produces a bare link with no preview; on Android the browser chrome stays
unthemed.

## 9. The status line reads like a debug log — scheduled

`live · 697 vehicles · updated 14s ago`. With a 20 s poll it will often sit at
15–20 s, which looks stale to someone who does not know the design, and "697
vehicles" answers an engineering question rather than a rider's.

Agreed direction: move it behind the debug view.

## 10. Route lines earn little at z11–12 — open

At 0.3 opacity and 0.8 px they are nearly invisible under a busy base map. Once
the base is desaturated (item 5) they should show properly; if not, their
`minzoom` should rise rather than keep drawing something nobody can see.

---

## Scheduled work, as the user framed it

**Tap a vehicle** — slide in a panel, mobile-app style, with the vehicle's
information and a strip of station dots for stops passed and still to come. The
vehicle's marker on that strip moves in real time, positioned between two station
dots in the same proportion as it sits between them on the map.

**Tap a station** — slide in a real-time dashboard for that stop: the modes and
vehicles serving it with their ETAs. Tapping one of those opens the vehicle panel.

**Search** — a box that searches stations and lines, with results appearing as you
type, each result clickable through to the vehicle or station panel.

**Base map** — desaturate it (item 5).

**Status line** — put it behind the debug view (item 9).

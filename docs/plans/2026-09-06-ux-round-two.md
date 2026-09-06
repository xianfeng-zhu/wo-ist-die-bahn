# UX round two — plan

**Date:** 2026-09-06
**Status:** Implemented (2026-09-06)

## Scope

The user picked these items from the UX review:

- **2** — surface disruption / construction / elevator-fault / cancellation text in the station panel
- **3** — a glanceable "next stop · arrival time" headline in the vehicle panel
- **4** — geolocate ("where am I")
- **8** — shareable URL state (and a share/copy action)
- **default filters + poll gating** — replace the data-saver idea: S-Bahn, U-Bahn
  and tram on by default, and the poll skips the bus and remaining product groups
  until the user turns those modes on

Explicitly **out of scope** for this round:

- occupancy badges (review item 1 — adjacent, but not selected)
- keyboard navigation for the filter list, panel and board (user decision 2026-08-28)
- a data-saver toggle (replaced by the default-filter change)
- any animation / track / accuracy work (AGENTS.md invariants)

## Decisions and assumptions

1. **Default filters also gate the poll.** The user wants rail-only by default
   specifically to save bandwidth, so the poll fetches only the groups for modes
   that are currently on. Hidden modes must still be re-enable-able, which means
   the Type menu needs a static list of all seven modes (see the default-filters
   section). This intentionally changes the earlier "menus list only what is
   running" behaviour at the Type level; the Line menu still lists only running
   lines of fetched, ticked types.

2. **No new runtime dependency.** Geolocation uses MapLibre's built-in
   `GeolocateControl`.

3. Keep the existing honesty line ("Times and position come from the timetable
   plus the live delay, not from GPS.") and do not touch the animation path.

4. Parser transforms keep their current contract: never throw on wire data, drop
   a missing field rather than the whole response.

---

## Item 3 — vehicle panel: next stop + arrival headline (do first)

### Current state

`vehicleView` in `src/views.ts` shows the line/mode in the header, `to <direction>`
in the subtitle, an optional delay banner, then the evenly-spaced stop strip. The
single most useful sentence — the next stop and when the vehicle arrives — is
not a headline; the data is already in memory on `Vehicle`:

- `Vehicle.nextStop` — next stop name
- `Vehicle.toStop?.name` / `toStop.t` — declared target stop and its `HHMMSS` time
- `Vehicle.delayMs` — realtime minus scheduled
- `format.ts` already has `clockTime`, `minutesUntil`, `delayLabel`

### Change

Add a summary block at the top of `vehicleView`, before the delay banner / strip:

```
Next: Alexanderplatz
14:32  ·  3 min  ·  +2 min
```

Exact layout to be settled in code, but it must be:

- present for every vehicle that has `toStop` or `nextStop`;
- honest about the source (reuse the existing estimate note, no new claim);
- safe when `toStop`, `nextStop` or `delayMs` is missing (fall back to name only).

Prefer a small pure helper (e.g. `arrivalSummary(v, nowSec)` in `views.ts` or
`format.ts`) so it is unit-testable.

### Files

- `src/views.ts` — render the summary
- `src/style.css` — one compact style for the summary
- `src/format.ts` or a new helper — assemble the label (only if it makes the test cleaner)
- tests: `src/format.test.ts` (for the helper) and/or a new `src/views.test.ts`

### Verification

- `npm test`
- `npm run build`
- `npm run dev`, tap a vehicle: headline is correct and updates on poll; a vehicle
  with no `toStop` still renders the rest of the panel.

---

## Default filters + poll gating — S/U/tram only, by default

### Current state

`filters` in `src/main.ts` initialises every `Product` to `true`:

```ts
const filters: Record<Product, boolean> = {
  suburban: true, subway: true, tram: true, bus: true, ferry: true, express: true, regional: true
}
```

`fetchAllVehicles` always polls `PRODUCT_GROUPS = [7, 8, ALL_PRODUCTS - 7 - 8]`,
and the Type menu (`presentTypes`) is derived from `liveLines` — so it only
offers modes that were actually fetched and seen running.

### Change

1. Initialise `filters` with only `suburban`, `subway`, `tram` set to `true`; the
   rest `false`.

2. Compute the product groups to fetch from `filters`:

   - rail group `7` when any of `suburban` / `subway` / `tram` is on
   - bus group `8` when `bus` is on
   - other group `ALL_PRODUCTS - 7 - 8` when any of `ferry` / `express` /
     `regional` is on

   Add exported group constants in `src/hci.ts` and let `fetchAllVehicles` accept
   the active subset (`groups`). It keeps merging by `jid` and reports `capped`
   only for the groups actually requested.

3. Refetch when the active group set changes: filter changes schedule an
   immediate poll so a newly enabled mode appears without waiting out the 20 s
   interval. When a group is switched off, `render()` already hides its vehicles
   via `filterVehicles`; also clear the affected entries from `liveLines` so the
   Line menu does not keep offering a line whose group is no longer fetched.

4. Keep the Type menu able to re-enable hidden modes. Un-fetched modes are absent
   from `liveLines`, so `presentTypes` can no longer be the source of Type rows.
   Switch the Type menu to a static `PRODUCT_LABELS` list of all seven modes,
   each with its checkbox state taken from `filters`. The Line menu stays
   live-lines-only. This is a deliberate change: the Type list becomes complete,
   the Line list remains running-only.

### Files

- `src/hci.ts` — group constants + `fetchAllVehicles(..., groups)`
- `src/main.ts` — filter defaults, active-group computation, poll wiring,
  refetch-on-filter-change, static Type menu, line-sighting cleanup
- tests: `src/hci.test.ts` for group filtering / `capped` mapping

### Notes / risks

- Bandwidth: the default poll becomes the rail group only. The bus group is the
  largest (~1.3 MB of a 2.2 MB poll), so this is the meaningful saving.
- `recordLineSightings` should stop being fed vehicles from un-fetched groups, or
  their lines linger; make the cleanup explicit rather than relying on the 60 s
  linger.
- The `capped` status must reflect the reduced request set; do not report "feed
  capped" for groups we deliberately did not fetch.
- Keep `?types=` (item 8) consistent: it sets filters and therefore also chooses
  the fetched groups on load.
- `focusLine` (search result) still turns on the selected line's type, so a bus
  search result remains reachable.

### Verification

- `npm test`, `npm run build`
- fresh load in dev: only rail badges are drawn, and the network panel shows only
  the rail request (no bus/other request)
- the Type menu lists all seven modes; ticking Bus triggers an immediate poll and
  bus badges appear; unticking it removes them and stops the bus request
- "All types" re-enables everything and returns to the full three-group poll

---

## Item 4 — geolocate

### Current state

No locate control. The only persisted camera state is
`localStorage['liveberlin.mapview']`.

### Change

Import `GeolocateControl` from `maplibre-gl`, instantiate it once, and add it to
the map in the default control corner that does not collide with the top-left
status bar, top-right filters, top-centre search, or the left/bottom detail panel.

Suggested configuration:

```ts
new GeolocateControl({
  positionOptions: {enableHighAccuracy: false},
  trackUserLocation: false,
  showUserLocation: true,
  fitBoundsOptions: {maxZoom: 15}
})
```

Decide in implementation whether to:

- place it bottom-right (MapLibre default, empty today), or
- add it next to the settings control for a consistent visual language.

Keep permission failure quiet: do not show a raw error; the built-in control
already degrades, and the map remains usable without location.

### Files

- `src/main.ts`
- `src/style.css` only if the control needs positioning/padding

### Verification

- `npm run build`
- dev + https/localhost: locate moves/centres the map once; deny permission does
  not break the rest of the app; the control is tappable on a phone.

---

## Item 8 — shareable URL state

### Current state

Only `?vehicle=<shortId>` and `?stop=<extId>` are addressable
(`urlFor` / `applyUrl` in `src/main.ts`). Map view persists in localStorage, and
type/line filters persist nowhere. Sharing the current map/filters is not
possible.

### Change

Add a compact URL encoding for **type filter, line filter and camera** that is
read on load, not rewritten on every `moveend`:

```
?types=suburban,subway,tram&lines=suburban:S1,subway:U2&center=13.405,52.52&zoom=12
```

Proposed rules:

- `types` — comma list of `Product` keys, `all` omitted (means default/all).
- `lines` — comma list of `lineKey` values (`product:name`), parsed by splitting
  at the first `:` so line names containing a colon are safe.
- `center`/`zoom` — optional camera; when present, apply on load.
- Invalid / unknown values are ignored rather than throwing.

Add a **"Copy link" / "Share"** action in the settings panel that snapshots the
current filters + camera into that URL. Use `navigator.share` when available
(with the URL), otherwise write to the clipboard and briefly confirm. This keeps
the URL as an opt-in share, not a pushState storm.

Keep the existing `?vehicle=` / `?stop=` behaviour: the new params compose with
them, and `applyUrl` reads them in one pass.

### Files

- `src/main.ts` — build/parse URL, apply on load, share button
- possibly a new `src/url.ts` (pure encode/decode) to keep `main.ts` small
- tests: new `src/url.test.ts` for encode/decode round-trips and bad-input cases
- `src/style.css` — share button styling

### Verification

- `npm test`, `npm run build`
- build a link with rail-only + a line + a zoomed view; open it in a fresh tab
  and confirm the same state appears; confirm garbage params are ignored.

---

## Item 2 — station notices (disruption / elevator / cancellation)

### Wire findings (captured live 2026-09-06)

A `StationBoard` response (`Alexanderplatz`, `extId 900100003`) has:

```jsonc
// svcResL[0].res.common
{
  "remL": [
    {"code":"text.occup.loc.max.13", "icoX":4, "txtN":"Hohe Auslastung erwartet", "type":"A"},
    {"code":"OPERATOR", "icoX":5, "txtL":"S-Bahn Berlin GmbH", "txtN":"DBS", "txtS":"DBS", "type":"A"}
  ],
  "tcocL": [{"c":"FIRST","r":13}, {"c":"SECOND","r":13}]
}

// svcResL[0].res.jnyL[0]
{
  "msgL": [{"type":"REM","remX":1}, {"type":"REM","remX":2}],
  "stbStop": {
    "msgL": [{"type":"REM","remX":0}],
    "dTrnCmpSX": {"tcocX":[0,1]}
  }
}
```

So notice text is `common.remL[].txtN` / `txtL`, referenced by `remX` from both
`jnyL[].msgL[]` (journey-level) and `stbStop.msgL[]` (station/stop-level).
Occupancy text lives in the same `remL` list; occupancy levels are in
`common.tcocL`.

### Change

Extend `parseStationBoard` (or add a sibling parser) to also return notices:

```ts
export interface StationNotice {
  text: string
  kind: 'information' | 'construction' | 'disruption' | 'elevator' | 'occupancy' | 'operator' | 'other'
  /** True when it applies to the station rather than one departure. */
  stationWide: boolean
}
```

Rules:

- parse `common.remL` into text records;
- resolve `remX` refs, dedupe identical texts, and attach each notice to either
  the station (from `stbStop.msgL`) or a departure (from `jnyL[].msgL`);
- classify by `code` keywords (`elevator`/`construction`/`disruption`/`occup`
  etc.), falling back to `other`;
- never throw on missing `remL`/`remX`.

Render a small notice banner at the top of `stationView` for station-wide
notices, and a subtle mark on affected departure rows. Cancellation is already
rendered; keep that as-is and treat new notices as additive.

### Files

- `src/journey.ts` — parser + `StationNotice` type (and `parseStationBoard`
  return shape, either a new function or an added field)
- `src/views.ts` — banner + per-departure mark
- `src/main.ts` — thread notices from `fetchStationBoard` into `renderStopDetail`
- `src/style.css` — notice banner styles
- tests: `src/journey.test.ts` with a captured `remL`/`msgL` fixture

### Verification

- `npm test`, `npm run build`
- dev: open a station known to have a notice (check a few real boards), confirm
  the text appears and is deduplicated; open a quiet station and confirm no banner.

---

## Suggested order

1. Item 3 (small, high value, no wire risk)
2. Default filters + poll gating
3. Item 4 (small, mostly wiring)
4. Item 8 (moderate, pure URL work)
5. Item 2 (most parsing surface; needs the captured fixture)

Each step lands independently and is verifiable in isolation.

## Implementation notes

- The Type menu is now the full seven-mode list (as planned); the Line menu is
  still running-only.
- Station notices are parsed from `common.remL` via `jnyL[].msgL` (journey level,
  shown on the departure row) and `stbStop.msgL` (stop level, shown as a station
  banner). `OPERATOR` rows are dropped and occupancy is left out of this round.
- Share links are opt-in via a **Copy link** button; view state is applied on
  initial load, not rewritten on every camera move or filter change.

## Definition of done

- `npm test` green
- `npm run build` green
- the manual checks above pass on a phone-sized and desktop viewport
- no change to animation, track selection, the 20 s poll interval, or the
  accuracy note

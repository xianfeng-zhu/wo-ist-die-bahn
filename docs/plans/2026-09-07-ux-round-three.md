# UX round three — plan

**Date:** 2026-09-07
**Status:** Implemented (2026-09-07)

## Scope

The user picked these items from the UX review of 2026-09-07 (numbered as in
the review message):

- **2** — a station-board departure that has not left yet is currently a dead
  tap. Open a full schedule view instead (validated live: `JourneyDetails`
  returns 26 stops + a polyline for a future `jid` from a `StationBoard`).
- **3** — sharing still produces a bare link, and the app is not installable:
  add `meta description`, `theme-color`, OG/Twitter tags, raster icons, a
  manifest, and a service worker that makes the static shell load instantly on
  return visits.
- **4** — type/line filters are forgotten on every reload. Persist them in
  `localStorage` (shared-link URL parameters keep precedence) and offer a
  reset-to-defaults action.
- **5** — a large interchange board mixes every mode in time order. Add line
  chips at the top of the board so a rider can narrow to one line. Data is
  already in memory; no extra request.
- **6** — the settings/filter list still has ~19 px rows and 13 px checkboxes on
  a 210 px scroller (UX backlog item 6, still open). This round also includes a
  broader, more modern and cleaner visual pass over the UI interactive elements
  (buttons, selects, chips, checkboxes, overlays, focus rings), in CSS only.
- **7** — disruption / construction / elevator notices exist only at the station
  level (open board). Radar journeys carry the same `remL`/`msgL` notices; lift
  them to line level and make them visible globally: an alerts pill on the map,
  an alert mark in the Line menu and in search, and a banner on the affected
  vehicle's panel.

Explicitly **out of scope** for this round:

- occupancy badges (review item 1 — not selected; occupancy texts are parsed
  but filtered out, so they can be switched on later without touching the wire
  handling)
- a dark / night base map (review item 8 — needs a second tile provider)
- keyboard navigation for lists, panel and board (user decision 2026-08-28)
- any animation / track / accuracy work, the 20 s poll interval, or the
  estimate note (AGENTS.md invariants)

## Design rules that apply to every item

- No new runtime dependency, no new network call beyond what an item states.
- Parser code never throws on wire data; missing fields drop entries.
- Pure logic lives in pure modules (or pure helpers) so it is unit-testable;
  the test environment has no DOM (node only).
- German texts from the feed are not rendered as UI labels where we have a
  stable English equivalent; stop/line names stay as delivered.
- The poll is the single heartbeat: an open panel takes whatever a poll brings
  back. New requests are only for the things a poll cannot answer (a future
  journey's full schedule, a board's next hour).
- `prefers-reduced-motion` is respected everywhere we add motion.

---

## Item 6 — modern, clean visual refresh + touch targets

### Current state

- `#filters .layer` rows are ~19 px tall with 13 px checkboxes
  (`src/style.css` line 44); the Line list scrolls inside 210 px
  (`src/style.css` line 164). On a 390 px phone that measured ~21 screens of
  scrolling in the 2026-08-27 review.
- Station dots, search rows and departure rows already have 44 px hit areas;
  the settings rows and the 34 px tappable journey-strip rows do not.
- The overlay chrome (filters card, buttons, details headers) predates any
  design tokens; hover/active/focus states are inconsistent.

### Change

1. Introduce CSS custom properties on `:root` (panel colours, text colours,
   accent, danger, radii, shadows, control height, font sizes) and apply them
   across the overlays. Pure CSS, no framework.
2. Interactive elements get a consistent modern treatment: rounded controls,
   subtle borders/shadows, `accent-color` checkboxes, visible
   `:focus-visible` rings, hover/active feedback, `cursor: pointer` on the
   right things, and `prefers-reduced-motion` guards.
3. Settings rows: bigger padding, min touch height (44 px on coarse pointers,
   ~30 px on fine), the checkbox becomes the whole row's hit area.
4. The compact (phone) filter panel becomes a proper bottom sheet: full width,
   rounded top corners, slide transition, internal scrolling lists that can
   use more than 210 px, and the gear button only opens/closes it. On desktop
   the panel stays a floating card.
5. Tappable journey-strip rows get an invisible 44 px hit zone on coarse
   pointers (the `.veh::after` precedent), without changing their visual
   34 px rhythm.
6. Keep `.veh` badges, map layers and the estimate note untouched.

### Files

- `src/style.css` — tokens + restyled controls, sheets, lists, focus rings
- `src/main.ts` — only structural additions the CSS needs (e.g. a panel
  header/close for the mobile sheet)
- no test changes (visual)

### Verification

- `npm run build`
- `npm run dev` at 390 px and desktop: rows comfortably tappable, sheet
  opens/closes, focus ring visible with Tab, everything else unchanged.

---

## Item 5 — station board line chips

### Current state

`stationView` (`src/views.ts`) groups departures by mode and sorts each group
by time. There is no way to narrow to one line.

### Change

1. Pure helpers in `src/views.ts` (exported, tested):
   - `lineChipsFor(departures)` → distinct running lines present on the board
     with `{key, line, product, count}`, ordered by product then
     `compareLineNames`;
   - `departuresForLine(departures, key | null)`.
2. `stationView` takes two new options: `activeLineKey` and `onLine`. It
   renders a chip row (`All` + one chip per line) above the groups when there
   is more than one line; each chip is a `button` with `aria-pressed`, styled
   with the line colour. Selecting a chip narrows the rows shown (a single
   group, still in time order).
3. `src/main.ts`: `renderStopDetail` keeps a per-board line selection
   (`boardLineKey`, reset when a different stop opens). Tapping a chip only
   re-renders — no request. A quiet board refetch re-renders through the same
   state; if the chosen line vanishes from the fresh board, reset to `All` and
   re-render once.

### Files

- `src/views.ts` — pure helpers + chip row in `stationView`
- `src/main.ts` — board line state and wiring
- `src/style.css` — chip styles
- tests: `src/views.test.ts` for the pure helpers

### Verification

- `npm test`, `npm run build`
- open Alexanderplatz (900100003): chips appear, tapping one narrows the board,
  times keep refreshing, Back returns to the full board.

---

## Item 2 — schedule view for a departure that has not left yet

### Current state

`renderStopDetail`'s `onPick` only opens a vehicle when that `jid` is already
on the map; every other departure row is styled tappable but does nothing.
Validated live on 2026-09-07: `JourneyDetails` (`fetchJourneyDetail`) resolves
a future `jid` from a board — 26 stops with times plus a polyline.

### Change

1. New detail target kind `journey` in `src/main.ts`, carrying the display
   metadata captured at tap time (`jid`, line, product, direction, the stop
   whose board we came from and its id) so the header renders before the fetch
   answers and the URL stays shareable.
2. `src/url.ts`: encode/decode helpers for the journey link
   (`?journey=<jid>&at=<stopId>&line=…&p=…&dir=…`), unit-tested; `urlFor` and
   `applyUrl` in `src/main.ts` handle the new kind, so Back and shared links
   work like vehicle/stop panels.
3. `src/views.ts`:
   - extract the strip DOM used by `vehicleView` into a shared internal
     builder;
   - add `journeyView(detail, focusIndex, opts)`: every stop with its time
     (realtime where the feed has it, delay marks), cancelled stops struck
     through, no live vehicle marker; the stop whose board was open is marked
     `is-focus` (accent dot + bold name). Rows stay tappable into their own
     boards.
4. `src/main.ts`: `applyTarget` for `journey` shows a loading header
   immediately, fetches the detail once, renders the strip, draws the route
   polyline on the map (`setFocusRoute`), rings the focus stop, and eases the
   camera there only if it is far away. No follow mode, no per-poll refetch:
   this is a point-in-time schedule; live counts remain the board's job.
5. A vehicle that later appears on the map while its schedule is open stays a
   schedule (closing and re-tapping from the board is the live path).

### Files

- `src/views.ts` — strip refactor + `journeyView`
- `src/main.ts` — target kind, URL handling, render path
- `src/url.ts` + `src/url.test.ts` — journey link codec
- tests in `src/views.test.ts` (pure focus/helpers)
- `src/style.css` — `is-focus` styling

### Verification

- `npm test`, `npm run build`
- open a station, tap a departure that is still minutes away: panel shows the
  full schedule, my stop highlighted, route drawn; Back returns to the board;
  reload on the shared URL re-opens the schedule.

---

## Item 4 — remember the filters

### Current state

Only the camera persists (`localStorage['liveberlin.mapview']`). Type and line
selections reset to the rail-only default on every load.

### Change

1. New pure module `src/prefs.ts`: encode/decode/validate the saved filter
   state (`{types, lineMode, lines}` under `localStorage['liveberlin.filters']`)
   against a caller-supplied storage, so tests run without DOM.
2. `src/main.ts` applies saved filters at boot **before** the URL view state,
   and `decodeViewState` fields override the saved ones — a shared link always
   reproduces itself.
3. Every filter mutation (All types, one type, All lines, one line, a line
   search result, reset) writes the current state back.
4. A **Reset** button in the filter panel restores the rail-only default and
   clears the saved state; the camera is untouched.
5. Bandwidth note for the code: saving a bus-heavy choice is deliberate — the
   poll gates on the same `filters`, so a browser only pays for the groups the
   user actually switched on.

### Files

- `src/prefs.ts` + `src/prefs.test.ts` — new
- `src/main.ts` — boot order, save hooks, Reset action
- `src/style.css` — Reset button row

### Verification

- `npm test`, `npm run build`
- tick Bus, reload: Bus still on and its group fetched; a shared `?types=…`
  link overrides the saved state; Reset returns to rail-only and clears storage.

---

## Item 7 — line-level / global notices from the radar

### Current state

Station boards parse `common.remL` + `remX` notices (`src/journey.ts`), but the
radar drops them. Live capture 2026-09-07 confirms the radar has the same
shape: `jnyL[].msgL[].remX` → `common.remL[]` (today all occupancy codes).

### Change

1. New shared module `src/notice.ts`: `NoticeKind`, `StationNotice`, rem
   classification, `noticeFromRem`, dedupe, plus
   `parseJourneyMsgL(msgL, remL)`. `src/journey.ts` imports from it (no
   behaviour change); `Vehicle` gains an optional `notices` field parsed by
   `transformJourney` (occupancy and OPERATOR rows filtered out this round).
2. `src/hci.ts` passes `common.remL` through; aggregation helper
   `aggregateLineNotices(vehicles)` (pure, tested) folds per-vehicle notices
   into a per-`lineKey` list.
3. UI, all fed from one per-poll map so it stays in sync:
   - **vehicle panel**: a red notice banner above the strip when the vehicle's
     own journey carries a construction/disruption/elevator notice;
   - **Line menu**: rows for a disrupted line get a small ⚠ and the notice text
     as a tooltip;
   - **search**: line results carry the same mark;
   - **map**: when any enabled line has a severe notice, a compact alerts pill
     appears top-left (`⚠ N lines · disruptions`); tapping it opens a small
     popover whose rows (line badge + text) apply that line filter.
4. Notices are refreshed by every poll; no extra requests anywhere.

### Files

- `src/notice.ts` + `src/notice.test.ts` — new shared parser/aggregator
- `src/vehicle.ts` — `Vehicle.notices`, rem parsing in `transformJourney`
- `src/hci.ts` — rem passthrough
- `src/journey.ts` — import shared notice helpers
- `src/views.ts` — vehicle notice banner
- `src/main.ts` — line notice map, menu/search marks, alerts pill + popover
- `src/style.css` — banner, marks, pill/popover
- fixtures in tests are shaped like the captured radar payload

### Verification

- `npm test`, `npm run build`
- synthetic radar fixture produces line notices; menus/pill/vehicle banner
  appear; tapping the pill focuses the line; a quiet feed shows nothing.

---

## Item 3 — share preview, installable shell, fast return visits

### Current state

`index.html` has only `charset`, `viewport`, `title`, `favicon`. Sharing a link
produces a bare preview; Android chrome is unthemed; no manifest or service
worker.

### Change

1. `index.html`: `meta description`, `theme-color`, OG/Twitter tags (absolute
   URLs to the live project page and `og-image.png`), `apple-touch-icon`,
   `manifest` link.
2. Raster assets generated once by a small Pillow script
   (`scripts/make-icons.py`, committed outputs):
   `public/icon-192.png`, `public/icon-512.png`, `public/apple-touch-icon.png`
   (180), `public/og-image.png` (1200×630, rendered from the app's blue +
   badges identity, DejaVu text).
3. `public/manifest.webmanifest`: name/short_name/description, `start_url` and
   `scope` relative, standalone display, theme/background colours, icons.
4. `public/sw.js` + registration from `src/main.ts` (production only):
   - precache the stable shell (index, css/js after first load, geometry JSON,
     maplibre workers, icons, manifest);
   - navigations are network-first (a deploy is picked up immediately), other
     same-origin GETs are cache-first with background refresh;
   - old cache versions are deleted on activate; VBB calls are cross-origin and
     never cached.

### Files

- `index.html`
- `public/manifest.webmanifest`, `public/sw.js` — new
- `public/icon-*.png`, `public/apple-touch-icon.png`, `public/og-image.png` —
  new, generated
- `scripts/make-icons.py` — new, documented
- `src/main.ts` — SW registration

### Verification

- `npm run build`: assets appear in `dist/`
- `npm run preview`: DevTools shows the manifest, SW activates, offline reload
  serves the shell; VBB requests never hit the cache
- meta tags render in the published page after the next deploy

---

## Suggested order

1. Item 6 (visual layer + touch, everything else sits on it)
2. Item 5 (board chips — small, pure helpers first)
3. Item 2 (schedule view — strip refactor)
4. Item 4 (filter persistence)
5. Item 7 (notice parsing + UI — largest surface)
6. Item 3 (meta/PWA/icons — independent, do last)

Each step lands independently, keeps `npm test` and `npm run build` green, and
is verifiable in isolation.

## Definition of done

- `npm test` green
- `npm run build` green
- manual pass on phone-sized and desktop viewports for every item above
- no change to animation, track selection, the 20 s poll interval, the estimate
  note, or the accuracy copy

## Implementation notes

- The board chips narrow only the rendered rows; the chosen line survives a
  quiet board refetch and falls back to All when the line leaves the hour.
- A not-yet-departed departure opens a `?journey=` schedule panel; the URL
  carries the line/mode/direction and the stop the rider came from, so a
  reload re-marks "your stop" without a board in the history stack.
- Filter prefs are read before the URL view state, so a shared link always
  wins over a saved preference; Reset clears the stored state and restores the
  rail-only default.
- Radar notices reuse the station-board classifier via `src/notice.ts`;
  occupancy is filtered out by the parser and stays a separate feature.
  The global pill shows only construction / disruption / elevator kinds; the
  vehicle panel shows every non-occupancy notice the journey carries.
- The settings panel is a sliding bottom sheet on compact windows; rows and
  tappable strip rows carry 44 px hit zones on coarse pointers. CSS-only,
  no new dependency.
- The service worker caches only same-origin static assets, network-first for
  navigations; the VBB gate is cross-origin and is never cached. Bump
  `VERSION` in `public/sw.js` when the precache/strategy changes.
- `public/icon-*.png`, `apple-touch-icon.png` and `og-image.png` are committed
  and regenerated with `scripts/make-icons.py` (Pillow + DejaVu), which is a
  one-off maintenance script, not part of the build.

# Redesign interaction and acceptance checklist

Source audit: 2026-09-22. Current `src/main.ts`, `panel.ts`, `views.ts`, `search.ts`, `prefs.ts`, `url.ts`, `notice.ts`, and `style.css` take precedence over historical AGENTS notes. This document describes product constraints, not prescribed visual layouts.

## Product baseline

- English interface; German place names, destinations, and operator notices remain as supplied.
- Berlin map of calculated transit positions, using timetable plus live delays and operator forecasts. Positions are **not GPS**. Keep the existing explanation in journey content: “Times and position come from the timetable plus the live delay, not from GPS.”
- Seven supported types: S-Bahn, U-Bahn, Tram, Bus, Ferry, Regional, ICE / IC. First visit defaults to S-Bahn, U-Bahn, Tram and all their lines. Other types remain available to enable.
- Normal map, searching, vehicle detail, station departures, and future-service schedule are distinct states of the same app. No account, trip planner, ticket buying, occupancy display, favorites, manual follow toggle, or new navigation destinations are current features.
- Keep VBB attribution with CC BY 4.0/modified credit and linked source, plus linked OpenStreetMap attribution.

## Map and controls

- [ ] Pan, zoom, touch gestures, and resizing work with the map as the main workspace.
- [ ] Vehicles retain published line colors and readable black/white text; a theme must not replace route identity colors with a single accent. At wide-area zooms below 13, compact dots reduce clutter; selected vehicle remains recognizable.
- [ ] Click/tap or keyboard Enter/Space on a vehicle opens its detail. Selected marker is emphasized, others dim; close restores normal markers.
- [ ] Station points open the station board. A station click must not immediately trigger background-map dismissal.
- [ ] Routes and Stations are independent visibility toggles, initially on. Hiding stations also removes their invisible click targets.
- [ ] Locate requests device position and centers once, without following the user continuously; denied/unavailable permission leaves the map usable.
- [ ] User-chosen map center/zoom survive reload; automatic vehicle following must not overwrite the saved user view.
- [ ] Map control, attribution, and selected subject remain usable and visible around overlays, at both screen sizes.

## Search

- [ ] One global search finds indexed stations and currently known running lines as the user types. It is local/synchronous; do not introduce a required network search or artificial loading step.
- [ ] Search is case/accent insensitive; e.g. “alex” finds Alexanderplatz, “muggelsee” can find Müggelsee. Results rank exact/prefix matches ahead of weaker matches; lines get precedence when appropriate. Maximum 20 results.
- [ ] Empty input closes results. Nonempty unmatched input shows “Nothing found.”
- [ ] Line result shows its name, mode, identifying color, and severe-alert indicator when present. Same-name lines belonging to different modes stay distinct.
- [ ] Picking a station clears/blurs the search and opens that station's departures, moving the map there without reducing a user's already-close zoom.
- [ ] Picking a line clears/blurs search, closes unrelated detail, enables the line's type, selects only that line, persists filters, and fits its vehicles in view. It does not clear the other type checkboxes.
- [ ] Enter chooses the top result; Escape clears/closes search and blurs it. Tapping the map closes results.

## Type and line filters

- [ ] Type always offers **all seven types**, including disabled modes not currently fetched. Multi-select must remain touch-friendly and not require Ctrl/Cmd selection.
- [ ] “All types” toggles every type. None selected means an empty vehicle map.
- [ ] Line offers running lines of enabled types, grouped by type, naturally sorted (U9 before U12), keyed by mode **and** name. A bus named S9 and an S-Bahn S9 are separate choices.
- [ ] Type/Line summaries reflect all, none, named small selections, or counts. Current Type uses names up to two selections, counts thereafter; Line uses names up to three.
- [ ] “All lines” follows the evolving network: newly observed lines automatically appear selected. Selecting individual lines enters explicit selection; selecting every available line returns to all mode.
- [ ] Unticking “All lines” selects none, rather than interpreting empty selection as all.
- [ ] Switching off a type removes its offered lines and picks. Enabling a type requests fresh data promptly; stale off-mode line rows should not reappear before a sighting.
- [ ] A missing running line lingers for 60 seconds. In custom selection, a line that stops running can return selected; summaries count only currently offered lines.
- [ ] Line search filters offered rows, not selection scope: “All lines” still controls every selectable line even with a query. Search input retains caret/focus when rows update.
- [ ] Initial/no-line state has an explanation; unmatched line query has a specific no-match message.
- [ ] Type/line selections persist across reload. Valid URL parameters override stored preferences. Invalid stored data falls back safely.
- [ ] Reset returns to rail defaults and all lines, and forgets saved filters. It does **not** reset camera or layer visibility.

## Live vehicle detail

- [ ] Header includes line, mode, destination, and a fixed next-stop/arrival-clock/countdown summary when available.
- [ ] Loading route, route unavailable, route request failure, stale/expired vehicle link, and journey finished while open have understandable states.
- [ ] Full journey lists stops, times, signed delay minutes where meaningful, cancelled/passed/next-stop states, and an animated vehicle indicator matching map progress.
- [ ] Opening brings the current segment into the list viewport. Refresh preserves reader scroll rather than jumping to the start.
- [ ] Vehicle delay and available notices are readable. Position-estimate explanation remains visible in the content.
- [ ] Tapping a stop in the journey opens that stop's board; Enter/Space support remains.
- [ ] Selected route is drawn on the map. Map initially glides to vehicle, then keeps it within unobstructed map area only when needed.
- [ ] Following yields during gestures, inertia, and a short settling period. Do not continuously recenter while the user is dragging.

## Station departure board

- [ ] Station name and departures context are clear. Opening shows loading; initial failure shows an error; no upcoming departures says “Nothing due here in the next hour.”
- [ ] Board covers the next hour, independently of map type/line filters, grouped by mode and ordered by time within each mode.
- [ ] Each departure shows line identity, direction, clock time, countdown, platform when supplied, meaningful signed delay, and notice indicator when supplied.
- [ ] Cancelled departures remain visible and labelled cancelled; they are not selectable. Departures already gone disappear.
- [ ] Station notices remain visible. With multiple upcoming lines, board chips select one line or All; this is independent of map filters.
- [ ] Fresh board data preserves scroll and selected chip where still valid. If the selected line disappears from refreshed data, fall back to All.
- [ ] A failed background board refresh keeps previously loaded content instead of replacing it with a blank/error page.
- [ ] Selecting a running departure opens that vehicle's live detail. Selecting a service absent from current radar opens its **full schedule**, not an unavailable-vehicle error.

## Future-service full schedule

- [ ] Show line/mode/destination and “Your stop” context inherited from the board.
- [ ] Full stop strip includes times, delays, cancellations, and an emphasized “your stop” row; scroll to that row on opening.
- [ ] No moving-vehicle indicator is invented for a vehicle absent from radar.
- [ ] Show available route geometry and originating stop on the map; stops remain navigable into their boards.
- [ ] Loading and schedule-unavailable/failure states are covered.

## Notices, connection, and sharing

- [ ] Aggregate construction, disruption, and elevator notices into an available line-alert control; count affected lines, not notice messages. Hide it when no severe alerts exist.
- [ ] Alert list shows line identities and notice text. Selecting an alert focuses/filters that line exactly like line search. Map click dismisses list.
- [ ] Severe notices also appear on matching line filter/search results. Current occupancy data is intentionally not displayed.
- [ ] Healthy ordinary map hides engineering status. Stale/offline states explain that positions may be old; a capped feed says some vehicles are missing. Counts, age, and full diagnostics belong to debug.
- [ ] Keep ordinary refresh around 20 seconds, pause polling while backgrounded, resume stale data on return, and preserve existing bounded animation/coasting. No cosmetic change may create continuous stale movement or multiple polling loops.
- [ ] Copy link includes current type/line filters, camera, and open vehicle/stop/schedule target. Native share sheet is used when available; clipboard fallback briefly reads “Copied”; cancelling native share is quiet.
- [ ] Journey links preserve line/mode/destination and origin-board stop context. Vehicle links are ephemeral and explain a journey that is no longer running.

## Responsive navigation and browser QA

- [ ] Verify at desktop, narrow desktop/tablet, and phone widths, plus short/landscape windows. Existing compact breakpoint is 720px; exact visual arrangement may change, but content and control access may not.
- [ ] Current desktop detail occupies a side column; phone detail uses a bottom sheet, with live-vehicle detail shorter so map remains useful. A redesign must retain the ability to read details **and** identify/follow their map subject.
- [ ] Current desktop settings remain visible; phone settings open/close from a labelled Settings control. Settings can be dismissed by close or map tap.
- [ ] Detail Back moves one in-app detail step; Close/Escape/map-background tap exits the entire detail stack. Back is offered only when an earlier in-app panel exists.
- [ ] Browser Back/Forward restores nested stop → vehicle/service → stop navigation. Closing a directly opened shared detail never sends the user to another site.
- [ ] Closing or switching detail aborts pending requests; late responses must not overwrite the newer panel.
- [ ] Open panel refreshes countdowns without resetting header, scroll position, or triggering repeated map glides. Returning from background refreshes countdowns promptly.
- [ ] Maintain accessible names for inputs, vehicle markers, close/back/settings buttons; native checkboxes, pressed state on board chips, expanded state on overlays, and visible keyboard focus.
- [ ] Detail is a nonmodal dialog: map remains interactive. Touch targets, scrolling, phone safe-area spacing, soft-keyboard search, long German names/notices, and reduced-motion styling need browser verification.
- [ ] Preserve development/query-only debug entry and recorder controls without exposing them as primary production UI.

## Existing implementation limits to distinguish from redesign regressions

These are observations, not additional product scope or features for Stitch to invent:

- `encodeViewState` currently omits an empty custom line selection, so sharing “no lines” can restore all lines on a fresh browser. Flag separately if behavior is touched.
- With all modes off, line hint currently reads “waiting for live data…” because sightings are pruned; the empty-map intent remains deliberate.
- Search supports Enter/top result and Escape, but does not currently implement Arrow-key traversal of result rows. Do not claim that existing feature in design context.
- Detail body replacement every five seconds preserves scroll, but not necessarily focus on a replaced row; keyboard focus retention deserves verification during integration.
- Board data refresh follows successful map polls; ordinary board countdown updates run every five seconds. Future-service schedule itself is not continuously refetched.
- Route/station visibility, board chip, and search input are not included in shared state or persisted preferences.

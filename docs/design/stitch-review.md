# Stitch design review

Project: https://stitch.withgoogle.com/projects/641605759907392717

## Round 1 — desktop

Screens: `92a259ba4b1a45f69fc0b865dd77a236` (map), `66ee785c27ae434c9d24649ce45bfdc9` (vehicle).

Visual direction: Berlin Transit Modernism, light surfaces, Inter typography, clear information hierarchy. Initial artwork was reviewed as screenshots and exported HTML.

Functional review sent to Stitch:

Review of both desktop screens: retain your chosen bright visual direction. This revision is about product fidelity, not prescribing layout.
Remove unsupported features in screens AND any design-system guidance: occupancy/load, vehicle speed, vehicle IDs, manual auto-follow switch, always-visible station preview/synchronized board, dedicated Departures/Lines & Routes navigation tabs, audio search, Cmd-K shortcut, Disrupted Only, navigation/route planner, new pages, API-health/live telemetry status, GTFS-RT attribution, privacy/data-source links not present. Only one user-selected detail is open; no station board should appear until the user selects that station.
All seven modes must be available including ICE / IC (currently omitted). Type and Line both need multi-select with All and none semantics; don't replace these with single-selection navigation. No per-mode vehicle counts in ordinary UI. Preserve Routes and Stations visibility, Reset filters, Copy link, location, search and severe line alerts.
Normal healthy screen has no Live Status/telemetry counter. Display warning only for stale/offline/capped feed.
The vehicle title must identify U8 and mode, destination, next stop, time/countdown and actual delay, not simultaneously 'On track/on-time' and late. Full list remains scrollable, all stop rows tappable. Passed stops are not cancelled: reserve strikethrough for cancelled stops. No transfer badges/platform data on the journey unless supplied by current product; platform is supported on station departures. Keep the exact not-GPS explanation.
Back steps to the prior detail (only if one exists), Close exits all details. Preserve these distinct controls. Use official per-line colors, not uniform blue for every U line: U8 is #224f86; U4 is #f0d722 with black text; ICE/IC uses #7d8185. Text on line color is black or white according to contrast, not always white.
Existing map is geographic OpenStreetMap raster, not a schematic metro diagram; use a realistic geographic map context. Attribution must link OpenStreetMap and VBB (CC BY 4.0, modified). Do not claim GTFS-RT powers the map.
Do not add controls for new functionality. Make these two desktop screens faithful to existing functionality. Other states will be requested next.

First edit request encountered an HTTP 502 transport failure; check project for results before retrying.

## Round 2 — desktop and mobile

After waiting and confirming no revision, resubmitted through screen generation. Produced:

- Desktop - Live Map Default View: a3a599592ff147e6bce510ef7c3e73e4
- Desktop - Vehicle Journey U8: 5e20c3bbd75a4854b6cb3df46f07c34c
- Desktop - Station Departures Alexanderplatz: 2339989a56434bdcbf9c14cc7c2e98ce
- Mobile - Live Map Default View: 0f2a0df4de3b49be81bc254c433938ce
- Mobile - Selected Vehicle Journey: a577953118fd4a54bd727626056ffcfd

Core visual direction is usable; remaining functionality corrections sent to the design agent:

Final functional corrections to these desktop and mobile core screens. Preserve your visual style; do not add features. Every screen shares the same app functionality and controls:
- Remove all normal healthy badges: Live Status, Live Map, Live Line Tracking, Live Prognose, Vehicle Telemetry. No invented bookmark/favorite or manual follow. No transfer/platform fields on vehicle journey. Warnings only stale/offline/capped.
- All interface labels in English (e.g. Next stop, Journey, In transit); German only actual stop/destination/notice content. No extra "Show next departures" footer action: stops themselves are tappable.
- Default map: include Type AND Line multi-select with select-all/none and line search; all seven types accessible. No clipped Filters control or horizontal page overflow on mobile. Reset filters and Copy link remain accessible.
- Desktop detail header currently replaces filter controls with unrelated All Modes tabs; keep same existing map controls consistently. Only one selected detail at a time.
- Departure board grouped by mode then time; keep independent All/line chips, notices, platforms, delay, cancellations. Remove bookmark.
- Actual line color identities retained (U8 #224f86, U4 #f0d722 black text); never replace them by arbitrary theme colors.
- Live vehicle on phone needs useful visible map AND scrollable full journey (not a mostly hidden map). Back and Close distinct, no dead Back when no previous detail.
- Existing raster map should look geographic. No distorted giant black filled paths.
- Keep exact not-GPS note, and linked OpenStreetMap plus VBB CC BY 4.0 modified attribution.
Please apply only these corrections to the selected screens; no new features.

## Reviewed core designs

Latest core screens (visual references; actual product behavior remains governed by the brief and checklist):

- Desktop - Live Map Default View (Faithful): `9291d2d2467e40929ab723cdf8ac2688`
- Desktop - Vehicle Journey U8 (Faithful): `3e71059042d846ee9d47b3e01f3c2e20`
- Desktop - Station Departures Alexanderplatz (Faithful): `da555c948342479db526e3c2badead54`
- Mobile - Live Map Default View (Faithful): `b2b786005bad46c9b53f8e0098c77a88`
- Mobile - Selected Vehicle Journey U8 (Faithful): `d241df0eb1dd4463994b023eb18ebe41`

The generated mockups still contain inconsistent sample content and some clipped phone controls despite claimed fixes. Integration uses the reviewed visual direction, real map tiles, actual data and existing behavior; it does not reproduce those defects. Additional feedback to Stitch removes intermediate Station Info/Zoom steps, unsupported address/zone/via/operator metadata, Berlin & Brandenburg scope, and unlinked/placeholder attribution. The normal map must show only vehicles of selected types. Search results, line-alert list and empty/error state designs were requested separately.

## Final supporting-state review

Mobile settings, departure board and future-service schedule were generated, inspected and revised. The initial settings Apply step was explicitly removed because selections already apply instantly. English UI, Back/Close, master checkboxes, grouped departures and the distinction between a future schedule and a live vehicle remain required. Unsupported sample timetable metadata is not imported into the app.

Desktop search, line alerts and an initial departure error state were generated and revised after screenshot/HTML inspection found fake health counters, refresh buttons and state-simulation controls. These were sent back for removal. Final supporting references use the same light surfaces, restrained accent, structured result/notice rows and honest empty/error messaging. All final reference IDs are recorded in `stitch-screens.json`.

Scope decisions: preserve the real OSM raster map, live line colors/contrast and existing data-rendering loops. Reuse the new visual shell for loading/empty/error messages, rather than implementing mockup state-switchers or hardcoded sample data. No dark-mode variant, new product feature or provider change is included.

Also requested dedicated mobile settings, station board and future-service schedule states, plus representative empty/error states. Browser baseline: 301 unit tests pass; 10 deterministic browser checks pass across desktop, phone and narrow window, plus separate live-feed load with 162 vehicles and no page errors. Deterministic checks use saved radar and synthetic board/schedule data; they do not validate the live provider.

# wo ist die bahn — redesign brief
Stitch project: https://stitch.withgoogle.com/projects/641605759907392717
Project ID: 641605759907392717

## Design assignment
Create a fresh visual design for the existing Berlin transit web app "wo ist die bahn". Bright, optimistic, welcoming, clear and accessible. Design for both desktop and mobile. You own all visual decisions: layout, typography, palette, spacing, imagery and component treatment. This brief specifies product behavior, not a prescribed visual solution. Preserve existing capabilities and interaction semantics. Use English interface copy, with actual German station and destination names. This is an operational interactive map, not a landing page. Do not invent features or data.

## Product and map
People see where Berlin public transport is moving, find a line or stop, inspect a vehicle's journey and check departures.
Seven modes: S-Bahn, U-Bahn, Tram, Bus, Ferry, Regional, ICE / IC. Default selection is S-Bahn, U-Bahn, Tram, with all their lines. Other modes can be enabled.
Map can pan and zoom; vehicles move smoothly and use official line colors with readable black/white lettering. At wider zoom vehicles become dots; selected vehicle remains identifiable and other vehicles are subdued. Station markers are tappable at closer zoom. Routes and Stations have independent visibility controls.
Geolocation centers once on the user's location; it is not continuous user tracking. Denial leaves the map usable.
Map is a real OpenStreetMap raster map: roads, water, parks and labels come from existing map tiles. Keep geographic context and legible places. VBB CC BY 4.0 and OpenStreetMap attribution must remain accessible.
Vehicle positions are estimates derived from timetable and live delays, not GPS. Vehicle and schedule details must retain: "Times and position come from the timetable plus the live delay, not from GPS."
No accounts, favorites, journey planning, ticket purchasing, GPS accuracy promises, occupancy displays or new navigation destinations are part of this redesign.

## Search
One search supports stops and currently known running lines; results distinguish stop vs line and mode (a bus and train can both be named S9).
Typing shows matching results; no matches has a clear empty result. Keyboard Enter selects first result and Escape clears/closes. Tapping elsewhere on map dismisses search.
Selecting stop opens that station's departures and brings the station into view. Selecting line enables its mode, filters the map to that line, and frames its currently running vehicles.

## Map filters and settings
Type and Line are independent multi-selection controls with individual checkboxes and select-all. All seven types remain available even when off. Show current selection when collapsed.
Line selection only offers currently running/known lines of enabled types, grouped by mode, naturally sorted (U9 before U12). Up to hundreds of lines: line-search is necessary and must keep its focus while choices update.
An empty selection means show none. All lines means current and newly appearing lines are selected automatically. Switching off a type removes its hidden line picks. All lines applies to every selectable line, even if a line search hides some.
Reset restores rail-only defaults and all lines, forgetting saved filters; it is not a camera reset.
Routes, Stations, Copy link and Reset remain available. Filters and user camera position are remembered. Shared URL explicitly overrides saved preferences.

## Vehicle details
Tap a vehicle to open its full journey and highlight its route on the map. Present line/mode, destination, next stop, estimated arrival clock time and countdown, delay/early running and service notices when provided.
Full stop list contains stop names, times, delays and cancellations; distinguish passed and upcoming stops and indicate current progress between stops. Stops are readable even for long journeys. Open near current position in the list.
Tap a stop in the journey to open its departure board. The selected vehicle and its position in the list stay synchronized.
Keep enough map visible on mobile to actually follow the vehicle while reading its details. The camera only recenters when it approaches the visible map edge and pauses during user gestures; controls must not cover the tracked subject.
Loading route, unavailable full route, request failure and vehicle no longer running all need honest states. Unknown times should not be invented.

## Station departures and schedule
Tap a station on the map or select it in search to see upcoming departures, with station name and notices. Departures grouped by mode and time, carrying line color/name, destination, platform if supplied, clock time, countdown, delay and cancellation.
Board has a single-line filter plus All when multiple lines are present; this is independent of the map multi-select. Cancelled departures remain visibly cancelled and are not tappable.
A non-cancelled departure opens its running vehicle when found; otherwise opens the full schedule for that service (including services that have not started). A schedule highlights the station the user came from as "your stop", shows route and stops, and allows opening another stop's board.
The board refreshes in place without resetting scrolling or flashing loading; background refresh failure preserves existing board. Initial loading, initial error, and no departures in the next hour need designs.

## Navigation, notifications and sharing
Details can form a chain: stop board -> vehicle/schedule -> another stop. Back goes one step, Close returns to map from any depth. Browser back/forward and phone back gestures mirror this navigation. Escape or empty-map tap dismisses details.
Vehicle/stop/schedule URLs are shareable; vehicle links can expire when journey ends. Copy link uses native sharing when supported and clipboard otherwise, carrying camera, map filters and open detail, with copied feedback.
Severe service notices have a map-level line-alert entry. Opening it lists affected lines and their notice text; selecting one focuses that line. Notice cues also appear in search/filter results. Notices can be long German text.
Normal operation does not need vehicle counts or seconds-since-refresh UI. Stale, offline and capped-feed warnings must be visible when relevant; avoid an unconditional healthy status when data is unknown.
Debug tools are dev-only or explicitly requested by URL: preserve capability in implementation, no need to feature them in public design.

## Experience coverage
Please produce coherent desktop and mobile designs, covering:
- Default live map, with search and access to filters, location and sharing.
- Search results and expanded multi-select filters/settings.
- Selected vehicle with full journey and meaningful visible map.
- Station departure board and full-schedule detail.
- Service alerts and representative loading/empty/error states.
These are states of one app, not unrelated pages. Prioritize functional consistency and readable real content. Long station names, many lines, narrow screens, touch targets, keyboard focus and scrolling must work.

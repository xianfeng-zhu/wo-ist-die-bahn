# wo ist die bahn

Live map of every Berlin transit vehicle: S-Bahn, U-Bahn, tram, bus, ferry,
regional and long-distance trains. About 1,100 of them at once.

A static web app. There is no backend: the browser polls VBB's live endpoint
directly every 10 seconds, and moves each vehicle in between using the operator's
own short-term forecast. Nothing about the motion is invented from a timetable.

S-Bahn, U-Bahn and trams follow their real GTFS track. The other modes follow the
operator's forecast polyline, which is road geometry for the next 30 seconds.

**Live:** <https://xianfeng-zhu.github.io/wo-ist-die-bahn/>

## Build

```sh
npm install
npm run build          # -> dist/
npm test               # 197 tests
npm run dev            # http://localhost:5173
```

The transit geometry is committed, so you do not need to generate it. To refresh
it from the current VBB feed:

```sh
npm run prepare:data   # downloads ~600 MB of GTFS, writes public/*.json
```

That script refuses to write if its checks fail, so a bad feed cannot overwrite
good data.

## Deploy

GitHub Pages is set up in `.github/workflows/deploy.yml` and publishes on every
push to `main`.

A project site is served from `/<repo>/`, not the domain root, so `vite.config.ts`
sets `base` accordingly. For any other host, override it:

```sh
BASE_PATH=/ npm run build
```

- Cloudflare Pages: build `BASE_PATH=/ npm run build`, output `dist`
- Netlify: build `BASE_PATH=/ npm run build`, publish `dist`

## Data and licences

The code is MIT licensed. **The data is not ours.** Full details, including the
list of modifications CC BY 4.0 requires, are in
[ATTRIBUTION.md](ATTRIBUTION.md).

In short:

| What | Source | Terms |
|---|---|---|
| Live vehicle positions | VBB HAFAS, `fahrinfo.vbb.de/gate` | Not a sanctioned integration — see below |
| Route and station geometry | VBB GTFS + Linienfarben | CC BY 4.0, modified |
| Map tiles | OpenStreetMap | ODbL, OSMF tile usage policy |
| Map library | MapLibre GL JS 6.4.1 | BSD-3-Clause, see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) |

### If you deploy this, read this first

The app queries an **undocumented** VBB endpoint using VBB's own public web-app
identifier. That identifier is not a credential issued to this project, and this
is not an integration VBB has approved.

VBB's documented route is a registered REST API: you describe your project, get
test access, and agree to their usage rules before production access.
<https://unternehmen.vbb.de/digitale-services/api/>

**Register with VBB before running a public deployment.** Their conditions
include querying efficiently, naming VBB as the source of the timetable data, and
accepting that access can be withdrawn.

**Every mode costs bandwidth.** Showing all of them takes three requests per
poll — the gate caps one response at 1,000 journeys, and Berlin runs more
vehicles than that — which is about **2.2 MB every 10 seconds**, or 13 MB a
minute per open tab. Polling stops while the tab is hidden. If that is too much
for your deployment, the levers are: raise `POLL_INTERVAL_MS`, drop a mask from
`PRODUCT_GROUPS` in `src/hci.ts`, or fetch the visible viewport instead of all of
Berlin (`BERLIN_BBOX` in `src/main.ts`).

The map tiles come from the OpenStreetMap Foundation's servers, which are
donation funded and carry no availability guarantee. If your fork attracts real
traffic, point `src/main.ts` at your own tile source.

## How accurate is a vehicle's position?

Less than the map suggests, and the limit is the data, not the drawing.

**VBB publishes no measured positions.** Every dot is computed from the timetable
and the live delay. Checked three ways: asking the endpoint for reported positions
only (`trainPosMode: 'REPORT_ONLY'`) returns zero vehicles across all seven modes;
the official VBB GTFS-Realtime feed carries 7,232 trip updates and no vehicle
positions; and the endpoint's own 30-second forecast agrees with the position it
later calculates to a median of 7 m, which a feed fed by real telemetry would not.

**Every stop time in the feed is a whole minute** — 1,762 of 1,762 checked — and
tram stops are 1 to 3 minutes apart. So between two stops the position comes from
two numbers: leave at minute X, arrive at minute Y. The rounding alone is ±30
seconds, which at tram speed is ±200 m, before the real vehicle's own accelerating
and waiting at red lights.

**It gets worse the less often a mode stops**, because the interpolation has
further to stretch. Metres covered per scheduled minute, and what ±30 s of
rounding is worth:

| Mode | Stop gap | Per minute | Rounding alone |
|---|---|---|---|
| Tram | 2 min | 286 m | ±143 m |
| Bus | 1 min | 316 m | ±158 m |
| U-Bahn | 2 min | 400 m | ±200 m |
| S-Bahn | 2 min | 603 m | ±301 m |
| Regional | 10 min | 1,077 m | ±539 m |
| ICE / IC | 67 min | 1,849 m | ±924 m |

**What that means in practice.** The map is dependable at stops, and the delay
figures are real. Mid-segment, expect a tram or bus to be a block or two from
where you can see it, and a long-distance train to be kilometres out. Each popup
says the position is estimated.

**What is not the cause.** The app's own error is small. Measured live per mode,
comparing the position drawn against the operator's position the moment a poll
lands: bus median 1.4 m, U-Bahn 2.9 m, S-Bahn 3.6 m, tram 3.8 m. The forecast
sits a median 2.5–3.7 m from the track the app picks. It follows the right
street; it cannot know how far along it the vehicle really is.

## Checking vehicle movement

Watching the map is unreliable, so movement is measured instead:

1. Open the app with `npm run dev` (or add `?debug=1` to the built site — the
   debug controls are not shown to visitors), tick **Debug view**, then tick
   **Record motion**.
2. Leave it running. 15 minutes is plenty; longer catches rarer faults.
3. Click **Save log** — the browser downloads an `.ndjson` file.
4. `node scripts/analyse-motion.mjs <file> [--vehicle 75416-24]`

The report lists teleports, reversals, freezes, implausible speeds, station
dwells, per-vehicle journeys, and the drift between the position drawn on the map
and the position the operator reported. Fault detection runs on every animation
frame; the position trace is sampled at 5 Hz (`?traceHz=N` to change).

This harness found and then verified the fixes for every motion bug in the git
history, including a deadlock that froze vehicles for minutes. See
[AGENTS.md](AGENTS.md) for the measured invariants it established.

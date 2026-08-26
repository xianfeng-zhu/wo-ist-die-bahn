# wo ist die bahn

Live map of Berlin S-Bahn, U-Bahn and tram vehicles.

A static web app. There is no backend: the browser polls VBB's live endpoint
directly every 10 seconds, and moves each vehicle along its real track in
between, using the operator's own short-term forecast. Nothing about the motion
is invented from a timetable.

**Live:** <https://xianfeng-zhu.github.io/wo-ist-die-bahn/>

## Build

```sh
npm install
npm run build          # -> dist/
npm test               # 174 tests
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

The map tiles come from the OpenStreetMap Foundation's servers, which are
donation funded and carry no availability guarantee. If your fork attracts real
traffic, point `src/main.ts` at your own tile source.

## Checking vehicle movement

Watching the map is unreliable, so movement is measured instead:

1. Open the app, tick **Debug view**, then tick **Record motion**.
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

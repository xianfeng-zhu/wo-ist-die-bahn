# liveberlin

Live map of Berlin S-Bahn, U-Bahn and tram vehicles. Polls VBB's HAFAS endpoint directly from the browser every 20 s.

## Build
npm install
npm run prepare:data   # refresh stations/routes/line colors (needs network, ~82 MB)
npm run build          # -> dist/

## Deploy (static host)
- Cloudflare Pages: build command `npm run build`, output `dist`
- Netlify: build `npm run build`, publish `dist`
- GitHub Pages: works for root-served pages (user/org page or custom domain); for project pages set `base: "/<repo>/"` in vite.config.ts.

## Data
Live positions: VBB HAFAS (`fahrinfo.vbb.de/gate`). Network data: VBB GTFS + linienfarben (CC BY 4.0). Map: © OpenStreetMap contributors.

## Checking vehicle movement

Manual watching is unreliable, so movement is measured instead:

1. Open the app, tick **Record motion** in the settings panel.
2. Leave the browser running (15 min is plenty; longer catches rarer faults).
3. Click **Save log** — the browser downloads an `.ndjson` file.
4. `node scripts/analyse-motion.mjs <file> [--vehicle 75416-24]`

The report lists teleports, reversals, freezes, implausible speeds, station
dwells, per-vehicle journeys, and drift between the position drawn on the map
and the position the operator reported. Fault detection runs on every animation
frame; the position trace is sampled at 5 Hz (`?traceHz=N` to change).

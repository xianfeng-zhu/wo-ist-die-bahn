# liveberlin

Live map of Berlin S-Bahn, U-Bahn and tram vehicles. Polls VBB's HAFAS endpoint directly from the browser every 20 s.

## Build
npm install
npm run prepare:data   # refresh stations/routes/line colors (needs network, ~82 MB)
npm run build          # -> dist/

## Deploy (static host)
- Cloudflare Pages: build command `npm run build`, output `dist`
- Netlify: build `npm run build`, publish `dist`
- GitHub Pages: any static publish of `dist/`

## Data
Live positions: VBB HAFAS (`fahrinfo.vbb.de/gate`). Network data: VBB GTFS + linienfarben (CC BY 4.0). Map: © OpenStreetMap contributors.

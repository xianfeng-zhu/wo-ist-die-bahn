# liveberlin — Live Berlin Transit Map: Design

**Date:** 2026-08-20
**Status:** Approved (via brainstorming flow); architecture revised to frontend-direct per user decision 2026-08-20

## Goal

A public web app showing real-time positions of Berlin S-Bahn, U-Bahn, and tram vehicles on a live map. Vehicles move as data updates.

## Research findings (data sources)

| Source | Vehicle positions? | Access | Verdict |
|---|---|---|---|
| VBB GTFS-RT (`production.gtfsrt.vbb.de`) | No — TripUpdates (delays) only | Open, CC BY 4.0 | Not usable for positions |
| VBB official API (`api.vbb.de`) | `journeyPosition` per single trip only; no `radar` | Email registration + terms | Not usable for all-vehicles view |
| HAFAS `JourneyGeoPos` on `fahrinfo.vbb.de/bin/mgate.exe` | Yes — vehicles in bbox | **No CORS** → browser blocked | Server-side option only |
| HAFAS `JourneyGeoPos` on `fahrinfo.vbb.de/gate` | Yes — vehicles in bbox | **CORS `*` (verified)** | **Primary source** |
| Community `v6.bvg.transport.rest` | Yes | Free, rate-limited, volunteer-run | Unreachable during research; fallback only |

**Protocol (reverse-engineered from live captures, 2026-08-20):**
- Method is HCI `JourneyGeoPos` (not "radar"). POST JSON to `https://fahrinfo.vbb.de/gate?rnd=<ts>` with `ver 1.45`, `auth {type: AID, aid: hafas-vbb-webapp}`, `client {type: WEB, id: VBB, name: VBB WebApp, l: vs_webapp_vbb}`.
- Request: `{maxJny, onlyRT: false, date: YYYYMMDD, time: HHMMSS, rect: {llCrd: {x: westLon×1e6, y: southLat×1e6}, urCrd: {x: eastLon×1e6, y: northLat×1e6}}, perSize: 30000, perStep: 10000, ageOfReport: true, jnyFltrL: [{type: PROD, mode: INC, value: 7}], trainPosMode: CALC}`.
- **Product filter value 7** = rail only (S-Bahn bit 1, U-Bahn bit 2, tram bit 4; bus 8, ferry 16, express 32, regional 64). Verified: mask 7 → 283 rail vehicles (vs 778 all products).
- Response: `svcResL[0].res.common.{locL, prodL}` + `jnyL[]` with `jid` (tripId), `prodX` (→ `prodL[prodX]`: `name` = line name, `cls` = product bitmask), `dirTxt` (direction), `pos {x, y}` (position ×1e6), `stopL[]` (stopovers: `locX` → `locL[locX].name`, scheduled `aTimeS/dTimeS`, realtime `aTimeR/dTimeR`; delay = realtime − scheduled, minutes).
- `hafas-client` is **Node-only** (`node:buffer`, `https-proxy-agent` in `lib/request.js`) → cannot bundle in browser → hand-rolled HCI client (~80 lines), verified against `/gate` (283 vehicles, cls mapping 1/2/4 → suburban/subway/tram).

**Caveats (documented):**
- `/gate` is VBB's webapp endpoint, not a public API. CORS `*` today; VBB may rate-limit or block third-party browsers. No server-side mitigation possible in frontend-direct mode (client-side backoff only). If blocked: fallback is a tiny proxy or the community API.
- `trainPosMode: CALC` → positions are calculated/interpolated from schedule/prognosis, not raw GPS for all vehicles. Visually smooth; may be slightly off on long inter-stop gaps.
- Replacement-bus movements (e.g. "S9" bus during construction) carry product bit 8 → excluded by mask 7. S-Bahn *trains* unaffected.

**Webapp inspection (browser, 2026-08-20):** `vbb.de/en/vbb-travel-info/` is a TYPO3 landing page linking to `fahrinfo.vbb.de/webapp/` — a HaCon HAFAS webapp (Leaflet + OSM tiles). Its "Live map & Multi-mobility" view shows stations, routes, multi-mobility locations, traffic messages — no live vehicles. Same HAFAS backend and AID credentials as our client. VBB's public site does not expose a moving-vehicle map; our app adds `JourneyGeoPos`.

## Architecture (frontend-direct, per user decision)

Pure static SPA. No backend. Vite + vanilla TS + Leaflet. Deployed to any static host (Cloudflare Pages / Netlify / GitHub Pages / Vercel).

```
Browser (Vite SPA)
  └─ HCI client (hand-rolled): POST JourneyGeoPos to fahrinfo.vbb.de/gate every 20 s
       → parse svcResL (locL/prodL refs, j.pos)
       → Vehicle[] → render badges on Leaflet
  └─ static assets: stations.json, routes.json, line-colors.ts (from VBB GTFS + linienfarben)
```

## Update mechanism

- **Browser ↔ VBB: request-based polling, 20 s interval.** No push exists from VBB (HAFAS is request/response). One poll per browser tab.
- Client-side exponential backoff on consecutive failures (20 s → 60 s cap), stale/offline status in UI.
- Payload: raw response ~600 KB for full Berlin at peak (283 rail vehicles); parsed down to ~30 KB of Vehicle objects in memory. `maxJny` can be lowered (e.g. 400) at night.

## Components (frontend)

- **HCI client** — `buildRadarBody(bbox, {maxJny})` (pure, TDD), `parseRadar(json)` (pure, TDD, fixtures from real captures), `fetchVehicles()` (fetch wrapper with timeout + error surface).
- **Vehicle transform** — `{id: jid, line: prod.name, product: cls→suburban|subway|tram, direction: dirTxt, lat/lon: pos, nextStop: first upcoming stopL locX→name, delayMs: realtime−scheduled}`.
- **Map** — Leaflet + OSM tiles, centered Berlin; mobile-friendly.
- **Vehicle layer** — line-labeled badges ("S7", "U2", "M10") in official line colors (`line-colors.ts` from VBB `linienfarben`), mode-color fallback. Click → popup: line, direction, next stop, delay badge (red if ≥ 5 min).
- **Station layer** (toggle) — rail stops from GTFS `stops.txt`, dots, name popup.
- **Route layer** (toggle) — rail route polylines from GTFS `shapes.txt`, colored by line.
- **Mode filter chips** (S/U/tram) with live count; layer checkboxes; status bar (live/stale/offline, count, "updated N s ago"). English UI.

## Static data assets (build-time, committed)

- `web/scripts/prepare-data.mjs` — downloads VBB GTFS zip (~82 MB, verified; updated 2× weekly) from `unternehmen.vbb.de/gtfs`, extracts rail stops + route shapes (filter bus/regional by `route_type` + line-name pattern), emits `web/public/stations.json` + `web/public/routes.json` (GeoJSON, decimated). Downloads `linienfarben.zip` → generates `web/src/line-colors.ts`. Kept in repo for refresh.

## Error handling (client-side only)

- Fetch failure / timeout → exponential backoff (20 s → 60 s cap), status "offline"; keep last good vehicle set (badges stay, "updated Ns ago" grows).
- `svcResL[0].err !== OK` or missing `jnyL` → treat as empty poll, backoff.
- `pos` missing on a journey → skip that vehicle.
- EventSource/SSE not applicable (no server).

## Testing

- Unit (vitest): `buildRadarBody` shape; `parseRadar` against captured fixture (283-vehicle response → correct products/lines/positions); vehicle transform edge cases; `delayFrom` wrap-around (23:59→00:05); next-stop heuristic; `filterVehicles`.
- Live smoke: `node` run of the exact client code against `/gate` (already proven: 283 rail vehicles).
- Browser verification: static-serve the built app, drive with browser tool — badges appear and move, filters, station/route toggles, popups, status bar, mobile viewport.

## Deployment

Static build `web/dist` → Cloudflare Pages / Netlify / GitHub Pages / Vercel. No server, no Docker, no env config.

## Non-goals (v1)

Bus display, historical tracking, vehicle-follow mode, auth, server-side caching/aggregation (architecture choice).

## Product decisions (user-confirmed 2026-08-20)

1. **Update mechanism** — frontend-direct: browser polls `fahrinfo.vbb.de/gate` every 20 s; no backend. (User chose over server proxy after evidence: CORS `*` verified on `/gate`, radar verified. Accepted tradeoffs: per-browser upstream load, no central backoff, no SSE push.)
2. **Markers** — line-labeled badges in official line colors.
3. **Layers** — vehicles + stations toggle + routes toggle (VBB-style map).
4. **Language** — English UI; station/direction names stay German (as delivered).
5. **Devices** — mobile-friendly.
6. **Poll cadence** — 20 s (HAFAS data refreshes at ~15–30 s anyway).

## Decisions

1. Frontend-direct static SPA over server proxy — per user decision; risks documented above, fallback path (tiny proxy) exists if VBB blocks.
2. Hand-rolled HCI client over `hafas-client` — hafas-client cannot bundle in browser.
3. TS + Vite + Leaflet + vitest — user-approved stack, boring components.
4. S/U/tram only — buses excluded (mask 7 filters server-side of our request).
5. Public web app — static hosting, zero-infra.

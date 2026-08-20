# liveberlin — Live Berlin Transit Map: Design

**Date:** 2026-08-20
**Status:** Approved (via brainstorming flow)

## Goal

A public web app showing real-time positions of Berlin S-Bahn, U-Bahn, and tram vehicles on a live map. Vehicles move as data updates.

## Research findings (data sources)

| Source | Vehicle positions? | Access | Verdict |
|---|---|---|---|
| VBB GTFS-RT (`production.gtfsrt.vbb.de`) | No — TripUpdates (delays) only | Open, CC BY 4.0 | Not usable for positions |
| VBB official API (`api.vbb.de`) | `journeyPosition` per single trip only; no `radar` | Email registration + terms | Not usable for all-vehicles view |
| HAFAS `radar` (mgate) — VBB endpoint `fahrinfo.vbb.de/bin/mgate.exe` | Yes — all vehicles in bounding box (line, product, direction, next stops, polyline, frames) | Public webapp endpoint; no CORS | **Primary source** |
| HAFAS `radar` — BVG endpoint `bvg-apps-ext.hafas.de/bin/mgate.exe` | Yes | Semi-public (AID in client) | Fallback via same adapter |
| Community `v6.bvg.transport.rest` | Yes | Free, rate-limited, volunteer-run | Unreachable during research; fallback only |

**Caveats (documented):**
- Public HAFAS endpoints are semi-official; VBB prefers contracted API access for production. Mitigation: one server-side poll per ~20 s, cache + broadcast, attribution, swappable `Upstream` adapter.
- Some radar positions are interpolated from schedule/prognosis, not raw GPS. Visually smooth; may be slightly off on long inter-stop gaps.
- No CORS on mgate → browser cannot call HAFAS directly → backend proxy required.

**Webapp inspection (browser, 2026-08-20):** `vbb.de/en/vbb-travel-info/` is a TYPO3 landing page linking to the real app at `fahrinfo.vbb.de/webapp/` — a HaCon HAFAS webapp (Leaflet + OSM tiles). Its "Live map & Multi-mobility" view shows **stations, routes, multi-mobility (rental) locations, and traffic messages only — no live vehicle positions**. Data flows over `fahrinfo.vbb.de/gate` (HCI JSON, `ver 1.77`, AID `hafas-vbb-webapp`, client `VBB WebApp / vs_webapp_vbb`) — the same HAFAS backend and same auth/client IDs that the `hafas-client` vbb profile uses (base.json verified earlier). Implication: VBB's public site does not expose a moving-vehicle map; `radar` is the mechanism that would power one, and it is verified working (778 movements in Berlin bbox).

## Architecture

Single-process TypeScript app. npm workspaces monorepo; one Docker container deploys everything.

```
liveberlin/
├─ server/            # Node + TS + Express
│  ├─ src/upstream/   # HAFAS adapter (swappable)
│  ├─ src/poller.ts   # 20s radar poll → snapshot store
│  ├─ src/sse.ts      # /api/vehicles/stream broadcast hub
│  └─ src/server.ts   # Express: static web/dist + SSE + /healthz
├─ web/               # Vite + vanilla TS + Leaflet
└─ Dockerfile         # builds both, serves web/dist from server
```

## Data flow

```
HAFAS mgate.exe
  → hafas-client (vbb profile)
  → Poller (every 20 s, Berlin bbox)
  → Snapshot store { vehicles, updatedAt, stale }
  → SSE hub (broadcast full snapshot)
  → Browser EventSource
  → Render loop → Leaflet canvas markers
```

One poll serves all connected viewers. Full-snapshot broadcast (~50 KB per 20 s) — no delta compression.

## Components

### Server

- **Upstream adapter** — interface `Upstream { getVehicles(bbox): Vehicle[] }`.
  - `HafasUpstream` wraps `hafas-client` (VBB profile), transforms FPTF movements → `Vehicle { id, line, product: 'suburban'|'subway'|'tram', direction, lat, lon, nextStop, delayMs, updatedAt }`; filters out bus/regional server-side.
  - BVG-profile implementation selectable via `UPSTREAM` env; same interface, no other code change.
- **Poller** — Berlin bounding box (N 52.68 / S 52.34 / W 13.08 / E 13.76); `results` raised to cover network. On failure: exponential backoff (30 s → 2 min cap), keep last good snapshot, set `stale: true`.
- **SSE hub** — full snapshot on connect; full snapshot per poll; periodic comment heartbeats; client count for observability.
- **Server** — Express: static `web/dist`, `/healthz`, env config (`PORT`, `POLL_INTERVAL_MS`, `UPSTREAM`, `USER_AGENT`).

### Frontend

- Leaflet + OSM raster tiles, centered on Berlin. Mobile-friendly (full-height map, thumb-sized controls).
- **Vehicle layer** — line-labeled badges (e.g. "S7", "U2", "M10") colored with VBB's official line colors (from the `linienfarben` dataset), mode-color fallback. Click → popup: line, direction, next stop, delay badge (red if ≥ 5 min).
- **Station layer** (toggle) — rail stops from GTFS `stops.txt`, small dots, name popup.
- **Route layer** (toggle) — rail route polylines from GTFS `shapes.txt`, colored by line.
- Mode filter chips (S/U/tram) with live count; layer checkboxes (Stations, Routes).
- Status bar: connection state (live / stale / offline), vehicle count, "updated N s ago". English UI.
- v1 movement: `setLatLng` per snapshot. Radar `frames` interpolation = later upgrade, not v1.

### Static data assets (build-time, committed)

- `web/scripts/prepare-data.mjs` — one-off prep script, kept for refresh:
  - Downloads VBB GTFS zip (~82 MB, verified reachable; updated 2× weekly) from `unternehmen.vbb.de/gtfs`.
  - Extracts rail stops + route shapes (tram/subway/S-Bahn), filters out bus/regional by `route_type` + line-name pattern.
  - Emits `web/public/stations.json` and `web/public/routes.json` (GeoJSON, shape-decimated).
  - Downloads `linienfarben.zip` (line colors CSV) → generates `web/src/line-colors.ts`.

## Error handling

- Upstream down → backoff + `stale: true` → UI banner "data delayed"; last snapshot kept.
- Radar truncation at `results` limit → log; if recurring, quadrant-split polling merged server-side (documented fallback, not built).
- EventSource auto-reconnects; reconnect gets fresh full snapshot.

## Testing

- Unit: FPTF→Vehicle transform, product filtering, poller backoff (fake upstream), SSE payload shape.
- Smoke: one live radar poll validates shape/counts; browser-drive running app — markers appear, filters work, popup shows real data.
- Deploy: container starts, `/healthz` green, second process receives SSE frames.

## Deployment

- Single Docker image → Fly.io or Railway + domain + HTTPS.
- Footer attribution: "Live data: VBB · Map: © OpenStreetMap contributors".

## Non-goals (v1)

Bus display, historical tracking, vehicle-follow mode, auth, multi-instance fan-out (needs Redis).

## Product decisions (user-confirmed 2026-08-20)

1. **Update mechanism** — server polls HAFAS every 20 s (request-based, server-side only); browsers get updates via SSE server push. No per-user requests.
2. **Markers** — line-labeled badges in official line colors.
3. **Layers** — vehicles + stations toggle + routes toggle (VBB-style map).
4. **Language** — English UI; station/direction names stay German (as delivered).
5. **Devices** — mobile-friendly.

## Decisions

1. **Approach A** (single process + SSE + vanilla TS + Leaflet) over split React/MapLibre or frontend-only community API — fewest parts, one poll loop, boring stack. User-approved.
2. **TS end-to-end** — HAFAS client is Node-native. User-approved.
3. **S/U/tram only** — buses excluded from UI v1 (data still fetched, filtered server-side). User-approved.
4. **Public web app** — single-container deploy target. User-approved.

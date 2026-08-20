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

- Leaflet + OSM raster tiles, centered on Berlin.
- Canvas marker layer; product colors: S-Bahn green, U-Bahn blue, tram red.
- Filter chips (S/U/tram) with live count.
- Click marker → popup: line, direction, next stop, delay badge (red if ≥ 5 min).
- Status bar: connection state (live/stale/offline), vehicle count, "updated N s ago".
- v1 movement: `setLatLng` per snapshot. Radar `frames` interpolation = later upgrade, not v1.

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

Bus display, historical tracking, per-line colors (VBB `linienfarben` dataset later), vehicle-follow mode, auth, multi-instance fan-out (needs Redis).

## Decisions

1. **Approach A** (single process + SSE + vanilla TS + Leaflet) over split React/MapLibre or frontend-only community API — fewest parts, one poll loop, boring stack. User-approved.
2. **TS end-to-end** — HAFAS client is Node-native. User-approved.
3. **S/U/tram only** — buses excluded from UI v1 (data still fetched, filtered server-side). User-approved.
4. **Public web app** — single-container deploy target. User-approved.

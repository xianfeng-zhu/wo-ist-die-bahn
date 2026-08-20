# liveberlin — Live Berlin Transit Map: Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A public web app showing real-time positions of Berlin S-Bahn, U-Bahn, and tram vehicles on a Leaflet map — line-labeled badges in official colors, plus toggleable station and route layers — updated every ~20 s via server push (SSE).

**Architecture:** Single-process TypeScript app. Node/Express server polls the HAFAS `radar` endpoint (VBB or BVG profile, env-switchable) every 20 s, keeps an in-memory snapshot, and pushes it to all browsers over SSE (request-based only between server ↔ HAFAS; push-based between server ↔ browsers). Frontend is a Vite + vanilla TS SPA with Leaflet: vehicle badges, station dots and route polylines from committed static GeoJSON assets. One Docker container deploys everything.

**Tech Stack:** TypeScript 5, Node ≥ 20, Express 4, `hafas-client@6` (VBB/BVG profiles), Vite, Leaflet + `@types/leaflet`, vitest, npm workspaces, Docker.

**Verified facts (spiked 2026-08-20, live calls):**
- `client.radar(bbox, {results: 2000, polylines: false, frames: 0})` works on both endpoints. Berlin bbox returned 778 vehicles (107 suburban, 56 subway, 119 tram, rest bus/regional/express). `results: 3000` caps at the same 778 → `results: 2000` is safe.
- Movement shape: `{ tripId, direction, line: {name, product}, location: {latitude, longitude}, nextStopovers: [{stop: {name}, arrivalDelay, departureDelay}] }`. No `id` field → use `tripId` as vehicle id.
- FPTF delay fields are **minutes**. Products: `suburban`, `subway`, `tram`, `bus`, `regional`, `express`.
- No CORS on mgate → backend proxy mandatory. Both endpoints reachable from Node without auth.
- VBB's own Fahrinfo webapp (inspected live): its "Live map" shows stations/routes/multi-mobility/traffic messages only — no vehicles. Same HAFAS backend (`fahrinfo.vbb.de/gate`, AID `hafas-vbb-webapp`) that `hafas-client`'s vbb profile uses. Our app adds `radar` on top.
- VBB GTFS static feed (`unternehmen.vbb.de/gtfs`): 82,102,439 bytes zip, reachable, updated 2× weekly — source for stations (stops.txt) and route shapes (shapes.txt).
- VBB line colors: `unternehmen.vbb.de/fileadmin/user_upload/VBB/Dokumente/API-Datensaetze/linienfarben.zip` (CSV with hex values).

---
**Ground rules:** @test-driven-development (test first, red → green), @verification-before-completion (no success claims without running the command), @using-git-worktrees (skip here — repo is new, main branch is empty of code). Commit after every green step. Skip formatters/linters except a final `tsc --noEmit` per workspace.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json` (root)
- Create: `.gitignore`
- Create: `tsconfig.base.json`
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `web/package.json` (via scaffold in step 3)

**Step 1: Root files**

`package.json`:
```json
{
  "name": "liveberlin",
  "private": true,
  "type": "module",
  "workspaces": ["server", "web"],
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "npm test --workspaces --if-present",
    "dev:server": "npm run dev --workspace=server",
    "dev:web": "npm run dev --workspace=web"
  }
}
```

`.gitignore`:
```
node_modules/
dist/
.env
*.log
.DS_Store
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

**Step 2: Server package**

`server/package.json`:
```json
{
  "name": "server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "express": "^4.19.2",
    "hafas-client": "^6.0.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

`server/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false
  },
  "include": ["src"]
}
```

**Step 3: Web scaffold**

Run: `npm create vite@latest web -- --template vanilla-ts`
Expected: `web/` created with `index.html`, `src/main.ts`, `src/style.css`, `src/typescript.svg`, `src/counter.ts`, `web/package.json`. Delete `web/src/counter.ts` and `web/src/typescript.svg`.

Run: `npm install` (at repo root — one lockfile, hoisted workspace deps)
Run: `npm install leaflet --workspace=web && npm install -D @types/leaflet vitest --workspace=web`
Expected: no errors; `npm ls leaflet` resolves.

**Step 4: Verify scaffold**

Run: `npm run build --workspace=server` (tsc, empty src → succeeds), `npm run build --workspace=web`
Expected: both succeed. `git status` clean of `node_modules`/`dist`.

**Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold monorepo (server, web, workspaces)"
```

---

### Task 2: Vehicle type + movement transform (TDD)

**Files:**
- Create: `server/src/vehicle.ts`
- Create: `server/src/vehicle.test.ts`

**Step 1: Write the failing test**

`server/src/vehicle.test.ts`:
```ts
import {describe, expect, it} from 'vitest'
import {transformMovement} from './vehicle.js'

describe('transformMovement', () => {
  it('maps a suburban movement to a Vehicle', () => {
    const movement = {
      tripId: '1|97689|0|86|20082026',
      direction: 'S Schöneweide Bhf (Berlin)',
      line: {name: 'S9', product: 'suburban'},
      location: {latitude: 52.464687, longitude: 13.497879},
      nextStopovers: [
        {stop: {name: 'S Treptower Park'}, arrivalDelay: 2, departureDelay: 3}
      ]
    }
    expect(transformMovement(movement)).toEqual({
      id: '1|97689|0|86|20082026',
      line: 'S9',
      product: 'suburban',
      direction: 'S Schöneweide Bhf (Berlin)',
      lat: 52.464687,
      lon: 13.497879,
      nextStop: 'S Treptower Park',
      delayMs: 3000
    })
  })

  it('returns null for non-rail products', () => {
    const bus = {tripId: 'b1', line: {name: 'M29', product: 'bus'}, location: {latitude: 1, longitude: 2}, nextStopovers: []}
    expect(transformMovement(bus)).toBeNull()
  })

  it('returns null when line or location is missing', () => {
    expect(transformMovement({tripId: 'x', line: null, location: null, nextStopovers: []})).toBeNull()
  })

  it('uses arrivalDelay when departureDelay is null', () => {
    const m = {tripId: 't', line: {name: 'U2', product: 'subway'}, location: {latitude: 1, longitude: 2}, nextStopovers: [{stop: {name: 'U Gleisdreieck'}, arrivalDelay: 4, departureDelay: null}]}
    expect(transformMovement(m)!.delayMs).toBe(4000)
  })

  it('sets nulls when stopover info is absent', () => {
    const m = {tripId: 't', line: {name: 'M10', product: 'tram'}, location: {latitude: 1, longitude: 2}, nextStopovers: []}
    expect(transformMovement(m)).toMatchObject({nextStop: null, delayMs: null})
  })
})
```

**Step 2: Run to verify it fails**

Run: `npm test --workspace=server`
Expected: FAIL — `./vehicle.js` module not found.

**Step 3: Write the implementation**

`server/src/vehicle.ts`:
```ts
export type Product = 'suburban' | 'subway' | 'tram'

export interface Vehicle {
  id: string
  line: string
  product: Product
  direction: string
  lat: number
  lon: number
  nextStop: string | null
  delayMs: number | null
}

export interface Movement {
  tripId?: string
  direction?: string | null
  line?: {name?: string; product?: string} | null
  location?: {latitude?: number; longitude?: number} | null
  nextStopovers?: Array<{
    stop?: {name?: string} | null
    arrivalDelay?: number | null
    departureDelay?: number | null
  }>
}

const RAIL_PRODUCTS = new Set(['suburban', 'subway', 'tram'])

export function transformMovement(m: Movement): Vehicle | null {
  const product = m.line?.product
  if (!product || !RAIL_PRODUCTS.has(product)) return null
  if (m.location?.latitude == null || m.location.longitude == null) return null
  const next = m.nextStopovers?.[0]
  const delayMin = next?.departureDelay ?? next?.arrivalDelay ?? null
  return {
    id: m.tripId ?? 'unknown',
    line: m.line.name ?? product,
    product: product as Product,
    direction: m.direction ?? '',
    lat: m.location.latitude,
    lon: m.location.longitude,
    nextStop: next?.stop?.name ?? null,
    delayMs: delayMin == null ? null : delayMin * 1000
  }
}
```

**Step 4: Run to verify it passes**

Run: `npm test --workspace=server`
Expected: PASS — 5 tests.

**Step 5: Commit**

```bash
git add server/src/vehicle.ts server/src/vehicle.test.ts && git commit -m "feat(server): vehicle transform from HAFAS movement"
```

---

### Task 3: Upstream adapter (HAFAS radar, TDD)

**Files:**
- Create: `server/src/upstream.ts`
- Create: `server/src/upstream.test.ts`

**Step 1: Write the failing test**

`server/src/upstream.test.ts`:
```ts
import {describe, expect, it, vi} from 'vitest'
import {createUpstream, Upstream} from './upstream.js'

describe('createUpstream', () => {
  it('filters to rail products and returns compact vehicles', async () => {
    const client = {
      radar: vi.fn().mockResolvedValue({
        realtimeDataUpdatedAt: 1755719213,
        movements: [
          {tripId: 's1', direction: 'd', line: {name: 'S3', product: 'suburban'}, location: {latitude: 52.5, longitude: 13.4}, nextStopovers: []},
          {tripId: 'u1', direction: 'd', line: {name: 'U8', product: 'subway'}, location: {latitude: 52.5, longitude: 13.4}, nextStopovers: []},
          {tripId: 'b1', direction: 'd', line: {name: 'M29', product: 'bus'}, location: {latitude: 52.5, longitude: 13.4}, nextStopovers: []}
        ]
      })
    }
    const upstream: Upstream = createUpstream(client as never)
    const vehicles = await upstream.getVehicles({north: 52.68, west: 13.08, south: 52.34, east: 13.76})
    expect(vehicles.map(v => v.id).sort()).toEqual(['s1', 'u1'])
    expect(client.radar).toHaveBeenCalledWith(
      {north: 52.68, west: 13.08, south: 52.34, east: 13.76},
      {results: 2000, polylines: false, frames: 0}
    )
  })
})
```

**Step 2: Run to verify it fails**

Run: `npm test --workspace=server`
Expected: FAIL — `./upstream.js` module not found.

**Step 3: Write the implementation**

`server/src/upstream.ts`:
```ts
import {createClient} from 'hafas-client'
import {profile as vbbProfile} from 'hafas-client/p/vbb/index.js'
import {profile as bvgProfile} from 'hafas-client/p/bvg/index.js'
import {Movement, transformMovement, Vehicle} from './vehicle.js'

export interface BBox {north: number; south: number; west: number; east: number}

export interface Upstream {
  getVehicles(bbox: BBox): Promise<Vehicle[]>
}

interface RadarClient {
  radar(bbox: BBox, opts: {results: number; polylines: boolean; frames: number}): Promise<{movements: Movement[]}>
}

export function createUpstream(client?: RadarClient): Upstream {
  const radarClient: RadarClient = client ?? createRadarClient()
  return {
    async getVehicles(bbox) {
      const {movements} = await radarClient.radar(bbox, {results: 2000, polylines: false, frames: 0})
      return movements
        .map(transformMovement)
        .filter((v): v is Vehicle => v !== null)
    }
  }
}

function createRadarClient(): RadarClient {
  const profile = process.env.UPSTREAM === 'bvg' ? bvgProfile : vbbProfile
  const userAgent = process.env.HAFAS_USER_AGENT ?? 'liveberlin (https://github.com/yourname/liveberlin)'
  return createClient(profile, userAgent)
}
```

**Step 4: Run to verify it passes**

Run: `npm test --workspace=server`
Expected: PASS.

**Step 5: Live smoke (real endpoint)**

Run:
```bash
cd server && npx tsx -e "
import {createUpstream} from './src/upstream.js'
const v = await createUpstream().getVehicles({north: 52.68, west: 13.08, south: 52.34, east: 13.76})
console.log('vehicles:', v.length, '| sample:', JSON.stringify(v[0]))
"
```
Expected: `vehicles: ~280` (rail only; varies by time of day). If the network is down, retry once, then continue (upstream is external).

**Step 6: Commit**

```bash
git add server/src/upstream.ts server/src/upstream.test.ts && git commit -m "feat(server): HAFAS radar upstream adapter"
```

---

### Task 4: Poller with snapshot store + backoff (TDD)

**Files:**
- Create: `server/src/poller.ts`
- Create: `server/src/poller.test.ts`

**Step 1: Write the failing test**

`server/src/poller.test.ts`:
```ts
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {Poller} from './poller.js'
import {BBox} from './upstream.js'

const BBOX: BBox = {north: 52.68, west: 13.08, south: 52.34, east: 13.76}

describe('Poller', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('polls, stores a snapshot, and emits it', async () => {
    const upstream = {getVehicles: vi.fn().mockResolvedValue([{id: 'a'}])}
    const poller = new Poller(upstream as never, BBOX, {pollIntervalMs: 100, maxBackoffMs: 1000})
    const onSnapshot = vi.fn()
    poller.on('snapshot', onSnapshot)
    await poller.start()

    expect(upstream.getVehicles).toHaveBeenCalledTimes(1)
    expect(poller.getSnapshot()).toMatchObject({stale: false, vehicles: [{id: 'a'}]})
    expect(onSnapshot).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(100)
    expect(upstream.getVehicles).toHaveBeenCalledTimes(2)
    await poller.stop()
  })

  it('goes stale on failure and backs off', async () => {
    const upstream = {
      getVehicles: vi.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce([{id: 'b'}])
    }
    const poller = new Poller(upstream as never, BBOX, {pollIntervalMs: 100, maxBackoffMs: 1000})
    await poller.start()

    expect(poller.getSnapshot().stale).toBe(true)

    await vi.advanceTimersByTimeAsync(100)
    expect(upstream.getVehicles).toHaveBeenCalledTimes(1)
    expect(poller.getSnapshot().stale).toBe(true)

    await vi.advanceTimersByTimeAsync(200)
    expect(upstream.getVehicles).toHaveBeenCalledTimes(2)
    expect(poller.getSnapshot()).toMatchObject({stale: false, vehicles: [{id: 'b'}]})
    await poller.stop()
  })
})
```

**Step 2: Run to verify it fails**

Run: `npm test --workspace=server`
Expected: FAIL — `./poller.js` module not found.

**Step 3: Write the implementation**

`server/src/poller.ts`:
```ts
import {EventEmitter} from 'node:events'
import {BBox, Upstream} from './upstream.js'
import {Vehicle} from './vehicle.js'

export interface Snapshot {
  vehicles: Vehicle[]
  updatedAt: number
  stale: boolean
}

interface PollerOpts {
  pollIntervalMs: number
  maxBackoffMs: number
}

export class Poller extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private nextDelayMs: number
  private snapshot: Snapshot = {vehicles: [], updatedAt: 0, stale: true}

  constructor(
    private readonly upstream: Upstream,
    private readonly bbox: BBox,
    private readonly opts: PollerOpts
  ) {
    super()
    this.nextDelayMs = opts.pollIntervalMs
  }

  async start(): Promise<void> {
    await this.poll()
    this.timer = setInterval(() => void this.poll(), this.nextDelayMs)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  getSnapshot(): Snapshot {
    return this.snapshot
  }

  private async poll(): Promise<void> {
    try {
      const vehicles = await this.upstream.getVehicles(this.bbox)
      this.snapshot = {vehicles, updatedAt: Date.now(), stale: false}
      this.nextDelayMs = this.opts.pollIntervalMs
      this.emit('snapshot', this.snapshot)
    } catch (err) {
      this.snapshot = {...this.snapshot, stale: true}
      this.emit('error', err)
      this.nextDelayMs = Math.min(this.nextDelayMs * 2, this.opts.maxBackoffMs)
    }
  }
}
```

**Step 4: Run to verify it passes**

Run: `npm test --workspace=server`
Expected: PASS — 2 tests.

**Step 5: Commit**

```bash
git add server/src/poller.ts server/src/poller.test.ts && git commit -m "feat(server): poller with snapshot store and backoff"
```

---

### Task 5: SSE hub + Express server (TDD)

**Files:**
- Create: `server/src/sse.ts`
- Create: `server/src/server.ts`
- Create: `server/src/server.test.ts`

**Step 1: Write the failing test**

`server/src/server.test.ts`:
```ts
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {AddressInfo} from 'node:net'
import http from 'node:http'
import {EventEmitter} from 'node:events'
import {Poller} from './poller.js'
import {createApp} from './server.js'

describe('HTTP server', () => {
  let server: http.Server
  let base: string

  beforeAll(async () => {
    const emitter = new EventEmitter()
    const snapshot = {vehicles: [{id: 's1', line: 'S9', product: 'suburban', direction: 'd', lat: 52.5, lon: 13.4, nextStop: null, delayMs: null}], updatedAt: 123, stale: false}
    const poller = Object.assign(emitter, {getSnapshot: () => snapshot}) as unknown as Poller
    server = http.createServer(createApp(poller, 'web/dist'))
    await new Promise<void>(r => server.listen(0, r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => new Promise<void>(r => server.close(() => r())))

  it('serves /healthz with snapshot info', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ok: true, stale: false, vehicles: 1})
  })

  it('streams a snapshot event over SSE', async () => {
    const res = await fetch(`${base}/api/vehicles/stream`, {headers: {Accept: 'text/event-stream'}})
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const {value} = await reader.read()
    const chunk = new TextDecoder().decode(value)
    expect(chunk).toContain('event: snapshot')
    expect(chunk).toContain('"id":"s1"')
    reader.cancel()
  })
})
```

**Step 2: Run to verify it fails**

Run: `npm test --workspace=server`
Expected: FAIL — `./server.js` module not found.

**Step 3: Write the implementation**

`server/src/sse.ts`:
```ts
import type {Response} from 'express'
import {Poller} from './poller.js'

export function attachSSE(poller: Poller, clients: Set<Response>): void {
  poller.on('snapshot', snapshot => {
    const payload = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`
    for (const res of clients) res.write(payload)
  })
}

export function writeInitialSnapshot(res: Response, poller: Poller): void {
  res.write(`event: snapshot\ndata: ${JSON.stringify(poller.getSnapshot())}\n\n`)
}
```

`server/src/server.ts`:
```ts
import express from 'express'
import path from 'node:path'
import {Poller} from './poller.js'
import {attachSSE, writeInitialSnapshot} from './sse.js'

export function createApp(poller: Poller, webDist: string) {
  const app = express()
  const clients = new Set<express.Response>()

  attachSSE(poller, clients)

  app.get('/healthz', (_req, res) => {
    const s = poller.getSnapshot()
    res.json({ok: true, stale: s.stale, vehicles: s.vehicles.length, updatedAt: s.updatedAt})
  })

  app.get('/api/vehicles/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    res.flushHeaders()
    writeInitialSnapshot(res, poller)
    clients.add(res)
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000)
    req.on('close', () => {
      clearInterval(heartbeat)
      clients.delete(res)
    })
  })

  app.use(express.static(webDist))
  return app
}

// --- entry point (only when run directly) ---
import {createUpstream} from './upstream.js'

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')
if (isMain) {
  const port = Number(process.env.PORT ?? 3000)
  const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 20000)
  const maxBackoffMs = Number(process.env.MAX_BACKOFF_MS ?? 120000)
  const webDist = process.env.WEB_DIST ?? path.resolve(import.meta.dirname, '../../web/dist')

  const poller = new Poller(createUpstream(), {north: 52.68, west: 13.08, south: 52.34, east: 13.76}, {pollIntervalMs, maxBackoffMs})
  poller.on('error', err => console.error('[poller]', err))
  await poller.start()

  const app = createApp(poller, webDist)
  app.listen(port, () => console.log(`liveberlin listening on :${port}`))
}
```

Note: top-level `await` requires ESM + Node ≥ 20 (`"type": "module"` set in Task 1). `import.meta.dirname` requires Node ≥ 20.11.

**Step 4: Run to verify it passes**

Run: `npm test --workspace=server`
Expected: PASS — 2 tests.

**Step 5: Typecheck + manual smoke**

Run: `npm run typecheck --workspace=server`
Expected: no errors.

Run (background): `PORT=3210 POLL_INTERVAL_MS=20000 npm run dev --workspace=server`
Then: `curl -s localhost:3210/healthz` → `{"ok":true,"stale":false,"vehicles":~280,...}`
Then: `curl -sN localhost:3210/api/vehicles/stream | head -3` → an `event: snapshot` block with JSON.
Stop the dev server after.

**Step 6: Commit**

```bash
git add server/src/sse.ts server/src/server.ts server/src/server.test.ts && git commit -m "feat(server): SSE stream, healthz, static serving"
```

---

### Task 6: Web scaffold — map shell + mobile styles

**Files:**
- Modify: `web/index.html`
- Modify: `web/src/main.ts`
- Modify: `web/src/style.css`

**Step 1: Map shell**

`web/index.html` — replace body with:
```html
<body>
  <div id="map"></div>
  <div id="statusbar"></div>
  <div id="filters"></div>
  <div id="attribution">Live data: VBB · Map: © OpenStreetMap contributors</div>
  <script type="module" src="/src/main.ts"></script>
</body>
```

`web/src/main.ts`:
```ts
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './style.css'

const map = L.map('map').setView([52.52, 13.405], 12)
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map)

export {map}
```

**Step 2: Style (desktop + mobile)**

`web/src/style.css`:
```css
html, body, #map { height: 100%; margin: 0; }
body { font: 13px system-ui, sans-serif; }
#statusbar {
  position: fixed; top: 10px; left: 10px; z-index: 1000;
  background: rgba(255,255,255,.92); padding: 6px 10px; border-radius: 6px;
  box-shadow: 0 1px 4px rgba(0,0,0,.3);
}
#filters {
  position: fixed; top: 10px; right: 10px; z-index: 1000;
  background: rgba(255,255,255,.92); padding: 8px 10px; border-radius: 6px;
  box-shadow: 0 1px 4px rgba(0,0,0,.3);
}
#filters .mode { display: flex; gap: 6px; margin-bottom: 6px; }
#filters .layer { display: block; margin: 2px 0; cursor: pointer; }
#attribution {
  position: fixed; bottom: 4px; right: 6px; z-index: 1000;
  font: 11px system-ui; color: #555; background: rgba(255,255,255,.7);
  padding: 2px 6px; border-radius: 4px;
}
@media (max-width: 640px) {
  #statusbar { top: 8px; left: 8px; font-size: 12px; }
  #filters {
    top: auto; bottom: 8px; left: 8px; right: 8px;
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  }
  #filters .mode { margin-bottom: 0; }
  .leaflet-top { top: 44px; }
}
```

**Step 3: Verify**

Run: `npm run dev --workspace=web` (background), open `http://localhost:5173` in browser (@frontend-design, @verification-before-completion)
Expected: map of Berlin renders with OSM tiles, no console errors; at narrow width the filters bar moves to the bottom. Stop dev server.

**Step 4: Commit**

```bash
git add web/ && git commit -m "feat(web): leaflet map shell with mobile styles"
```

---

### Task 7: Frontend data layer — parse + filter (TDD)

**Files:**
- Create: `web/src/vehicles.ts`
- Create: `web/src/vehicles.test.ts`
- Modify: `web/package.json` (add test script)

**Step 1: Failing test**

`web/src/vehicles.test.ts`:
```ts
import {describe, expect, it} from 'vitest'
import {filterVehicles, parseSnapshot} from './vehicles.js'

describe('filterVehicles', () => {
  const v = (product: string) => ({id: product, line: 'L', product, direction: 'd', lat: 1, lon: 2, nextStop: null, delayMs: null})
  it('keeps enabled products only', () => {
    const out = filterVehicles([v('suburban'), v('subway'), v('tram')], {suburban: true, subway: false, tram: true})
    expect(out.map(x => x.product)).toEqual(['suburban', 'tram'])
  })
})

describe('parseSnapshot', () => {
  it('parses an SSE snapshot payload', () => {
    const s = parseSnapshot(JSON.stringify({vehicles: [{id: 'a', product: 'subway'}], updatedAt: 1, stale: false}))
    expect(s.vehicles.length).toBe(1)
    expect(s.stale).toBe(false)
  })
})
```

Add to `web/package.json` scripts: `"test": "vitest run"`.

**Step 2: Run to verify it fails**

Run: `npm test --workspace=web`
Expected: FAIL — `./vehicles.js` not found.

**Step 3: Implementation**

`web/src/vehicles.ts`:
```ts
export type Product = 'suburban' | 'subway' | 'tram'

export interface Vehicle {
  id: string
  line: string
  product: Product
  direction: string
  lat: number
  lon: number
  nextStop: string | null
  delayMs: number | null
}

export interface Snapshot {
  vehicles: Vehicle[]
  updatedAt: number
  stale: boolean
}

export interface Filters {suburban: boolean; subway: boolean; tram: boolean}

export function filterVehicles(vehicles: Vehicle[], filters: Filters): Vehicle[] {
  return vehicles.filter(v => filters[v.product])
}

export function parseSnapshot(data: string): Snapshot {
  return JSON.parse(data) as Snapshot
}
```

**Step 4: Verify passes**

Run: `npm test --workspace=web`
Expected: PASS.

**Step 5: Commit**

```bash
git add web/src/vehicles.ts web/src/vehicles.test.ts web/package.json && git commit -m "feat(web): vehicle parsing and filtering"
```

---

### Task 8: Static network data prep (stations, routes, line colors)

Build-time script + committed assets. Downloads ~82 MB GTFS once; outputs stay in the repo (refresh by re-running).

**Files:**
- Create: `web/scripts/prepare-data.mjs`
- Create (generated): `web/public/stations.json` — GeoJSON `FeatureCollection` of rail stops
- Create (generated): `web/public/routes.json` — GeoJSON `FeatureCollection` of rail route polylines
- Create (generated): `web/src/line-colors.ts` — `export const lineColors: Record<string, string>`

**Step 1: Write the script**

`web/scripts/prepare-data.mjs`:
```js
// One-off data prep: VBB GTFS + line colors -> committed static assets.
// Re-run to refresh (GTFS updates 2x weekly): node web/scripts/prepare-data.mjs
import {execSync} from 'node:child_process'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {fileURLToPath} from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const web = path.resolve(here, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vbb-gtfs-'))
const run = c => execSync(c, {stdio: 'inherit', cwd: tmp})

// 1. download + extract GTFS
run(`curl -sL -o vbb.zip https://unternehmen.vbb.de/gtfs`)
run(`unzip -o -q vbb.zip -d gtfs`)

// 2. download line colors
run(`curl -sL -o linienfarben.zip https://unternehmen.vbb.de/fileadmin/user_upload/VBB/Dokumente/API-Datensaetze/linienfarben.zip`)
run(`unzip -o -q linienfarben.zip -d linienfarben`)

// ... (steps 3-6 filled below; script is refined iteratively in steps 2-4)
```

**Step 2: Inspect GTFS structure first**

Run: `node -e "console.log(readFileSync('/tmp/.../gtfs/routes.txt','utf8').split('\n').slice(0,5))"` (or `head` inside the script) — identify `route_type` values used (expect `0` tram, `1` subway, `2` rail; S-Bahn distinguished from regional by `route_short_name` matching `/^S\d/` or `/^S4[12]$/` etc.).
Expected: header + sample rows. Record the exact route_type values and the S-Bahn naming pattern in a comment in the script.

**Step 3: Complete the script**

Implement in `prepare-data.mjs`:
- Parse `routes.txt` (route_id → {short_name, type}), keep rail routes: tram (type 0), subway (type 1), S-Bahn (type 2 + name matches `/^S\d/`). Regional RE/RB/IC etc. excluded.
- Parse `trips.txt` (route_id per trip), `shapes.txt` (shape_id → ordered [lat, lon] points), `stops.txt` (stop_id → {name, lat, lon}).
- **Routes GeoJSON:** for each rail route, take one representative trip's shape; decimate to ≤ 500 points (keep every k-th point); feature `{type: 'Feature', geometry: LineString, properties: {line, product}}`.
- **Stations GeoJSON:** stops that appear on rail trips' stop_times (or all stops with `location_type` 0 that are referenced); feature `{type: 'Feature', geometry: Point, properties: {name}}`; dedupe by stop_id.
- **Line colors:** parse the linienfarben CSV (column with hex values; inspect header in step 2), emit `web/src/line-colors.ts` with `lineColors` keyed by line name (e.g. `S7`, `U2`, `M10`); skip lines without hex.
- Write the three outputs. Print summary counts.

**Step 4: Run the script**

Run: `node web/scripts/prepare-data.mjs`
Expected: prints summary, e.g. `stations: ~1800 · routes: ~45 · lineColors: ~55`. Files written:
- `web/public/stations.json`, `web/public/routes.json` — valid GeoJSON (validate: `node -e "JSON.parse(readFileSync(...))"`).
- `web/src/line-colors.ts` — compiles.

Sanity: open `routes.json` — S/U/tram lines present, no RE/RB; station count in the thousands, not tens of thousands (no bus stops).

**Step 5: Commit**

```bash
git add web/scripts web/public web/src/line-colors.ts && git commit -m "feat(web): static network data (stations, routes, line colors)"
```

---

### Task 9: Live map — SSE, labeled badges, layers, toggles

**Files:**
- Modify: `web/src/main.ts`

**Step 1: Replace main.ts with the live map**

`web/src/main.ts`:
```ts
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './style.css'
import {filterVehicles, parseSnapshot, Product, Snapshot, Vehicle} from './vehicles.js'
import {lineColors} from './line-colors.js'

const PRODUCT_COLORS: Record<Product, string> = {
  suburban: '#2e7d32',
  subway: '#1565c0',
  tram: '#c62828'
}
const PRODUCT_LABELS: Record<Product, string> = {
  suburban: 'S-Bahn', subway: 'U-Bahn', tram: 'Tram'
}

const map = L.map('map').setView([52.52, 13.405], 12)
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map)

// --- vehicle layer (line-labeled badges) ---
const vehicleLayer = L.layerGroup().addTo(map)
const markers = new Map<string, L.Marker>()
const filters: Record<Product, boolean> = {suburban: true, subway: true, tram: true}
let snapshot: Snapshot | null = null

function badgeHtml(v: Vehicle): string {
  const color = lineColors[v.line] ?? PRODUCT_COLORS[v.product]
  return `<div class="veh" style="background:${color}">${v.line}</div>`
}

function renderVehicles() {
  if (!snapshot) return
  const visible = filterVehicles(snapshot.vehicles, filters)
  const seen = new Set<string>()
  for (const v of visible) {
    seen.add(v.id)
    let m = markers.get(v.id)
    if (!m) {
      m = L.marker([v.lat, v.lon], {
        icon: L.divIcon({className: 'veh-icon', html: badgeHtml(v), iconSize: undefined})
      }).bindPopup('')
      m.addTo(vehicleLayer)
      markers.set(v.id, m)
    }
    m.setLatLng([v.lat, v.lon])
    const color = lineColors[v.line] ?? PRODUCT_COLORS[v.product]
    m.setIcon(L.divIcon({className: 'veh-icon', html: `<div class="veh" style="background:${color}">${v.line}</div>`}))
    m.setPopupContent(
      `<b>${v.line}</b> ${PRODUCT_LABELS[v.product]}<br>→ ${v.direction}<br>next: ${v.nextStop ?? '—'}` +
      (v.delayMs != null ? `<br><span style="color:${v.delayMs >= 300000 ? '#c62828' : '#333'}">delay: ${Math.round(v.delayMs / 60000)} min</span>` : '')
    )
  }
  for (const [id, m] of markers) {
    if (!seen.has(id)) { m.remove(); markers.delete(id) }
  }
  updateStatus(snapshot.stale ? 'stale' : 'live')
}

// --- station + route layers ---
const stationLayer = L.layerGroup()
const routeLayer = L.layerGroup()
async function loadNetworkLayers() {
  try {
    const stations = await (await fetch('/stations.json')).json()
    L.geoJSON(stations, {
      pointToLayer: (_f, latlng) => L.circleMarker(latlng, {radius: 3, color: '#555', weight: 1, fillColor: '#888', fillOpacity: 0.8}),
      onEachFeature: (f, layer) => f.properties?.name && layer.bindPopup(f.properties.name)
    }).addTo(stationLayer)
  } catch (err) { console.warn('stations layer unavailable', err) }
  try {
    const routes = await (await fetch('/routes.json')).json()
    L.geoJSON(routes, {
      style: f => ({color: lineColors[f.properties?.line] ?? PRODUCT_COLORS[f.properties?.product] ?? '#888', weight: 2, opacity: 0.75})
    }).addTo(routeLayer)
  } catch (err) { console.warn('routes layer unavailable', err) }
}
loadNetworkLayers()

// --- status bar ---
const statusEl = document.getElementById('statusbar')!
function updateStatus(conn: 'live' | 'stale' | 'offline') {
  const ago = snapshot?.updatedAt ? Math.round((Date.now() - snapshot.updatedAt) / 1000) : 0
  const count = snapshot ? filterVehicles(snapshot.vehicles, filters).length : 0
  statusEl.textContent = `${conn} · ${count} vehicles · updated ${ago}s ago`
}
setInterval(() => snapshot && updateStatus(snapshot.stale ? 'stale' : 'live'), 1000)

// --- SSE ---
function connect() {
  const es = new EventSource('/api/vehicles/stream')
  es.addEventListener('snapshot', e => {
    snapshot = parseSnapshot((e as MessageEvent).data)
    renderVehicles()
  })
  es.onerror = () => {
    es.close()
    updateStatus('offline')
    setTimeout(connect, 3000)
  }
}
connect()

// --- mode filters + layer toggles ---
const filterEl = document.getElementById('filters')!
const modeRow = document.createElement('div')
modeRow.className = 'mode'
;(Object.keys(PRODUCT_LABELS) as Product[]).forEach(p => {
  const label = document.createElement('label')
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = true
  cb.onchange = () => {
    filters[p] = cb.checked
    renderVehicles()
  }
  label.append(cb, ` ${PRODUCT_LABELS[p]}`, ` <span style="color:${PRODUCT_COLORS[p]}">●</span>`)
  modeRow.append(label)
})
filterEl.append(modeRow)

const toggleLayer = (name: string, layer: L.LayerGroup) => {
  const label = document.createElement('label')
  label.className = 'layer'
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = false
  cb.onchange = () => cb.checked ? layer.addTo(map) : layer.remove()
  label.append(cb, ` ${name}`)
  filterEl.append(label)
}
toggleLayer('Stations', stationLayer)
toggleLayer('Routes', routeLayer)
```

Add to `web/src/style.css` (vehicle badge styles):
```css
.veh-icon { border: none; background: none; }
.veh {
  min-width: 24px; height: 20px; padding: 0 4px; border-radius: 10px;
  color: #fff; font: 700 11px/20px system-ui; text-align: center;
  border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.5);
}
```

**Step 2: End-to-end smoke (both workspaces)**

Run: `npm run build --workspace=server && npm run build --workspace=web`
Run (background): `PORT=3211 WEB_DIST=web/dist npm run dev --workspace=server`
Expected: server logs "listening on :3211".

**Step 3: Browser verification** (@verification-before-completion, @frontend-design)

Drive `http://localhost:3211` with the browser tool:
- Map shows Berlin with OSM tiles; colored line badges (S7, U2, M10…) appear and move between snapshots (wait ≥ 20 s for second poll).
- Badge colors match VBB line colors (spot-check a few against `line-colors.ts`).
- Unchecking U-Bahn removes blue badges and updates count.
- Enabling "Stations" shows stop dots; enabling "Routes" shows line polylines.
- Click a badge → popup shows line, direction, next stop, delay.
- Status bar shows `live · N vehicles · updated Ns ago`.
- Narrow viewport: filters bar at bottom, map still usable.

**Step 4: Commit**

```bash
git add web/src/main.ts web/src/style.css && git commit -m "feat(web): live map with badges, station/route layers, toggles"
```

---

### Task 10: Container + deployment config

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

**Step 1: Dockerfile**

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci
COPY . .
RUN npm run build --workspace=server && npm run build --workspace=web

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/server/dist /app/server/dist
COPY --from=build /app/web/dist /app/web/dist
COPY --from=build /app/server/package.json /app/server/package.json
COPY --from=build /app/web/package.json /app/web/package.json
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server/dist/server.js"]
```

`.dockerignore`:
```
node_modules
dist
.git
*.log
.env
```

**Step 2: Local container smoke**

Run: `docker build -t liveberlin . && docker run -d -p 3000:3000 --name lb-test liveberlin`
Then: `curl -s localhost:3000/healthz` → `{"ok":true,...}`; `curl -s localhost:3000/` → HTML containing `id="map"`; `curl -s localhost:3000/stations.json` → GeoJSON.
Then: `docker rm -f lb-test`

**Step 3: Deploy (platform of choice — requires user account)**

- Fly.io: `fly launch` in repo root (detects Dockerfile), `fly deploy`, `fly open`.
- Railway: connect GitHub repo, Railway auto-detects Dockerfile, set `PORT=3000`, deploy.
Expected: public URL serves the app; `/healthz` returns ok.

**Step 4: Commit**

```bash
git add Dockerfile .dockerignore && git commit -m "chore: docker image and deploy config"
```

---

### Task 11: Final verification

Run: `npm test` (root, both workspaces) — all PASS.
Run: `npm run typecheck --workspace=server` — clean.
Run: `npm run build --workspace=web` — clean.
Browser smoke on the built app (local server) — badges, filters, station/route toggles, popups, status bar all working.
Confirm attribution footer visible.

Expected final tree:
```
server/src/{vehicle,poller,upstream,sse,server}.ts (+ .test.ts)
web/src/{main.ts,vehicles.ts,vehicles.test.ts,style.css,line-colors.ts}
web/public/{stations.json,routes.json}
web/scripts/prepare-data.mjs
Dockerfile
```

Commit any stragglers: `git add -A && git commit -m "chore: final verification"` (only if changes).

**Done.** End-to-end behavior: open URL → live map of Berlin rail vehicles with line-labeled badges, moving every ~20 s via server push, plus station/route layers and mode filters. Mobile-friendly.

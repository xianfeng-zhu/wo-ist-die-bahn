# liveberlin — Live Berlin Transit Map: Implementation Plan (frontend-direct)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A public web app showing real-time positions of Berlin S-Bahn, U-Bahn, and tram vehicles on a Leaflet map — line-labeled badges in official colors, plus toggleable station and route layers — polling VBB's HAFAS endpoint directly from the browser every 20 s.

**Architecture:** Pure static SPA, no backend. The browser POSTs a hand-rolled HCI `JourneyGeoPos` request to `https://fahrinfo.vbb.de/gate` (CORS `*`, verified) every 20 s, parses the response (`common.locL`/`prodL` references, `jnyL` positions), and renders moving badges on Leaflet. Static GeoJSON assets (stations, routes) and line colors are generated once from VBB's GTFS + `linienfarben` data. Deployed to any static host.

**Tech Stack:** TypeScript, Vite, Leaflet + `@types/leaflet`, vitest. Node ≥ 20 only for build/scripts.

**Verified facts (spiked 2026-08-20, live calls — do not re-derive):**
- Endpoint `fahrinfo.vbb.de/gate?rnd=<ts>`: POST JSON, CORS `access-control-allow-origin: *`. `bin/mgate.exe` has **no CORS** (do not use).
- `hafas-client` is Node-only (`node:buffer`, `https-proxy-agent`) — cannot bundle in browser. Hand-rolled client below is verified working (283 rail vehicles).
- Request: `{lang: 'de', svcReqL: [{meth: 'JourneyGeoPos', req: {maxJny, onlyRT: false, date: 'YYYYMMDD', time: 'HHMMSS', rect: {llCrd: {x: westLon*1e6, y: southLat*1e6}, urCrd: {x: eastLon*1e6, y: northLat*1e6}}, perSize: 30000, perStep: 10000, ageOfReport: true, jnyFltrL: [{type: 'PROD', mode: 'INC', value: 7}], trainPosMode: 'CALC'}}], client: {type: 'WEB', id: 'VBB', name: 'VBB WebApp', l: 'vs_webapp_vbb'}, ver: '1.45', auth: {type: 'AID', aid: 'hafas-vbb-webapp'}}`
- Product filter `value: 7` = rail only (S=1, U=2, tram=4; bus=8, ferry=16, express=32, regional=64).
- Response: `svcResL[0].res.common.{locL, prodL}` + `jnyL[]`. Journey: `jid` (tripId), `prodX` (→ `prodL[prodX].name` = line name, `.cls` = product bitmask 1/2/4), `dirTxt` (direction), `pos {x, y}` (lon/lat ×1e6), `stopL[]` (`locX` → `locL[locX].name`; `aTimeS`/`dTimeS` scheduled, `aTimeR`/`dTimeR` realtime, `HH:MM:SS`; delay = realtime − scheduled in minutes).
- Live measurement: full Berlin bbox (N 52.68, S 52.34, W 13.08, E 13.76), mask 7, ~283 rail vehicles, raw payload ~600 KB, response ~600 ms.
- GTFS: `unternehmen.vbb.de/gtfs` (82,102,439 bytes zip, 2× weekly). Line colors: `unternehmen.vbb.de/fileadmin/user_upload/VBB/Dokumente/API-Datensaetze/linienfarben.zip`.

---
**Ground rules:** @test-driven-development (test first, red → green), @verification-before-completion (no success claims without running the command), @using-git-worktrees (skip — repo is new). Commit after every green step. Skip formatters/linters except `tsc --noEmit` and `vite build`.

---

### Task 1: Scaffold Vite app at repo root

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`
- Create: `src/main.ts` (minimal), `src/style.css` (minimal)
- Create: `.gitignore` (root — already exists from design work; verify contents)

**Step 1: Root package.json**

```json
{
  "name": "liveberlin",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "prepare:data": "node scripts/prepare-data.mjs"
  },
  "dependencies": {
    "leaflet": "^1.9.4"
  },
  "devDependencies": {
    "@types/leaflet": "^1.9.12",
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

**Step 2: tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

**Step 3: vite.config.ts**

```ts
import {defineConfig} from 'vite'

export default defineConfig({
  build: {target: 'es2022'}
})
```

**Step 4: index.html**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>liveberlin — live transit map</title>
</head>
<body>
  <div id="map"></div>
  <div id="statusbar"></div>
  <div id="filters"></div>
  <div id="attribution">Live data: VBB · Map: © OpenStreetMap contributors</div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

**Step 5: Minimal main.ts + style.css**

`src/main.ts`:
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

`src/style.css`:
```css
html, body, #map { height: 100%; margin: 0; }
body { font: 13px system-ui, sans-serif; }
```

**Step 6: Install + verify**

Run: `npm install`
Run: `npm run build`
Expected: `tsc` clean, `dist/` created with `index.html` + assets.
Run: `npm run dev` (background), open `http://localhost:5173` — Berlin map renders, no console errors. Stop dev server.

**Step 7: Commit**

```bash
git add -A && git commit -m "chore: scaffold vite app"
```

---

### Task 2: Vehicle transform (TDD)

**Files:**
- Create: `src/vehicle.ts`
- Create: `src/vehicle.test.ts`

**Step 1: Failing test**

`src/vehicle.test.ts`:
```ts
import {describe, expect, it} from 'vitest'
import {delayFrom, productFromCls, transformJourney} from './vehicle.js'

describe('productFromCls', () => {
  it('maps HAFAS cls bitmask to rail products', () => {
    expect(productFromCls(1)).toBe('suburban')
    expect(productFromCls(2)).toBe('subway')
    expect(productFromCls(4)).toBe('tram')
    expect(productFromCls(8)).toBeNull() // bus
    expect(productFromCls(64)).toBeNull() // regional
  })
})

describe('delayFrom', () => {
  it('computes delay from realtime minus scheduled departure', () => {
    expect(delayFrom({dTimeS: '23:09:00', dTimeR: '23:11:00'})).toBe(120000)
  })
  it('falls back to arrival times', () => {
    expect(delayFrom({aTimeS: '23:09:00', aTimeR: '23:06:00'})).toBe(-180000)
  })
  it('handles midnight wrap-around', () => {
    expect(delayFrom({dTimeS: '23:59:00', dTimeR: '00:03:00'})).toBe(240000)
  })
  it('returns null without realtime data', () => {
    expect(delayFrom({dTimeS: '23:09:00'})).toBeNull()
  })
})

describe('transformJourney', () => {
  const locs = [
    {name: 'S Schöneweide Bhf (Berlin)'},
    {name: 'S Treptower Park'}
  ]
  const j = {
    jid: '1|98495|0|86|20082026',
    prodX: 0,
    dirTxt: 'S Treptower Park (Berlin)',
    pos: {x: 13495123, y: 52467625},
    stopL: [
      {locX: 0, dTimeS: '23:03:00'},
      {locX: 1, aTimeS: '23:09:00', aTimeR: '23:08:00', dTimeS: '23:09:00', dTimeR: '23:08:00'}
    ]
  }
  it('transforms a journey into a Vehicle', () => {
    const v = transformJourney(j, {locs, prods: [{name: 'S9', cls: 1}]}, '23:05:00')!
    expect(v).toEqual({
      id: '1|98495|0|86|20082026',
      line: 'S9',
      product: 'suburban',
      direction: 'S Treptower Park (Berlin)',
      lat: 52.467625,
      lon: 13.495123,
      nextStop: 'S Treptower Park',
      delayMs: -60000
    })
  })
  it('returns null when pos is missing', () => {
    expect(transformJourney({...j, pos: null}, {locs, prods: [{name: 'S9', cls: 1}]}, '23:05:00')).toBeNull()
  })
  it('returns null for non-rail cls', () => {
    expect(transformJourney(j, {locs, prods: [{name: 'M29', cls: 8}]}, '23:05:00')).toBeNull()
  })
  it('picks the first upcoming stop as nextStop', () => {
    const v = transformJourney(j, {locs, prods: [{name: 'S9', cls: 1}]}, '23:03:30')!
    expect(v.nextStop).toBe('S Treptower Park')
  })
})
```

**Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `./vehicle.js` module not found.

**Step 3: Implementation**

`src/vehicle.ts`:
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

export const PRODUCT_BY_CLS: Record<number, Product> = {1: 'suburban', 2: 'subway', 4: 'tram'}

export function productFromCls(cls: number | undefined): Product | null {
  return cls != null ? PRODUCT_BY_CLS[cls] ?? null : null
}

const toSec = (s: string): number => {
  const [h, m, sec] = s.split(':').map(Number)
  return h * 3600 + m * 60 + (sec ?? 0)
}

export function delayFrom(stop: StopoverLike): number | null {
  for (const [r, s] of [['dTimeR', 'dTimeS'], ['aTimeR', 'aTimeS']] as const) {
    if (stop[r] && stop[s]) {
      let diff = (toSec(stop[r]) - toSec(stop[s])) / 60 * 60000
      if (diff > 12 * 3600 * 1000) diff -= 24 * 3600 * 1000
      if (diff < -12 * 3600 * 1000) diff += 24 * 3600 * 1000
      return Math.round(diff)
    }
  }
  return null
}

export interface StopoverLike {
  locX?: number
  aTimeS?: string
  aTimeR?: string
  dTimeS?: string
  dTimeR?: string
}

interface Common {
  locs: Array<{name?: string}>
  prods: Array<{name?: string; cls?: number}>
}

export interface Journey {
  jid?: string
  prodX?: number
  dirTxt?: string
  pos?: {x?: number; y?: number} | null
  stopL?: StopoverLike[]
}

export function transformJourney(j: Journey, common: Common, nowTime: string): Vehicle | null {
  const prod = common.prods[j.prodX ?? -1]
  const product = productFromCls(prod?.cls)
  if (!product) return null
  if (!j.pos?.x || !j.pos?.y) return null
  const nowSec = toSec(nowTime)
  const stops = j.stopL ?? []
  const next = stops.find(s => (s.aTimeS ?? s.dTimeS) && toSec(s.aTimeS ?? s.dTimeS) >= nowSec) ?? stops[1] ?? stops[0]
  return {
    id: j.jid ?? 'unknown',
    line: prod?.name ?? product,
    product,
    direction: j.dirTxt ?? '',
    lat: j.pos.y / 1e6,
    lon: j.pos.x / 1e6,
    nextStop: next ? common.locs[next.locX ?? -1]?.name ?? null : null,
    delayMs: next ? delayFrom(next) : null
  }
}
```

**Step 4: Verify passes**

Run: `npm test`
Expected: PASS — 9 tests.

**Step 5: Commit**

```bash
git add src/vehicle.ts src/vehicle.test.ts && git commit -m "feat: vehicle transform from HCI journey"
```

---

### Task 3: HCI client — request builder + response parser (TDD)

**Files:**
- Create: `src/hci.ts`
- Create: `src/hci.test.ts`

**Step 1: Failing test**

`src/hci.test.ts`:
```ts
import {describe, expect, it} from 'vitest'
import {buildRadarBody, parseRadar} from './hci.js'

describe('buildRadarBody', () => {
  it('builds a JourneyGeoPos request with rail-only filter', () => {
    const body = buildRadarBody({north: 52.68, west: 13.08, south: 52.34, east: 13.76}, '20260820', '230819', 2000)
    const req = body.svcReqL[0]
    expect(req.meth).toBe('JourneyGeoPos')
    expect(req.req.rect).toEqual({llCrd: {x: 13080000, y: 52340000}, urCrd: {x: 13760000, y: 52680000}})
    expect(req.req.jnyFltrL).toEqual([{type: 'PROD', mode: 'INC', value: 7}])
    expect(req.req.date).toBe('20260820')
    expect(req.req.time).toBe('230819')
    expect(req.req.maxJny).toBe(2000)
    expect(body.auth).toEqual({type: 'AID', aid: 'hafas-vbb-webapp'})
    expect(body.client).toMatchObject({id: 'VBB', l: 'vs_webapp_vbb'})
  })
})

describe('parseRadar', () => {
  const json = {
    svcResL: [{err: 'OK', res: {
      common: {
        locL: [{name: 'S Schöneweide'}, {name: 'S Treptower Park'}],
        prodL: [{name: 'S9', cls: 1}, {name: 'U2', cls: 2}, {name: 'M10', cls: 4}, {name: 'M29', cls: 8}]
      },
      jnyL: [
        {jid: 's1', prodX: 0, dirTxt: 'd1', pos: {x: 13490000, y: 52460000}, stopL: [{locX: 1, aTimeS: '23:10:00'}]},
        {jid: 'u1', prodX: 1, dirTxt: 'd2', pos: {x: 13490001, y: 52460001}, stopL: []},
        {jid: 'b1', prodX: 3, dirTxt: 'd3', pos: {x: 13490002, y: 52460002}, stopL: []},
        {jid: 't1', prodX: 2, dirTxt: 'd4', pos: null, stopL: []}
      ]
    }}]
  }
  it('parses journeys into rail vehicles only', () => {
    const vehicles = parseRadar(json, '23:00:00')
    expect(vehicles.map(v => v.id)).toEqual(['s1', 'u1'])
    expect(vehicles[0]).toMatchObject({line: 'S9', product: 'suburban', lat: 52.46, lon: 13.49, nextStop: 'S Treptower Park'})
    expect(vehicles[1]).toMatchObject({line: 'U2', product: 'subway'})
  })
  it('throws on server error', () => {
    expect(() => parseRadar({svcResL: [{err: 'NOOK', res: {}}]}, '23:00:00')).toThrow()
  })
})
```

**Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `./hci.js` module not found.

**Step 3: Implementation**

`src/hci.ts`:
```ts
import {Journey, transformJourney, Vehicle} from './vehicle.js'

export const GATE_URL = 'https://fahrinfo.vbb.de/gate'
const RAIL_MASK = 7 // S=1, U=2, tram=4

export interface BBox {north: number; south: number; west: number; east: number}

export function buildRadarBody(bbox: BBox, date: string, time: string, maxJny: number) {
  return {
    lang: 'de',
    svcReqL: [{
      meth: 'JourneyGeoPos',
      req: {
        maxJny,
        onlyRT: false,
        date,
        time,
        rect: {
          llCrd: {x: Math.round(bbox.west * 1e6), y: Math.round(bbox.south * 1e6)},
          urCrd: {x: Math.round(bbox.east * 1e6), y: Math.round(bbox.north * 1e6)}
        },
        perSize: 30000,
        perStep: 10000,
        ageOfReport: true,
        jnyFltrL: [{type: 'PROD', mode: 'INC', value: RAIL_MASK}],
        trainPosMode: 'CALC'
      }
    }],
    client: {type: 'WEB', id: 'VBB', name: 'VBB WebApp', l: 'vs_webapp_vbb'},
    ver: '1.45',
    auth: {type: 'AID', aid: 'hafas-vbb-webapp'}
  }
}

export function parseRadar(json: any, nowTime: string): Vehicle[] {
  const svc = json?.svcResL?.[0]
  if (!svc || svc.err !== 'OK') throw new Error(`HAFAS error: ${svc?.err ?? 'no svcResL'}`)
  const res = svc.res
  const common = {
    locs: res.common?.locL ?? [],
    prods: res.common?.prodL ?? []
  }
  return (res.jnyL ?? [])
    .map((j: Journey) => transformJourney(j, common, nowTime))
    .filter((v: Vehicle | null): v is Vehicle => v !== null)
}

export async function fetchVehicles(bbox: BBox, maxJny = 2000, signal?: AbortSignal): Promise<Vehicle[]> {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const res = await fetch(`${GATE_URL}?rnd=${Date.now()}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(buildRadarBody(bbox, date, time, maxJny)),
    signal
  })
  if (!res.ok) throw new Error(`HAFAS HTTP ${res.status}`)
  const json = await res.json()
  return parseRadar(json, time)
}
```

**Step 4: Verify passes**

Run: `npm test`
Expected: PASS — 3 tests.

**Step 5: Live smoke (real endpoint, browser-identical code path)**

Run:
```bash
npx vitest run src/hci.test.ts && node --input-type=module -e "
import {fetchVehicles} from './src/hci.ts'
" 2>/dev/null || npx tsx -e "
import {fetchVehicles} from './src/hci.ts'
const v = await fetchVehicles({north: 52.68, west: 13.08, south: 52.34, east: 13.76})
const by = {}
for (const x of v) by[x.product] = (by[x.product]||0)+1
console.log('vehicles:', v.length, JSON.stringify(by))
console.log('sample:', JSON.stringify(v[0]))
"
```
Expected: `vehicles: ~283`, products `{suburban: ~105, subway: ~55, tram: ~120}` (time-of-day dependent), sample has line/pos/nextStop. If network fails, retry once, then continue.

**Step 6: Commit**

```bash
git add src/hci.ts src/hci.test.ts && git commit -m "feat: HCI JourneyGeoPos client (build, parse, fetch)"
```

---

### Task 4: Static network data prep (stations, routes, line colors)

**Files:**
- Create: `scripts/prepare-data.mjs`
- Create (generated): `public/stations.json` — GeoJSON FeatureCollection of rail stops
- Create (generated): `public/routes.json` — GeoJSON FeatureCollection of rail route polylines
- Create (generated): `src/line-colors.ts` — `export const lineColors: Record<string, string>`

**Step 1: Write the script**

`scripts/prepare-data.mjs` (skeleton; refined in steps 2–4):
```js
// One-off data prep: VBB GTFS + line colors -> committed static assets.
// Refresh (GTFS updates 2x weekly): npm run prepare:data
import {execSync} from 'node:child_process'
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'vbb-'))
const run = c => execSync(c, {stdio: 'inherit', cwd: tmp})
run(`curl -sL -o vbb.zip https://unternehmen.vbb.de/gtfs`)
run(`unzip -o -q vbb.zip -d gtfs`)
run(`curl -sL -o lf.zip https://unternehmen.vbb.de/fileadmin/user_upload/VBB/Dokumente/API-Datensaetze/linienfarben.zip`)
run(`unzip -o -q lf.zip -d lf`)
console.log('tmp:', tmp) // inspect manually if step 2 fails
```

**Step 2: Inspect GTFS structure**

Run: `node scripts/prepare-data.mjs` — prints tmp dir. Then inspect:
- `routes.txt` header + sample rows (`cat tmp/gtfs/routes.txt | head`): record `route_type` values (expect 0 tram, 1 subway, 2 rail; S-Bahn vs regional distinguished by `route_short_name` matching `/^S\d/` or `/^S4[12]$/`).
- `linienfarben` CSV header: find the column containing hex colors and the column with line names.
Record findings as comments in the script.

**Step 3: Complete the script**

Append to `scripts/prepare-data.mjs`:
- Parse `routes.txt` → keep rail routes: tram (route_type 0), subway (1), S-Bahn (2 + short_name matches `/^S\d/`).
- Parse `trips.txt` (route per trip), `shapes.txt` (shape_id → ordered `[lat, lon]`), `stops.txt` (stop_id → {name, lat, lon}).
- **routes.json:** per rail route, one representative trip's shape; decimate to ≤ 500 points (keep every k-th); feature `{type: 'Feature', geometry: {type: 'LineString', coordinates}, properties: {line: short_name, product}}`.
- **stations.json:** stops referenced by rail trips' `stop_times.txt`; feature `{type: 'Feature', geometry: {type: 'Point', coordinates: [lon, lat]}, properties: {name}}`; dedupe by stop_id.
- **line-colors.ts:** parse linienfarben CSV → `export const lineColors: Record<string, string> = {...}` keyed by line name (e.g. `S7`, `U2`, `M10`); skip rows without hex.
- Write outputs to `public/` and `src/`; print summary counts.

**Step 4: Run + verify**

Run: `npm run prepare:data`
Expected: summary like `stations: ~1800 · routes: ~45 · lineColors: ~55`.
Validate JSON: `node -e "const s=JSON.parse(require('fs').readFileSync('public/stations.json','utf8')); console.log(s.features.length)"`
Sanity: routes include S41/S42/U1–U9/trams, no RE/RB/ICE; stations in the low thousands (no bus stops).

**Step 5: Commit**

```bash
git add scripts public src/line-colors.ts && git commit -m "feat: static network data (stations, routes, line colors)"
```

---

### Task 5: Map shell + mobile styles

**Files:**
- Modify: `src/main.ts`
- Modify: `src/style.css`

**Step 1: Replace main.ts shell**

`src/main.ts`:
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

**Step 2: Full styles (desktop + mobile + badges)**

`src/style.css`:
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
.veh-icon { border: none; background: none; }
.veh {
  min-width: 24px; height: 20px; padding: 0 4px; border-radius: 10px;
  color: #fff; font: 700 11px/20px system-ui; text-align: center;
  border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.5);
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

Run: `npm run dev` (background), browser `http://localhost:5173` — Berlin map, no console errors; narrow viewport moves filters bar to bottom. Stop dev server.

**Step 4: Commit**

```bash
git add src/main.ts src/style.css && git commit -m "feat: map shell with mobile styles"
```

---

### Task 6: Live map — polling, badges, layers, toggles

**Files:**
- Modify: `src/main.ts`

**Step 1: Replace main.ts with the live map**

`src/main.ts`:
```ts
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './style.css'
import {fetchVehicles, BBox} from './hci.js'
import {Product, Vehicle} from './vehicle.js'
import {lineColors} from './line-colors.js'

const BERLIN_BBOX: BBox = {north: 52.68, west: 13.08, south: 52.34, east: 13.76}
const POLL_INTERVAL_MS = 20000
const MAX_BACKOFF_MS = 60000

const PRODUCT_COLORS: Record<Product, string> = {suburban: '#2e7d32', subway: '#1565c0', tram: '#c62828'}
const PRODUCT_LABELS: Record<Product, string> = {suburban: 'S-Bahn', subway: 'U-Bahn', tram: 'Tram'}

const map = L.map('map').setView([52.52, 13.405], 12)
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map)

const vehicleLayer = L.layerGroup().addTo(map)
const markers = new Map<string, L.Marker>()
const filters: Record<Product, boolean> = {suburban: true, subway: true, tram: true}
let vehicles: Vehicle[] = []
let lastUpdate = 0
let conn: 'live' | 'stale' | 'offline' = 'offline'

const statusEl = document.getElementById('statusbar')!
function updateStatus() {
  const ago = lastUpdate ? Math.round((Date.now() - lastUpdate) / 1000) : 0
  const count = vehicles.filter(v => filters[v.product]).length
  statusEl.textContent = `${conn} · ${count} vehicles · updated ${ago}s ago`
}
setInterval(updateStatus, 1000)

function badgeHtml(v: Vehicle): string {
  const color = lineColors[v.line] ?? PRODUCT_COLORS[v.product]
  return `<div class="veh" style="background:${color}">${v.line}</div>`
}

function render() {
  const visible = vehicles.filter(v => filters[v.product])
  const seen = new Set<string>()
  for (const v of visible) {
    seen.add(v.id)
    let m = markers.get(v.id)
    if (!m) {
      m = L.marker([v.lat, v.lon], {icon: L.divIcon({className: 'veh-icon', html: badgeHtml(v)})}).bindPopup('')
      m.addTo(vehicleLayer)
      markers.set(v.id, m)
    }
    m.setLatLng([v.lat, v.lon])
    m.setIcon(L.divIcon({className: 'veh-icon', html: badgeHtml(v)}))
    m.setPopupContent(
      `<b>${v.line}</b> ${PRODUCT_LABELS[v.product]}<br>→ ${v.direction}<br>next: ${v.nextStop ?? '—'}` +
      (v.delayMs != null ? `<br><span style="color:${v.delayMs >= 300000 ? '#c62828' : '#333'}">delay: ${Math.round(v.delayMs / 60000)} min</span>` : '')
    )
  }
  for (const [id, m] of markers) {
    if (!seen.has(id)) { m.remove(); markers.delete(id) }
  }
}

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

// --- polling with client-side backoff ---
let nextDelay = POLL_INTERVAL_MS
let failures = 0
let controller: AbortController | null = null
async function poll() {
  controller = new AbortController()
  const t = setTimeout(() => controller!.abort(), 15000)
  try {
    vehicles = await fetchVehicles(BERLIN_BBOX, 2000, controller.signal)
    lastUpdate = Date.now()
    failures = 0
    nextDelay = POLL_INTERVAL_MS
    conn = 'live'
    render()
  } catch (err) {
    failures++
    conn = 'offline'
    nextDelay = Math.min(POLL_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS)
    console.warn('[poll]', err)
  } finally {
    clearTimeout(t)
    setTimeout(() => void poll(), nextDelay)
  }
}
void poll()

// --- mode filters + layer toggles ---
const filterEl = document.getElementById('filters')!
const modeRow = document.createElement('div')
modeRow.className = 'mode'
;(Object.keys(PRODUCT_LABELS) as Product[]).forEach(p => {
  const label = document.createElement('label')
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = true
  cb.onchange = () => { filters[p] = cb.checked; render() }
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

**Step 2: Build + serve**

Run: `npm run build`
Expected: `tsc` clean, `dist/` contains `index.html`, `stations.json`, `routes.json`.

**Step 3: Browser verification** (@verification-before-completion, @frontend-design)

Run: `npm run preview` (background), drive `http://localhost:4173` with the browser tool:
- Map shows Berlin; colored line badges (S7, U2, M10…) appear within ~2 s of first poll.
- Badge colors match `line-colors.ts` (spot-check).
- Wait ≥ 20 s: badges move to new positions.
- Uncheck U-Bahn: blue badges disappear, count drops.
- Enable Stations: stop dots appear; enable Routes: polylines appear.
- Click a badge → popup with line, direction, next stop, delay.
- Status bar: `live · N vehicles · updated Ns ago`.
- Narrow viewport: filters at bottom, usable.
- Kill network (devtools offline or block `/gate`) → status flips to `offline`, badges stay, backoff engages. Re-enable → recovers.

**Step 4: Commit**

```bash
git add src/main.ts && git commit -m "feat: live map with polling, badges, layers, toggles"
```

---

### Task 7: Static deployment

**Files:**
- Create: `README.md` (deploy instructions; brief)

**Step 1: README.md**

```markdown
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
```

**Step 2: Verify production build**

Run: `npm run build && npm run preview` (background) → `http://localhost:4173`: full app works (repeat Task 6 step 3 spot-checks: badges, filters, popups).

**Step 3: Commit**

```bash
git add README.md && git commit -m "docs: deployment instructions"
```

---

### Task 8: Final verification

Run: `npm test` — all PASS.
Run: `npm run build` — clean.
Browser smoke on `vite preview` build — badges, movement, filters, station/route toggles, popups, status bar, mobile viewport.
Confirm attribution footer visible.

Expected final tree:
```
src/{main.ts, hci.ts, hci.test.ts, vehicle.ts, vehicle.test.ts, line-colors.ts, style.css}
public/{stations.json, routes.json}
scripts/prepare-data.mjs
index.html, package.json, tsconfig.json, vite.config.ts, README.md
```

Commit any stragglers: `git add -A && git commit -m "chore: final verification"` (only if changes).

**Done.** End-to-end behavior: open static URL → live map of Berlin rail vehicles, line-labeled badges moving every ~20 s (browser polls VBB directly), station/route layers, mode filters, mobile-friendly.

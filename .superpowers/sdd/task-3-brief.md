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
npx tsx -e "
import {fetchVehicles} from './src/hci.ts'
const v = await fetchVehicles({north: 52.68, west: 13.08, south: 52.34, east: 13.76})
const by = {}
for (const x of v) by[x.product] = (by[x.product]||0)+1
console.log('vehicles:', v.length, JSON.stringify(by))
console.log('sample:', JSON.stringify(v[0]))
"
```
Expected: `vehicles: ~283`, products `{suburban: ~105, subway: ~55, tram: ~120}` (time-of-day dependent), sample has line/pos/nextStop. If the network fails, retry once, then continue (upstream is external).

**Step 6: Commit**

```bash
git add src/hci.ts src/hci.test.ts && git commit -m "feat: HCI JourneyGeoPos client (build, parse, fetch)"
```

---


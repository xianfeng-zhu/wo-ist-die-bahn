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


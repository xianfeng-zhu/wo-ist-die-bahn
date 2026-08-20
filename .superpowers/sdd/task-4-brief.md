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


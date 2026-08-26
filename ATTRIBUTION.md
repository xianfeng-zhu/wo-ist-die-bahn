# Attribution and third-party terms

The code in this repository is MIT licensed (see `LICENSE`). The transit data and
the map tiles are not ours. They belong to other parties and carry their own
terms. This file records them.

## Transit network data — VBB, CC BY 4.0

**Files:** `public/routes.json`, `public/stations.json`, `public/tracks.json`,
`src/line-colors.ts`

**Creator:** © VBB Verkehrsverbund Berlin-Brandenburg GmbH

**Source:** VBB GTFS feed <https://unternehmen.vbb.de/gtfs> and the VBB
Linienfarben colour table, both published at
<https://unternehmen.vbb.de/digitale-services/datensaetze/>

**Licence:** Creative Commons Attribution 4.0 International (CC BY 4.0)
<https://creativecommons.org/licenses/by/4.0/>

**Modified: yes.** These files are not the VBB data. They are derived from it by
`scripts/prepare-data.mjs`, which:

- keeps only S-Bahn, U-Bahn and Berlin tram routes, and drops regional, express,
  bus and ferry ones
- selects up to 12 route variants per line from the ~2,200 GTFS shapes, after
  collapsing near-duplicates
- simplifies every shape with Douglas–Peucker at a 10 m tolerance, reducing
  708,000 points to about 117,000
- merges each colour group's variants into the track they share, so one set of
  rails is drawn once rather than once per line (`scripts/tracks.mjs`)
- rounds coordinates to five decimal places, about one metre
- keeps only rail stops, and only their name and position
- extracts line colours from the Linienfarben CSV for the lines this app renders

## Live vehicle positions — VBB HAFAS

Live positions come from `https://fahrinfo.vbb.de/gate`, VBB's HAFAS endpoint,
queried directly from the browser.

**This is not a sanctioned integration.** The app sends VBB's own web-app
identifier (`aid: 'hafas-vbb-webapp'`), which is a public string taken from their
public web app, not a credential issued to this project.

VBB's documented route is a registered REST API. You describe your project to
them, receive test access, and agree to their usage rules before production
access is granted:
<https://unternehmen.vbb.de/digitale-services/api/>

**If you deploy this, register with VBB first.** Their published conditions
include using the API efficiently, naming VBB as the source of the timetable
data, and accepting that there is no entitlement to access. VBB may disable an
identifier that overloads their system.

## Map tiles — OpenStreetMap

Raster tiles come from `https://tile.openstreetmap.org/`.

**Data:** © OpenStreetMap contributors, licensed under the Open Database Licence
(ODbL) <https://www.openstreetmap.org/copyright>

Tile use follows the OSM Foundation tile usage policy
<https://operations.osmfoundation.org/policies/tiles/>. Normal interactive
viewing is permitted, which is what this app does: MapLibre requests only the
tiles for the current viewport, and there is no prefetching or offline caching.

**Two things to know before you deploy a fork.** The tiles are a
donation-funded volunteer service with no availability guarantee, and access can
be blocked without notice. If your deployment attracts real traffic, use your own
tile source or a commercial provider. Also, do not send a `Referrer-Policy` that
strips the referrer — the policy requires a valid `Referer` from web pages.

The tile URL is set in `src/main.ts` and is the only line you need to change.

## Map library — MapLibre GL JS

`public/maplibre-gl-shared.mjs` and `public/maplibre-gl-worker.mjs` are
unmodified build artefacts of MapLibre GL JS 6.4.1, committed because Vite does
not emit the worker. MapLibre GL JS is BSD-3-Clause.

Full licence text, covering all four upstream copyright holders, is in
`THIRD-PARTY-NOTICES.md`.

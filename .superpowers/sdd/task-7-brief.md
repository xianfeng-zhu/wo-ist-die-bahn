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


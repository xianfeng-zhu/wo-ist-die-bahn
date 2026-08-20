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

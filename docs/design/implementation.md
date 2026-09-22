# Stitch redesign implementation

Design project: https://stitch.withgoogle.com/projects/641605759907392717

## Scope

The app adopts Stitch's bright Berlin Transit Modernism direction: a unified branded header and search field, light surfaces, restrained blue accents, Inter typography, local SVG icons, neutral detail cards, readable line badges, and redesigned timeline/departure rows. The existing geographic OSM map and official line colors remain the source of map identity.

Changes stay in `index.html`, `src/main.ts`, `src/panel.ts`, `src/style.css`, and one presentation label in `src/views.ts`. `src/icons.ts` supplies local icons; `src/assets/` contains self-hosted Inter and its license. No framework, backend, data provider, forecast math, track geometry or polling changes were introduced.

The local refactors move search and shared actions into a header, separate the line badge from the neutral detail heading, and measure the actual header/toolbar/detail bounds for map camera clearance. Type and Line remain immediate multi-selects, with All/none behavior, line search and existing selection persistence. Map settings and details retain access to the existing share action.

Generated examples contained invented metadata, controls and inconsistent selection states despite iterative feedback. Those were reviewed and sent back to Stitch; the implementation follows the product brief and real data-rendering code instead of hardcoded sample content. See `stitch-review.md` and `stitch-screens.json` for the design lineage.

## Responsive behavior

Desktop keeps a floating header, filter toolbar and side detail card. Phones use settings/details sheets and retain useful map space above live-vehicle details. The shared compact breakpoint remains 720px. Most vehicle sheets retain 50% viewport height; short portrait/compact landscape windows use 60% to keep the list readable.

At short portrait and short desktop sizes, the timeline reserves a readable region and long detail headings can scroll independently. This is a deliberate accommodation for small windows: the next-stop summary stays fixed while the body scrolls, but can require scrolling within the header itself. The header is keyboard-focusable only in these constrained layouts, and its scroll resets on navigation. Ordinary windows retain a fully visible fixed summary. Redundant footer sharing is hidden on short desktop windows where the global share action remains visible.

## Verification

- TypeScript/production build and the existing 301 tests pass. The existing large JavaScript chunk warning remains.
- Ten deterministic browser checks passed for filters, search focus, station → future schedule/live vehicle → station navigation, browser Back/Forward, Close, layout bounds and runtime errors. Fixtures use a saved radar response and synthetic board/schedule data.
- Additional layout checks covered 320×568, 390×844, 720×600, 721×480, 844×390 and 1440×960, including expanded menus, selected-vehicle visibility and linked map attribution.
- Independent review caught short-window timeline collapse. Normal and longer destination fixtures now retain 100px of usable list height at 320×568 and 104px at 844×390, with the selected map subject visible. Independent rerun confirmed the fix and found no remaining actionable regression.
- Production-build checks exercised empty departures, failed initial board load, stale feed warning and mobile settings share/clipboard feedback using controlled responses.
- A separate production-browser run used the real VBB feed: vehicles and departures loaded, Inter loaded locally, no page runtime errors occurred, and no Debug view control appeared. Screenshots are saved under the gitignored `review-screenshots/` directory.

Existing unrelated limitations noted in `interaction-checklist.md` remain outside this redesign.

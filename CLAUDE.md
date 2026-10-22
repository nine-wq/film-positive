# CLAUDE.md: ฟิล์มบล็อคสกรีน (film-positive)

Internal tool for Viczo International (screen-printing ink maker, Thailand). Owner: Nine. Thai UI.
Turns customer sock-print artwork (.ai PDF-compatible / .pdf / .zip, multi-page) into film positives and gangs them on a 21×31 in sheet.

## Stack
- Cloudflare Worker `src/index.js`: only `/api/settings` (GET → `{film, customers}`, PUT `{film, baseUpdated}` → 409 on stale base). Static assets in `public/`.
- D1 binding `DB` = **stencil-db, shared with the stencil-log app**. Read `settings.key='master'` (customers, `customerSpecs[name].target` µm) — never write it. Write only `settings.key='film'`. Never create or alter other tables.
- No build step. `public/js/film-core.js` = analysis/rendering core (also runs in Node with `require('pdf-lib')` for tests). `public/index.html` = UI.
- Vendored libs in `public/vendor/` (pdf-lib 1.17.1, JSZip 3.10.1, PDF.js 3.11.174 with a real worker).

## Core rules (film-core.js)
- Designs are found from platen frames: dashed/solid rectangles assembled from same-style axis-aligned segments, closed sock-shaped outlines (stroke) or outlined rings (fill with ink ratio < 0.15). Same-size frames side by side = one design (left+right). Fallback: cluster artwork when no frame.
- Artwork = printable elements whose centre is inside a frame. Guides are decided by role, not line weight: frame lines, dashed lines, colours used for dimension lines outside frames (and never for fills inside), large stroke-only shapes ≥60% of the frame, pieces on the frame edge. Only < 0.1 mm lines are dropped by weight.
- Single-colour film: every artwork colour → black; white shapes inside frames knock out. Clipped to frames.
- Edge compensation per design: auto = thickness × factor (default 0.5), manual µm, none. Implemented as round-join stroke 2r on fills (holes shrink), stroke width + 2r on strokes (caps unchanged).
- Marks: 3 faint crosses on the centre line between frames; 2-line faint label 10 mm below the lowest cross (customer - file / thickness · compensation · date).

## Rules
- UI text in Thai; must work at 400 px width and in dark mode.
- Before pushing: `node --check public/js/film-core.js` and `node --check --input-type=module < src/index.js`.
- Deploy = push to `main` (Workers Builds runs `npx wrangler deploy`). No secrets in the repo.

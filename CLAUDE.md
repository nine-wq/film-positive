# CLAUDE.md: ฟิล์มบล็อคสกรีน (film-positive)

Internal tool for Viczo International (screen-printing ink maker, Thailand). Owner: Nine. Thai UI.
Turns customer sock-print artwork (.ai PDF-compatible / .pdf / .zip, multi-page) into film positives and gangs them on a 21×31 in sheet.

## Stack
- Cloudflare Worker `src/index.js`. Static assets in `public/`. API:
  - `/api/settings` GET → `{film, customers, features}`, PUT `{film, baseUpdated}` → 409 on stale base.
  - `/api/films` POST multipart (`name`, `info` JSON, `file` PDF, optional `thumb_<n>` image per info.items[n]) → archive; GET `?limit&before&q&from&to` → newest first (q = words, all must match name/info). `/api/films/:id` GET (inline, `?dl=1` attachment), DELETE (also removes `film/<id>/` thumbs). `/api/films/:id/t<n>` = design thumbnail.
- D1 binding `DB` = **stencil-db, shared with the stencil-log app**. Read `settings.key='master'` (customers, `customerSpecs[name].target` µm) — never write it. Write only `settings.key='film'` and the app's own table `film_outputs` (id, name, created, size, info JSON). Never alter stencil-log tables.
- Customer originals: `POST /api/originals?film&name&sha` (raw body) stores the file once per content at R2 `film/orig/<sha256>` and appends `{name, sha, size}` to `film_outputs.info.originals`; `GET /api/originals/<sha>?name=` downloads it. Deleting a film removes an original only when no other film references its sha.
- R2 binding `FILES` = **stencil-files, shared with stencil-log**. This app only uses keys under `film/` (`film/<id>.pdf`, thumbnails `film/<id>/t<n>`, originals `film/orig/<sha256>`).
- No build step. `public/js/film-core.js` = analysis/rendering core (also runs in Node with `require('pdf-lib')` for tests). `public/index.html` = UI.
- Vendored libs in `public/vendor/` (pdf-lib 1.17.1, JSZip 3.10.1, PDF.js 3.11.174 with a real worker).

## Core rules (film-core.js)
- Designs are found from platen frames: dashed/solid rectangles assembled from same-style axis-aligned segments, closed sock-shaped outlines (stroke) or outlined rings (fill with ink ratio < 0.15). Same-size frames side by side = one design (left+right). Fallback: cluster artwork when no frame.
- Artwork = printable elements whose centre is inside a frame. Guides are decided by role, not line weight: frame lines, dashed lines, colours used for dimension lines outside frames (and never for fills inside), large closed stroke-only shapes ≥60% of the frame, pieces on the frame edge. Only < 0.1 mm lines are dropped by weight.
- Specks (setting `speckMm`, default 0.2 mm): separate artwork pieces smaller than this, and tiny subpaths / lone move-tos inside artwork paths, are dropped before compensation (they would grow into visible dots). Card reports the count.
- The "big stroke-only shape ≥60% of the frame" guide rule applies only to closed outlines (guide circles); open lines stay artwork unless another guide rule matches.
- Single-colour film: every artwork colour → black; white shapes inside frames knock out. Clipped to frames.
- Near-white counts as white (setting `nearWhite`, default 5 = total ink C+M+Y+K ≤ 5%, or RGB/gray within 5% of white): customer files carry invisible leftovers such as a C 0.1% box with a star-shaped hole. They knock out like white; the card reports how many.
- Edge compensation per design: auto = thickness × factor (default 0.5), manual µm, none. Implemented as round-join, butt-cap stroke 2r on fills with every subpath closed (holes shrink), stroke width + 2r on strokes (caps unchanged).
- Marks: 3 faint crosses on the centre line between frames; 2-line faint label 10 mm below the lowest cross (customer - file / thickness · compensation · date).

## Rules
- Saving a PDF first stores the history copy and originals on the server (button disabled, beforeunload warning while busy), and only then starts the download. By default it archives ("เก็บสำเนาในประวัติ"), then ("เก็บไฟล์ต้นฉบับ", on by default, needs the history copy) stores each distinct original file; the ประวัติ tab lists, opens, downloads and deletes archived films.
- UI text in Thai; must work at 400 px width and in dark mode.
- D1 rejects LIKE/GLOB patterns longer than 50 bytes (local wrangler dev does not): use `instr()` for substring matches, never LIKE with long values (e.g. sha256).
- Before pushing: `node --check public/js/film-core.js` and `node --check --input-type=module < src/index.js`.
- Deploy = push to `main` (Workers Builds runs `npx wrangler deploy`). No secrets in the repo.

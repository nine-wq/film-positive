/* Film positive core — works in the browser (globals PDFLib, pako) and in Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('pdf-lib'));
  else root.FilmCore = factory(root.PDFLib);
})(typeof self !== 'undefined' ? self : this, function (PDFLib) {
  'use strict';
  const { PDFDocument, PDFName, PDFArray, PDFRawStream, PDFStream, PDFDict, StandardFonts, cmyk, degrees, decodePDFRawStream } = PDFLib;
  const MM = 72 / 25.4;

  /* ---------- bytes <-> latin1 ---------- */
  function toLatin1(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return s;
  }
  function fromLatin1(s) {
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255;
    return u;
  }

  /* ---------- content stream tokenizer ---------- */
  const WS = ' \t\n\r\f\0';
  const DELIM = '()<>[]{}/%';
  function isWs(c) { return WS.indexOf(c) >= 0; }
  function tokenize(src) {
    const ops = []; let args = []; let i = 0; const n = src.length;
    function skipWs() {
      while (i < n) {
        const c = src[i];
        if (isWs(c)) i++;
        else if (c === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; }
        else break;
      }
    }
    function readObj() {
      const start = i; const c = src[i];
      if (c === '(') {
        let depth = 0;
        while (i < n) {
          const d = src[i];
          if (d === '\\') { i += 2; continue; }
          if (d === '(') depth++;
          else if (d === ')') { depth--; if (depth === 0) { i++; break; } }
          i++;
        }
        return { raw: src.slice(start, i), type: 'str' };
      }
      if (c === '<' && src[i + 1] === '<') {
        i += 2;
        while (i < n) {
          skipWs();
          if (src[i] === '>' && src[i + 1] === '>') { i += 2; break; }
          readObj();
        }
        return { raw: src.slice(start, i), type: 'dict' };
      }
      if (c === '<') { while (i < n && src[i] !== '>') i++; i++; return { raw: src.slice(start, i), type: 'hex' }; }
      if (c === '[') {
        i++; const items = [];
        while (i < n) { skipWs(); if (src[i] === ']') { i++; break; } items.push(readObj()); }
        return { raw: src.slice(start, i), type: 'arr', items };
      }
      if (c === '/') {
        i++; while (i < n && !isWs(src[i]) && DELIM.indexOf(src[i]) < 0) i++;
        return { raw: src.slice(start, i), type: 'name', name: src.slice(start + 1, i) };
      }
      // number or keyword
      while (i < n && !isWs(src[i]) && DELIM.indexOf(src[i]) < 0) i++;
      if (i === start) { i++; return { raw: c, type: 'junk' }; }
      const raw = src.slice(start, i);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) return { raw, type: 'num', num: parseFloat(raw) };
      return { raw, type: 'kw' };
    }
    while (true) {
      skipWs(); if (i >= n) break;
      const t = readObj();
      if (t.type === 'kw' && !/^(true|false|null)$/.test(t.raw)) {
        if (t.raw === 'BI') { // inline image: swallow up to EI
          const re = /\sEI(?=[\s]|$)/g; re.lastIndex = i;
          const m = re.exec(src); const end = m ? m.index + m[0].length : n;
          ops.push({ op: 'BI', args: [], raw: 'BI' + src.slice(i, end) }); i = end; args = []; continue;
        }
        ops.push({ op: t.raw, args }); args = [];
      } else args.push(t);
    }
    return ops;
  }
  const nums = (args) => args.filter(a => a.type === 'num').map(a => a.num);

  /* ---------- colour keys ---------- */
  function colourKey(op, args) {
    const name = args.find(a => a.type === 'name');
    if (name && (op === 'scn' || op === 'SCN')) return 'pattern:' + name.name;
    const v = nums(args).map(x => +x.toFixed(4));
    const kind = { k: 'cmyk', K: 'cmyk', rg: 'rgb', RG: 'rgb', g: 'gray', G: 'gray' }[op]
      || (v.length === 4 ? 'cmyk' : v.length === 3 ? 'rgb' : v.length === 1 ? 'gray' : 'other');
    return kind + ':' + v.join(' ');
  }
  /* Colours this light count as paper (white): they knock out like white instead of printing.
     Customers' files often carry near-white leftovers (e.g. C 0.1%) that are invisible on screen.
     Limit = total ink in percent (C+M+Y+K, or how far RGB/gray is from white); set from the settings. */
  let nearWhitePct = 5;
  function setNearWhite(p) { const v = Number(p); nearWhitePct = Number.isFinite(v) && v >= 0 ? Math.min(v, 50) : 5; }
  function keyInfo(key) {
    const [kind, rest] = key.split(':'); const v = (rest || '').split(' ').map(Number);
    let r = 0, g = 0, b = 0, ink = null, label = key, pure = false;
    if (kind === 'cmyk') { [r, g, b] = [0, 1, 2].map(j => 255 * (1 - v[j]) * (1 - v[3])); ink = 100 * (v[0] + v[1] + v[2] + v[3]); pure = v.every(x => x === 0);
      label = 'C' + Math.round(v[0] * 100) + ' M' + Math.round(v[1] * 100) + ' Y' + Math.round(v[2] * 100) + ' K' + Math.round(v[3] * 100); }
    else if (kind === 'rgb') { [r, g, b] = v.map(x => 255 * x); ink = 100 * (1 - Math.min(...v)); pure = v.every(x => x === 1); label = 'RGB ' + v.map(x => Math.round(x * 255)).join(' '); }
    else if (kind === 'gray') { r = g = b = 255 * v[0]; ink = 100 * (1 - v[0]); pure = v[0] === 1; label = 'Gray ' + Math.round((1 - v[0]) * 100) + '%'; }
    else if (kind === 'spot') {   // spot colour (Separation / DeviceN): the numbers are ink tints, 1 = full ink
      const sp = rest.split(' '), names = decodeURIComponent(sp[0]).split('|'), t = sp.slice(1).map(Number);
      ink = 100 * t.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0); pure = t.every(x => x === 0);
      if (names.length === 1 && names[0] === 'All') ink = Math.max(ink, 100);   // registration colour
      const base = names.length === 1 && spotCss[names[0]];
      [r, g, b] = base ? base.map(c => 255 - (255 - c) * Math.min(1, t[0])) : [160, 160, 160];
      label = names.join(' + ') + ' ' + t.map(x => Math.round(x * 100) + '%').join(' / ');
    }
    else { r = g = b = 160; label = kind === 'pattern' ? 'Pattern / gradient' : key; }
    const white = pure || (ink != null && Number.isFinite(ink) && ink <= nearWhitePct + 1e-9);
    const css = 'rgb(' + [r, g, b].map(x => Math.round(Math.max(0, Math.min(255, x)))).join(',') + ')';
    return { css, white, nearWhite: white && !pure, label };
  }

  /* ---------- geometry ---------- */
  const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
  const tx = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
  function bez(p0, p1, p2, p3, out) {
    for (let k = 1; k <= 8; k++) { const t = k / 8, u = 1 - t;
      out.push([u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0], u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]]); }
  }

  /* ---------- analysis ---------- */
  async function readContents(doc, page) {
    const c = page.node.Contents(); const parts = [];
    const streams = c instanceof PDFArray ? c.asArray().map(r => doc.context.lookup(r)) : [c];
    for (const s of streams) {
      if (!s) continue;
      const bytes = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
      parts.push(toLatin1(bytes));
    }
    return parts.join('\n');
  }
  /* Colour spaces named in the page resources. Spot colours (Separation / DeviceN) set ink TINTS with sc/scn,
     so "1 scn" there is full ink, not gray 1 (= white). ICCBased spaces behave like Device gray/RGB/CMYK. */
  const spotCss = {};
  function colourSpaces(doc, page) {
    const out = {};
    const res = page.node.Resources(); if (!res) return out;
    const cs = res.has(PDFName.of('ColorSpace')) ? res.lookup(PDFName.of('ColorSpace')) : null; if (!(cs instanceof PDFDict)) return out;
    const L = (o) => doc.context.lookup(o);
    const nm = (o) => { o = L(o); return o instanceof PDFName ? decodeURIComponent(o.asString().slice(1).replace(/#([0-9a-f]{2})/gi, '%$1')) : null; };
    const num = (o) => { o = L(o); return o && typeof o.asNumber === 'function' ? o.asNumber() : NaN; };
    for (const [k, v] of cs.entries()) {
      const key = k.asString().slice(1), o = L(v);
      if (!(o instanceof PDFArray) || !o.size()) continue;
      const fam = nm(o.get(0));
      if (fam === 'Separation' || fam === 'DeviceN') {
        const names = fam === 'Separation' ? [nm(o.get(1))] : (L(o.get(1)) instanceof PDFArray ? L(o.get(1)).asArray().map(nm) : []);
        out[key] = { spot: names.map(n => n || '?') };
        try {   // approximate screen colour for the chip: alternate space + exponential (type 2) tint function at full tint
          const alt = L(o.get(2)), fn = L(o.get(3)), fd = fn instanceof PDFDict ? fn : fn && fn.dict;
          const an = alt instanceof PDFArray ? nm(alt.get(0)) : nm(alt);
          const c1 = fd && fd.lookup && fd.lookup(PDFName.of('C1')); const ft = fd && fd.lookup && num(fd.lookup(PDFName.of('FunctionType')));
          if (fam === 'Separation' && ft === 2 && c1 instanceof PDFArray) {
            const v1 = c1.asArray().map(num);
            if (an === 'DeviceCMYK' && v1.length === 4) spotCss[names[0]] = [0, 1, 2].map(j => 255 * (1 - v1[j]) * (1 - v1[3]));
            else if (an === 'DeviceRGB' && v1.length === 3) spotCss[names[0]] = v1.map(x => 255 * x);
            else if (an === 'DeviceGray' && v1.length === 1) spotCss[names[0]] = [255 * v1[0], 255 * v1[0], 255 * v1[0]];
          }
        } catch (e) {}
      } else if (fam === 'ICCBased') {
        const s = L(o.get(1)); const n = s && s.dict ? num(s.dict.get(PDFName.of('N'))) : NaN;
        out[key] = { dev: n === 1 ? 'gray' : n === 3 ? 'rgb' : n === 4 ? 'cmyk' : null };
      } else if (fam === 'Pattern') out[key] = { pattern: true };
    }
    return out;
  }
  // colour key for sc/scn in the current colour space
  function spaceKey(space, op, args) {
    if (space && space.spot && !args.some(a => a.type === 'name')) {
      const t = nums(args).map(x => +x.toFixed(4));
      return 'spot:' + encodeURIComponent(space.spot.join('|')) + ' ' + t.join(' ');
    }
    return colourKey(op, args);
  }
  function spaceInit(space, name) {   // the colour a "cs" operator starts with
    if (space && space.spot) return 'spot:' + encodeURIComponent(space.spot.join('|')) + ' ' + space.spot.map(() => 1).join(' ');
    if (name === 'DeviceCMYK' || (space && space.dev === 'cmyk')) return 'cmyk:0 0 0 1';
    return 'gray:0';
  }
  function xobjectKinds(doc, page) {
    const out = {};
    const res = page.node.Resources(); if (!res) return out;
    const xo = res.has(PDFName.of('XObject')) ? res.lookup(PDFName.of('XObject')) : null; if (!(xo instanceof PDFDict)) return out;
    for (const [k, v] of xo.entries()) {
      const o = doc.context.lookup(v);
      const st = o && o.dict ? o.dict.get(PDFName.of('Subtype')) : null;
      out[k.asString().slice(1)] = st ? st.asString().slice(1) : '?';
    }
    return out;
  }

  /* =====================================================================
     ANALYSIS
     Every painting operation becomes an "element" with its geometry:
       fill part   (colour, bbox)
       stroke part (colour, bbox, line width in pt, axis-aligned segments)
       text        (colour, origin point)
     Nothing is decided by colour or layer here; that comes later from where
     each element sits relative to the platen frames.
     ===================================================================== */
  function bboxOf(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    return [x0, y0, x1, y1];
  }
  const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  const W_ = (b) => b[2] - b[0], H_ = (b) => b[3] - b[1];
  const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const inside = (b, f, tol) => b[0] >= f[0] - tol && b[2] <= f[2] + tol && b[1] >= f[1] - tol && b[3] <= f[3] + tol;
  const centreIn = (b, f) => { const x = (b[0] + b[2]) / 2, y = (b[1] + b[3]) / 2; return x >= f[0] && x <= f[2] && y >= f[1] && y <= f[3]; };

  /* share of a filled shape's bounding box that is actually covered; a ring (an outlined stroke) covers very little */
  function polyArea(pts) { let a = 0; for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; }
  function inkRatio(subs, bb) {
    const polys = subs.filter(p => p.length > 2).map(p => ({ a: polyArea(p), b: bboxOf(p) })).sort((x, y) => y.a - x.a);
    if (!polys.length) return 1;
    let ink = 0; const outers = [];
    for (const p of polys) {
      const holeOf = outers.find(o => inside(p.b, o.b, 0.5));
      if (holeOf && !holeOf.hole) { ink -= p.a; p.hole = true; } else { ink += p.a; outers.push(p); }
      if (holeOf && holeOf.hole) outers.push(p);
    }
    return Math.max(0, ink) / (W_(bb) * H_(bb));
  }
  async function pageCount(bytes) { const d = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }); return d.getPageCount(); }
  async function analyze(bytes, name, pageIndex) {
    const pi = pageIndex || 0;
    const head = toLatin1(bytes.subarray(0, 1024));
    if (head.indexOf('%PDF') < 0) throw new Error('ไฟล์นี้ไม่ได้บันทึกแบบ PDF-compatible (ต้องติ๊ก Create PDF Compatible File ตอน Save ใน Illustrator)');
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const page = doc.getPage(pi);
    const ops = tokenize(await readContents(doc, page));
    const xk = xobjectKinds(doc, page);
    const spaces = colourSpaces(doc, page);
    const { width, height } = page.getSize();
    const warn = new Set(); const els = [];
    let gs = { ctm: [1, 0, 0, 1, 0, 0], fill: 'gray:0', stroke: 'gray:0', lw: 1, dash: false }; const stack = [];
    let path = [], sub = [], subs = [], segs = [], cur = [0, 0], start = [0, 0], closed = false;
    let tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0], fsz = 12, lead = 0;
    const P = (x, y) => tx(gs.ctm, x, y);
    const addSeg = (a, b) => segs.push([a, b]);
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i], a = nums(o.args);
      switch (o.op) {
        case 'q': stack.push({ ...gs }); break;
        case 'Q': if (stack.length) gs = stack.pop(); break;
        case 'cm': gs.ctm = mul(a, gs.ctm); break;
        case 'w': gs.lw = a[0]; break;
        case 'd': gs.dash = !!(o.args[0] && o.args[0].items && o.args[0].items.length); break;
        case 'k': case 'rg': case 'g': gs.fill = colourKey(o.op, o.args); gs.fcs = null; break;
        case 'K': case 'RG': case 'G': gs.stroke = colourKey(o.op, o.args); gs.scs = null; break;
        case 'sc': case 'scn': gs.fill = spaceKey(gs.fcs, o.op, o.args); break;
        case 'SC': case 'SCN': gs.stroke = spaceKey(gs.scs, o.op, o.args); break;
        case 'cs': case 'CS': { const n = o.args[0] && o.args[0].name, sp = n ? spaces[n] : null;
          if (o.op === 'cs') { gs.fcs = sp; gs.fill = spaceInit(sp, n); } else { gs.scs = sp; gs.stroke = spaceInit(sp, n); } break; }
        case 'm': { cur = start = [a[0], a[1]]; const p = P(a[0], a[1]); path.push(p); sub = [p]; subs.push(sub); break; }
        case 'l': { const p = P(a[0], a[1]); addSeg(sub[sub.length - 1] || p, p); path.push(p); sub.push(p); cur = [a[0], a[1]]; break; }
        case 'c': case 'v': case 'y': {
          const c1 = o.op === 'v' ? cur : [a[0], a[1]];
          const c2 = o.op === 'v' ? [a[0], a[1]] : o.op === 'y' ? [a[2], a[3]] : [a[2], a[3]];
          const e = o.op === 'c' ? [a[4], a[5]] : [a[2], a[3]];
          const pts = []; bez(cur, c1, c2, e, pts);
          pts.forEach(q => { const p = P(q[0], q[1]); path.push(p); sub.push(p); });
          cur = e; break; }
        case 're': {
          const c = [[a[0], a[1]], [a[0] + a[2], a[1]], [a[0] + a[2], a[1] + a[3]], [a[0], a[1] + a[3]]].map(q => P(q[0], q[1]));
          c.forEach(p => path.push(p)); subs.push(c.slice()); for (let k = 0; k < 4; k++) addSeg(c[k], c[(k + 1) % 4]);
          sub = [c[0]]; cur = [a[0], a[1]]; closed = true; break; }
        case 'h': if (sub.length > 1) addSeg(sub[sub.length - 1], sub[0]); cur = start; closed = true; break;
        case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': case 'S': case 's': case 'n': {
          if (path.length && o.op !== 'n') {
            const bb = bboxOf(path);
            const doFill = o.op !== 'S' && o.op !== 's', doStroke = /^[SsBb]/.test(o.op);
            if ((o.op === 's' || o.op[0] === 'b') && sub.length > 1) { addSeg(sub[sub.length - 1], sub[0]); closed = true; }
            if (sub.length > 2 && Math.hypot(sub[0][0] - sub[sub.length - 1][0], sub[0][1] - sub[sub.length - 1][1]) < 0.5) closed = true;
            const lwPt = gs.lw * Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])) || gs.lw;
            const el = { i, bb, s: Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])) || 1 };
            if (doFill) { el.fill = { key: gs.fill }; if (W_(bb) > 20 * MM && H_(bb) > 20 * MM) el.fill.ratio = inkRatio(subs, bb); }
            if (subs.length > 1) el.subMm = subs.map(p => { const q = bboxOf(p); return Math.max(W_(q), H_(q)) / MM; });
            if (doStroke) el.stroke = { key: gs.stroke, lw: lwPt, lwUser: gs.lw, dash: gs.dash, segs, closed, bb: [bb[0] - lwPt / 2, bb[1] - lwPt / 2, bb[2] + lwPt / 2, bb[3] + lwPt / 2] };
            els.push(el);
          }
          path = []; sub = []; subs = []; segs = []; closed = false; break; }
        case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); break;
        case 'Tf': fsz = a[0] || fsz; break;
        case 'TL': lead = a[0]; break;
        case 'Tm': tm = a.slice(0, 6); tlm = tm.slice(); break;
        case 'Td': case 'TD': tlm = mul([1, 0, 0, 1, a[0], a[1]], tlm); tm = tlm.slice(); if (o.op === 'TD') lead = -a[1]; break;
        case 'T*': tlm = mul([1, 0, 0, 1, 0, -lead], tlm); tm = tlm.slice(); break;
        case 'Tj': case 'TJ': case "'": case '"': {
          const m = mul(tm, gs.ctm); const p = tx(m, 0, 0); const h = fsz * Math.hypot(m[2], m[3]);
          els.push({ i, text: true, s: Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])) || 1, bb: [p[0], p[1], p[0] + h * 0.6, p[1] + h * 0.8], fill: { key: gs.fill } });
          break; }
        case 'sh': warn.add('มีสีไล่ระดับ (gradient) ซึ่งทำเป็นฟิล์มอัตโนมัติไม่ได้ ส่วนนั้นจะถูกตัดออก'); break;
        case 'BI': warn.add('มีรูปภาพแบบ raster ฝังอยู่ ส่วนนั้นจะถูกตัดออก'); break;
        case 'Do': { const nm = o.args[0] && o.args[0].name;
          warn.add(xk[nm] === 'Image' ? 'มีรูปภาพแบบ raster ฝังอยู่ ส่วนนั้นจะถูกตัดออก' : 'มีกลุ่มวัตถุซ้อน (symbol / transparency group) ที่อ่านไม่ได้ ส่วนนั้นจะถูกตัดออก'); break; }
      }
    }
    const job = { name, page: pi, bytes, ops, els, warnings: [...warn], width, height, excluded: new Set(), notArt: new Set() };
    return job;
  }

  /* =====================================================================
     FRAMES (platen outlines)
     Collect thin axis-aligned stroke segments, join dashes into long lines,
     then find rectangles whose four sides are all present.
     ===================================================================== */
  const styleOf = (e) => e.stroke.key + '|' + e.stroke.lw.toFixed(2) + '|' + (e.stroke.dash ? 'd' : 's');
  function findFrames(job) {
    job.frameEls = new Set(); job.frameStyles = new Set();
    const TOL = 2.5 * MM, H = [], V = [];
    for (const e of job.els) {
      if (!e.stroke || e.stroke.lw > 3 * MM) continue;       // frame outlines (any reasonable line weight)
      const style = styleOf(e);
      for (const [p, q] of e.stroke.segs) {
        const dx = Math.abs(q[0] - p[0]), dy = Math.abs(q[1] - p[1]);
        if (dy < 0.6 && dx > 0.5) H.push({ style, c: (p[1] + q[1]) / 2, a: Math.min(p[0], q[0]), b: Math.max(p[0], q[0]) });
        else if (dx < 0.6 && dy > 0.5) V.push({ style, c: (p[0] + q[0]) / 2, a: Math.min(p[1], q[1]), b: Math.max(p[1], q[1]) });
      }
    }
    function merge(list) {                                   // join collinear pieces of the same line style (dashes, corners)
      const rows = new Map();
      for (const s of list) {
        const key = s.style + '@' + Math.round(s.c / 0.8);
        let row = rows.get(key); if (!row) { row = { style: s.style, c: s.c, parts: [] }; rows.set(key, row); }
        row.parts.push(s);
      }
      const out = [];
      for (const r of rows.values()) {
        r.parts.sort((u, v) => u.a - v.a);
        let curr = null;
        for (const s of r.parts) {
          if (curr && s.a <= curr.b + 6 * MM) curr.b = Math.max(curr.b, s.b);
          else { if (curr) out.push(curr); curr = { style: r.style, c: r.c, a: s.a, b: s.b }; }
        }
        if (curr) out.push(curr);
      }
      return out.filter(l => l.b - l.a >= 20 * MM);
    }
    const HL = merge(H), VL = merge(V);
    const covers = (style, c, a, b) => {                      // share of [a,b] at position c drawn in this style
      let got = 0;
      for (const l of VL) if (l.style === style && Math.abs(l.c - c) <= TOL) got += overlap(l.a, l.b, a, b);
      return got / (b - a);
    };
    const rects = [];
    for (const bot of HL) for (const top of HL) {
      if (top.style !== bot.style || top.c - bot.c < 40 * MM) continue;
      if (Math.abs(bot.a - top.a) > TOL || Math.abs(bot.b - top.b) > TOL) continue;
      const x0 = (bot.a + top.a) / 2, x1 = (bot.b + top.b) / 2, w = x1 - x0, h = top.c - bot.c;
      if (w < 30 * MM || w > 320 * MM || h > 520 * MM) continue;
      if (covers(top.style, x0, bot.c, top.c) < 0.85 || covers(top.style, x1, bot.c, top.c) < 0.85) continue;
      const r = [x0, bot.c, x1, top.c]; r.style = top.style;
      if (!rects.some(q => Math.abs(q[0] - r[0]) < TOL && Math.abs(q[1] - r[1]) < TOL && Math.abs(q[2] - r[2]) < TOL && Math.abs(q[3] - r[3]) < TOL)) rects.push(r);
    }
    // snap each rectangle to the full extent of its own line style (dashes stop short of the corners)
    for (const r of rects) {
      const st = r.style, grow = 6 * MM; let bb = null;
      for (const e of job.els) {
        if (!e.stroke || styleOf(e) !== st) continue;
        if (!inside(e.bb, r, grow)) continue;
        bb = bb ? union(bb, e.bb) : e.bb.slice();
      }
      if (bb && Math.abs(W_(bb) - W_(r)) < 2 * grow && Math.abs(H_(bb) - H_(r)) < 2 * grow) { r[0] = bb[0]; r[1] = bb[1]; r[2] = bb[2]; r[3] = bb[3]; }
    }
    // closed outlines (rounded sock shapes, ovals) drawn as a single stroke also count as frames
    for (const e of job.els) {
      if (e.text) continue;
      const strokeOutline = e.stroke && e.stroke.closed && e.stroke.lw <= 3 * MM && !(e.fill && !keyInfo(e.fill.key).white);
      const ring = e.fill && !e.stroke && e.fill.ratio != null && e.fill.ratio < 0.15;   // outlined stroke saved as a filled ring
      if (!strokeOutline && !ring) continue;
      const b = e.bb, w = W_(b), h = H_(b);
      if (w < 30 * MM || w > 320 * MM || h < 40 * MM || h > 520 * MM) continue;
      if (Math.max(w, h) < 1.3 * Math.min(w, h)) continue;              // round guide circles are not sock outlines
      job.frameEls.add(e.i);
      if (rects.some(q => Math.abs(q[0] - b[0]) < 3 * MM && Math.abs(q[1] - b[1]) < 3 * MM && Math.abs(q[2] - b[2]) < 3 * MM && Math.abs(q[3] - b[3]) < 3 * MM)) { job.frameEls.add(e.i); continue; }
      const r = b.slice(); r.el = e.i; rects.push(r);
    }
    // outlines that cross each other are construction guides, not platens
    const ov = (p, q) => overlap(p[0], p[2], q[0], q[2]) > 1 && overlap(p[1], p[3], q[1], q[3]) > 1 && !inside(p, q, 0.5) && !inside(q, p, 0.5);
    for (let k = rects.length - 1; k >= 0; k--) if (rects[k].el != null && rects.some(q => q !== rects[k] && ov(rects[k], q))) rects.splice(k, 1);
    // frames must hold printable artwork
    let frames = rects.filter(f => job.els.some(e => !job.frameEls.has(e.i) && isInk(e, job) && !e.text && centreIn(e.bb, f) && inside(e.bb, f, 3 * MM)));
    // a rectangle that contains other frames is a page/artboard outline, not a platen
    // nesting: an outline around two or more frames is the page/artboard -> drop it;
    // a platen rectangle around a single sock outline -> keep the platen, drop the inner outline
    const kids = (f) => frames.filter(q => q !== f && inside(q, f, 0.5));
    frames = frames.filter(f => kids(f).length < 2);
    frames = frames.filter(f => !frames.some(q => q !== f && inside(f, q, 0.5) && kids(q).length === 1));
    frames.forEach(f => { if (f.el != null) job.frameEls.add(f.el); if (f.style) job.frameStyles.add(f.style); });
    return frames;
  }

  /* an element that could be printed: solid fill, a stroke thick enough to print, or text — never white */
  function isInk(e, job, thr) {
    const t = thr == null ? 0.4 * MM : thr;
    if (e.fill && !keyInfo(e.fill.key).white && !job.notArt.has(e.fill.key)) return true;
    if (e.stroke && e.stroke.lw >= t && !keyInfo(e.stroke.key).white && !job.notArt.has(e.stroke.key)) return true;
    return false;
  }

  /* =====================================================================
     DESIGNS
     Frames of the same size side by side make one design (left + right).
     Artwork = printable elements whose centre lies inside a frame.
     Anything outside the frames (notes, dimensions, sketches) is not artwork,
     and neither are hairlines inside a frame (guide circles, construction lines).
     ===================================================================== */
  const elById = (job, i) => (job._elBy || (job._elBy = new Map(job.els.map(e => [e.i, e])))).get(i);
  function designsFor(job, st) {
    const thr = 0.1 * MM;   // only lines too fine to print at all are ignored by weight
    if (st && st.nearWhite != null) setNearWhite(st.nearWhite);
    const sig = thr + '|' + nearWhitePct + '|' + (st && st.speckMm) + '|' + [...job.notArt].join(',') + '|' + [...job.excluded].join(',');
    if (job._d && job._d.sig === sig) return job._d;
    let frames = findFrames(job), framed = true;
    if (!frames.length) { frames = fallbackFrames(job, thr); framed = false; }
    // pair frames
    const pairs = [], used = new Set(), cand = [];
    for (let i = 0; i < frames.length; i++) for (let j = 0; j < frames.length; j++) {
      if (i === j) continue;
      const a = frames[i], b = frames[j];
      if (b[0] < a[2] - 1) continue;
      const sameSize = Math.abs(W_(a) - W_(b)) < 4 * MM && Math.abs(H_(a) - H_(b)) < 4 * MM;
      const level = overlap(a[1], a[3], b[1], b[3]) > 0.8 * H_(a);
      const g = b[0] - a[2];
      if (!sameSize || !level || g > Math.max(W_(a), 60 * MM) * 1.5) continue;
      cand.push({ i, j, g });
    }
    cand.sort((p, q) => p.g - q.g);
    for (const c of cand) {
      if (used.has(c.i) || used.has(c.j)) continue;
      const a = frames[c.i], b = frames[c.j];
      if (frames.some((o, k) => k !== c.i && k !== c.j && o[0] >= a[2] - 1 && o[2] <= b[0] + 1 && overlap(o[1], o[3], a[1], a[3]) > 0)) continue;
      used.add(c.i); used.add(c.j); pairs.push([a, b]);
    }
    frames.forEach((f, k) => { if (!used.has(k)) pairs.push([f]); });
    // order: top to bottom, then left to right
    pairs.sort((p, q) => { const dy = q[0][3] - p[0][3]; return Math.abs(dy) > 20 * MM ? dy : p[0][0] - q[0][0]; });

    /* Guide lines inside a frame are recognised by what they are, not how thick they are:
       - the frame outline itself (same line style as the frame, or the sock-shaped outline)
       - dashed lines
       - lines in a colour the file uses for notes/dimensions outside the frames, and never for solid artwork inside
       - large open outlines (stroke only, no fill) spanning most of the frame: guide circles, centre lines */
    const allFrames = pairs.flat();
    const inAny = (e) => allFrames.some(f => centreIn(e.bb, f));
    const noteColours = new Set(), artFillColours = new Set();
    for (const e of job.els) {
      if (job.frameEls && job.frameEls.has(e.i)) continue;
      if (!inAny(e)) { if (!e.text) { if (e.fill) noteColours.add(e.fill.key); if (e.stroke) noteColours.add(e.stroke.key); } }   // dimension lines, arrows, swatches
      else if (e.fill && !e.text && !keyInfo(e.fill.key).white) artFillColours.add(e.fill.key);
    }
    const guideColour = (k) => noteColours.has(k) && !artFillColours.has(k);
    const isGuideStroke = (e, fr) => {
      if (!e.stroke) return false;
      if (job.frameEls && job.frameEls.has(e.i)) return true;
      if (job.frameStyles && job.frameStyles.has(styleOf(e)) && !e.fill) return true;
      if (e.stroke.dash) return true;
      if (guideColour(e.stroke.key)) return true;
      if (e.stroke.lw < thr) return true;
      if (!e.fill) {
        const f = fr.find(f => centreIn(e.bb, f)) || fr[0];
        // sits on the frame edge (corner pieces, edge segments of the frame drawing)
        const t = 1.5 * MM, b = e.bb;
        const onEdge = (Math.abs(b[0] - f[0]) < t || Math.abs(b[2] - f[2]) < t || Math.abs(b[1] - f[1]) < t || Math.abs(b[3] - f[3]) < t) && (W_(b) < t || H_(b) < t || (W_(b) < 5 * MM && H_(b) < 5 * MM));
        if (onEdge) return true;
        // big closed outline with no fill (guide circle / ellipse); open lines are artwork unless another rule says guide
        if (e.stroke.closed && (W_(e.bb) >= 0.6 * W_(f) || H_(e.bb) >= 0.6 * H_(f))) return true;
      }
      return false;
    };

    const claimed = new Set(); let guideCount = 0, nearWhiteCount = 0, speckCount = 0;
    const speck = (st && st.speckMm != null ? Number(st.speckMm) : 0.2) * MM;
    const designs = pairs.map((fr, k) => {
      const art = [], knock = [];
      for (const e of job.els) {
        if (claimed.has(e.i)) continue;
        const inF = fr.some(f => centreIn(e.bb, f));
        if (!inF) continue;
        // specks: separate pieces smaller than the limit are leftovers from path editing, not artwork
        if (!e.text && (e.fill || e.stroke)) {
          const b = e.stroke ? e.stroke.bb : e.bb;
          if (Math.max(W_(b), H_(b)) < speck && (e.fill ? !keyInfo(e.fill.key).white : !keyInfo(e.stroke.key).white)) { speckCount++; continue; }
        }
        const guide = isGuideStroke(e, fr);
        if (guide && !e.fill) guideCount++;
        const fillInk = !(job.frameEls && job.frameEls.has(e.i)) && e.fill && !keyInfo(e.fill.key).white && !job.notArt.has(e.fill.key);
        const strokeInk = !guide && e.stroke && !keyInfo(e.stroke.key).white && !job.notArt.has(e.stroke.key);
        const fillWhite = e.fill && keyInfo(e.fill.key).white;
        if (fillInk || strokeInk) { art.push({ i: e.i, fill: fillInk ? e.fill.key : null, stroke: strokeInk ? e.stroke.key : null, bb: e.stroke && strokeInk ? e.stroke.bb : e.bb }); claimed.add(e.i); }
        else if (fillWhite) { knock.push(e.i); if (keyInfo(e.fill.key).nearWhite) nearWhiteCount++; }
      }
      const colours = new Map();
      art.forEach(a => [a.fill, a.stroke].forEach(c => { if (c) colours.set(c, (colours.get(c) || 0) + 1); }));
      const artBox = art.length ? art.map(a => a.bb).reduce(union) : null;
      return { index: k, frames: fr, art, knock: new Set(knock), colours: [...colours.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, n, ...keyInfo(key) })), artBox, off: job.excluded.has(k) };
    }).filter(d => d.art.length);
    designs.forEach((d, k) => { d.index = k; d.off = job.excluded.has(k); });

    // what was left out, for the preview
    const ignored = job.els.filter(e => isInk(e, job, thr) && !claimed.has(e.i) && !(job.frameEls && job.frameEls.has(e.i))).length;
    const guides = guideCount;
    const allColours = new Map();
    job.els.forEach(e => [e.fill && e.fill.key, e.stroke && e.stroke.key].forEach(c => { if (c && !keyInfo(c).white) allColours.set(c, (allColours.get(c) || 0) + 1); }));
    const artKeys = new Set(); designs.forEach(d => d.colours.forEach(c => artKeys.add(c.key)));
    const colourList = [...allColours.keys()].filter(k => artKeys.has(k) || job.notArt.has(k)).map(key => ({ key, ...keyInfo(key), art: artKeys.has(key) }));
    // tiny subpaths inside artwork paths (and lone move-to points) are dropped when the film is drawn
    let subSpecks = 0;
    designs.forEach(d => d.art.forEach(a => { const e = elById(job, a.i); if (e && e.subMm) subSpecks += e.subMm.filter(v => v < speck / MM).length; }));
    designs.forEach(d => { d.speckMm = speck / MM; });
    return (job._d = { sig, framed, designs, ignored, guides, nearWhite: nearWhiteCount, specks: speckCount + subSpecks, colours: colourList });
  }

  /* No platen frame in the file: group printable elements into blobs, pair blobs of equal size,
     and use each blob's box (plus 5 mm) as its frame. Hairlines never count. */
  function fallbackFrames(job, thr) {
    const bbs = job.els.filter(e => !(job.frameEls && job.frameEls.has(e.i))).filter(e => (e.fill && !keyInfo(e.fill.key).white && !e.text) || (e.stroke && e.stroke.lw >= thr && !keyInfo(e.stroke.key).white)).map(e => e.bb);
    if (!bbs.length) return [];
    const T = 10 * MM, par = bbs.map((_, i) => i);
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const idx = bbs.map((_, i) => i).sort((a, b) => bbs[a][0] - bbs[b][0]);
    for (let p = 0; p < idx.length; p++) for (let q = p + 1; q < idx.length; q++) {
      const a = bbs[idx[p]], b = bbs[idx[q]];
      if (b[0] - a[2] > T) break;
      if (Math.max(0, b[0] - a[2], a[0] - b[2]) <= T && Math.max(0, b[1] - a[3], a[1] - b[3]) <= T) par[find(idx[p])] = find(idx[q]);
    }
    const g = new Map(); bbs.forEach((b, i) => { const r = find(i); g.set(r, g.has(r) ? union(g.get(r), b) : b.slice()); });
    let cl = [...g.values()];
    for (let changed = true; changed;) {              // stacked parts of one panel
      changed = false;
      outer: for (let i = 0; i < cl.length; i++) for (let j = i + 1; j < cl.length; j++) {
        const a = cl[i], b = cl[j];
        if (overlap(a[0], a[2], b[0], b[2]) >= 0.5 * Math.min(W_(a), W_(b)) && Math.max(0, b[1] - a[3], a[1] - b[3]) <= 25 * MM) { cl[i] = union(a, b); cl.splice(j, 1); changed = true; break outer; }
      }
    }
    const maxA = Math.max(...cl.map(b => W_(b) * H_(b)));
    return cl.filter(b => W_(b) * H_(b) >= 0.12 * maxA).map(b => [b[0] - 5 * MM, b[1] - 5 * MM, b[2] + 5 * MM, b[3] + 5 * MM]);
  }

  /* =====================================================================
     FILM CONTENT for one design + one colour
     Only the design's own artwork is painted: target colour solid black,
     its other colours and white shapes inside the frame knock out (white),
     everything else is not painted at all. Clipped to the frames.
     ===================================================================== */
  const PAINT = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'S', 's', 'n']);
  const PATH = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h']);
  const COLOUR = new Set(['k', 'K', 'rg', 'RG', 'g', 'G', 'sc', 'SC', 'scn', 'SCN', 'cs', 'CS']);
  const TEXT_OPS = new Set(['Tj', 'TJ', "'", '"']);
  /* grow (offset) the artwork by r points to compensate stencil undercut on thick emulsion:
     every artwork edge gets a round-joined black stroke 2r wide, so shapes grow by r on every side
     and holes / white knock-outs shrink by r. */
  function rewrite(job, d, st) {
    const role = new Map(); d.art.forEach(a => role.set(a.i, a));
    const elBy = job._elBy || (job._elBy = new Map(job.els.map(e => [e.i, e])));
    const r = Math.max(0, (st && st.offsetUm || 0) / 1000 * MM);
    const out = []; let pathStart = -1, clipInPath = false, pathOps = [];
    const f = (v) => v.toFixed(3);
    out.push('q');
    d.frames.forEach(fr => out.push(`${f(fr[0])} ${f(fr[1])} ${f(W_(fr))} ${f(H_(fr))} re`));
    out.push('W n');
    let depth = 0;
    for (let i = 0; i < job.ops.length; i++) {
      const o = job.ops[i];
      if (COLOUR.has(o.op) || o.op === 'sh' || o.op === 'BI' || o.op === 'Do') continue;
      if (o.op === 'q') depth++;
      if (o.op === 'Q') { if (depth === 0) continue; depth--; }
      if (PATH.has(o.op) && pathStart < 0) { pathStart = out.length; clipInPath = false; pathOps = []; }
      if (PATH.has(o.op)) pathOps.push(o);
      if (o.op === 'W' || o.op === 'W*') clipInPath = true;
      if (PAINT.has(o.op)) {
        const a = role.get(i), e = elBy.get(i);
        const hasSpecks = a && e && e.subMm && e.subMm.some(v => v < (d.speckMm || 0));
        const outline = r > 0 && a && a.fill && !a.stroke;   // a filled shape that gets the compensation outline
        if ((hasSpecks || outline) && pathStart >= 0 && !clipInPath) {
          // rebuild the path: drop speck subpaths (and lone move-tos); close every subpath so the outline has no gaps
          const keep = []; let n = -1, open = false;
          const closeIt = () => { if (outline && open) keep.push('h'); open = false; };
          for (const po of pathOps) {
            if (po.op === 'm' || po.op === 're') { closeIt(); n++; }
            const drop = hasSpecks && n >= 0 && e.subMm[n] != null && e.subMm[n] < d.speckMm;
            if (drop) continue;
            keep.push(po.args.map(x => x.raw).concat(po.op).join(' '));
            open = po.op !== 'h' && po.op !== 're';
          }
          closeIt();
          out.splice(pathStart, out.length - pathStart, ...keep);
        }
        let fillMode = 'drop', strokeMode = 'drop';
        if (a) { if (a.fill) fillMode = 'ink'; if (a.stroke) strokeMode = 'ink'; }
        else if (d.knock.has(i)) fillMode = 'knock';
        const op = o.op, star = op.indexOf('*') >= 0, close = op === 's' || op[0] === 'b';
        const hasFill = op !== 'S' && op !== 's' && op !== 'n', hasStroke = /^[SsBb]/.test(op);
        const F = hasFill && fillMode !== 'drop';
        let T = hasStroke && strokeMode !== 'drop';
        let pre = '', paint;
        if (F) pre += fillMode === 'ink' ? '0 0 0 1 k ' : '0 0 0 0 k ';
        if (r > 0 && (F || T) && e) {
          const sc = e.s || 1, grow = 2 * r / sc;
          if (T) { pre += `0 0 0 1 K ${f((e.stroke.lwUser || 0) + grow)} w 1 j `; }   // keep the line's own end caps
          else { pre += `0 0 0 1 K ${f(grow)} w 1 j 0 J [] 0 d `; }   // outline the filled shape (black grows, white shrinks)
          paint = F ? (star ? 'b*' : 'b') : (close ? 's' : 'S');
          if (F && T) paint = close ? (star ? 'b*' : 'b') : (star ? 'B*' : 'B');
          if (!T && F && !close) paint = star ? 'b*' : 'b';
          T = true;
        } else {
          if (T) pre += '0 0 0 1 K ';
          paint = F && T ? op : F ? (close ? 'h ' : '') + (star ? 'f*' : 'f') : T ? (close ? 's' : 'S') : (op === 's' || op === 'b' || op === 'b*' ? 'h n' : 'n');
        }
        const wrap = r > 0 && (F || T) && !clipInPath && pathStart >= 0;
        if (pre && pathStart >= 0) out.splice(pathStart, 0, (wrap ? 'q ' : '') + pre.trim());
        out.push(paint + (wrap ? ' Q' : ''));
        pathStart = -1; continue;
      }
      if (TEXT_OPS.has(o.op)) {
        const a = role.get(i), e = elBy.get(i);
        if (a && a.fill) {
          if (r > 0) out.push(`0 0 0 1 k 0 0 0 1 K 2 Tr ${f(2 * r / ((e && e.s) || 1))} w 1 j`);
          else out.push('0 0 0 1 k');
          out.push(o.args.map(x => x.raw).concat(o.op).join(' '));
        }
        else if (o.op === "'") out.push('T*');
        else if (o.op === '"') out.push(o.args[0].raw + ' Tw ' + o.args[1].raw + ' Tc T*');
        continue;
      }
      out.push(o.args.map(x => x.raw).concat(o.op).join(' '));
    }
    while (depth-- > 0) out.push('Q');
    out.push('Q');
    return out.join('\n') + '\n';
  }

  /* marks: three faint crosses (top, middle, bottom) on the centre line between the two frames */
  function markLayout(d, st) {
    const L = st.markArm * MM, fr = d.frames, all = fr.reduce(union);
    const cx = fr.length === 2 ? (fr[0][2] + fr[1][0]) / 2 : all[0] - 8 * MM - L;
    return { L, cx, pts: [all[3] - L, (all[1] + all[3]) / 2, all[1] + L].map(y => [cx, y]) };
  }
  function markOps(layout, grey, lw) {
    const { L } = layout, f = (v) => v.toFixed(2);
    let s = `q 0 0 0 ${grey} K ${lw} w [] 0 d 0 J\n`;
    for (const [x, y] of layout.pts) s += `${f(x - L)} ${f(y)} m ${f(x + L)} ${f(y)} l S ${f(x)} ${f(y - L)} m ${f(x)} ${f(y + L)} l S\n`;
    return s + 'Q\n';
  }

  /* blocks: one per design (single-colour printing: every artwork colour becomes black), sized to the frames + marks + file name */
  const LABEL_PT = 10.5, LABEL_GAP = 10 * MM;   // text top sits 10 mm below the lowest cross
  /* edge compensation for a design: auto = stencil thickness x factor, manual = given value, none = 0 (all in microns) */
  function compensation(ds, st) {
    ds = ds || {};
    if (ds.mode === 'none') return 0;
    if (ds.mode === 'manual') return Math.max(0, +ds.manualUm || 0);
    return Math.max(0, Math.round((+ds.thick || 0) * (st.autoFactor != null ? st.autoFactor : 0.5)));
  }
  function labelLines(job, d, nDesigns, ds, um, st) {
    let base = job.name.replace(/\.(ai|pdf)$/i, '') + (nDesigns > 1 ? ` #${d.index + 1}` : '');
    if (base.length > 70) base = base.slice(0, 67) + '…';
    const comp = !ds || ds.mode === 'none' || um === 0 ? 'ไม่ชดเชยขอบ'
      : `ชดเชยขอบ +${um} µm` + (ds.mode === 'manual' ? ' (ระบุเอง)' : ' (อัตโนมัติ)');
    const line1 = `${(ds && ds.customer) || 'ไม่ระบุลูกค้า'} - ${base}`;
    const line2 = [ds && ds.thick ? `บล็อก ${ds.thick} µm` : null, comp, st.dateText || new Date().toLocaleDateString('en-GB')].filter(Boolean).join('  ·  ');
    return [line1, line2];
  }
  function blocksFor(job, st) {
    const r = designsFor(job, st), out = [];
    for (const d of r.designs) {
      if (d.off) continue;
      const ds = job.dset && job.dset[d.index];
      const um = compensation(ds, st);
      const lay = markLayout(d, st), marks = markOps(lay, st.markGrey / 100, st.markWidthMm != null ? st.markWidthMm * MM : (st.markWidth || 0.4));
      const all = d.frames.reduce(union);
      let b = union(all, [lay.cx - lay.L, all[1], lay.cx + lay.L, all[3]]);
      let label = null;
      const lines = labelLines(job, d, r.designs.length, ds, um, st);
      if (st.labels) {
        const lx = d.frames.length === 2 ? lay.cx : (all[0] + all[2]) / 2;
        const lead = LABEL_PT * 1.35;
        const ws = lines.map(t => st.measureText ? st.measureText(t, LABEL_PT) : t.length * LABEL_PT * 0.55);
        const lw = Math.max(...ws);
        label = { lines, x: lx, y: lay.pts[2][1] - lay.L - LABEL_GAP - LABEL_PT * 0.8, lead, size: LABEL_PT };   // lowest cross bottom - 10 mm - cap height
        b = union(b, [lx - lw / 2, label.y - (lines.length - 1) * lead - 3 * MM, lx + lw / 2, all[1]]);
      }
      const pad = 1 * MM;
      out.push({ job, design: d, offsetUm: um, content: rewrite(job, d, { ...st, offsetUm: um }) + marks, bbox: [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad], label, name: lines.join(' / ') });
    }
    return out;
  }
  function describe(job, st) {
    const r = designsFor(job, st);
    return {
      framed: r.framed, ignored: r.ignored, guides: r.guides, nearWhite: r.nearWhite, specks: r.specks, colours: r.colours,
      designs: r.designs.map(d => ({
        index: d.index, off: d.off, colours: d.colours,
        frames: d.frames.map(f => ({ w: W_(f) / MM, h: H_(f) / MM, cx: (f[0] + f[2]) / 2 / MM })),
        art: d.artBox && { w: W_(d.artBox) / MM, h: H_(d.artBox) / MM },
        centreDistance: d.frames.length === 2 ? ((d.frames[1][0] + d.frames[1][2]) - (d.frames[0][0] + d.frames[0][2])) / 2 / MM : null,
        boxes: d.frames, artBox: d.artBox
      }))
    };
  }

  /* ---------- packing (shelf, tallest first; rotate only when a block is too wide) ---------- */
  function pack(blocks, st) {
    const W = st.sheetW * 72, H = st.sheetH * 72, M = st.margin * MM, G = st.gap * MM;
    const items = blocks.map((b, i) => { const w = b.bbox[2] - b.bbox[0], h = b.bbox[3] - b.bbox[1];
      const rot = w > W - 2 * M && h <= W - 2 * M; return { b, i, w, h, rot, W: rot ? h : w, H: rot ? w : h }; });
    const tooBig = items.filter(it => it.W > W - 2 * M || it.H > H - 2 * M);
    const fit = items.filter(it => !tooBig.includes(it)).sort((a, b) => b.H - a.H || a.i - b.i);
    const sheets = []; let sheet = null, x = 0, ytop = 0, shelf = 0;
    const newSheet = () => { sheet = []; sheets.push(sheet); x = M; ytop = H - M; shelf = 0; };
    newSheet();
    for (const it of fit) {
      if (x + it.W > W - M) { x = M; ytop -= shelf + G; shelf = 0; }
      if (ytop - it.H < M) newSheet();
      it.x = x; it.y = ytop - it.H; sheet.push(it); x += it.W + G; shelf = Math.max(shelf, it.H);
    }
    return { sheets: sheets.filter(s => s.length), tooBig, W, H };
  }

  /* ---------- output PDF ---------- */
  function asciiLabel(s, fallback) { const t = s.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim(); return t || fallback; }
  async function render(blocks, st) {
    const plan = pack(blocks, st);
    const out = await PDFDocument.create();
    out.setTitle('Film positive ' + new Date().toISOString().slice(0, 10)); out.setCreator('Film positive tool');
    const font = await out.embedFont(StandardFonts.Helvetica);
    const lk = st.labelGrey / 100;
    for (const sheet of plan.sheets) {
      const pg = out.addPage([plan.W, plan.H]);
      for (const it of sheet) {
        const b = it.b;
        const src = await PDFDocument.load(b.job.bytes, { ignoreEncryption: true, updateMetadata: false });
        const p = src.getPage(b.job.page || 0);
        // reuse the page's own content-stream object number (new numbers can collide in files with object streams)
        const stream = src.context.flateStream(fromLatin1(b.content));
        let cref = p.node.get(PDFName.of('Contents'));
        if (cref instanceof PDFArray) cref = cref.get(0);
        if (cref && cref.objectNumber != null) { src.context.assign(cref, stream); p.node.set(PDFName.of('Contents'), cref); }
        else p.node.set(PDFName.of('Contents'), src.context.register(stream));
        const emb = await out.embedPage(p, { left: b.bbox[0], bottom: b.bbox[1], right: b.bbox[2], top: b.bbox[3] });
        const map = it.rot ? (x, y) => ({ x: it.x + it.h - (y - b.bbox[1]), y: it.y + (x - b.bbox[0]) })
                           : (x, y) => ({ x: it.x + (x - b.bbox[0]), y: it.y + (y - b.bbox[1]) });
        if (it.rot) pg.drawPage(emb, { x: it.x + it.h, y: it.y, rotate: degrees(90) });
        else pg.drawPage(emb, { x: it.x, y: it.y });
        if (b.label) {
          const lb = b.label;
          for (let k = 0; k < lb.lines.length; k++) {
            const text = lb.lines[k], ly = lb.y - k * lb.lead;
            const img = st.labelImage ? await st.labelImage(text, lb.size, lk) : null;
            if (img) {
              const im = await out.embedPng(img.png);
              if (it.rot) { const o = map(lb.x, ly); pg.drawImage(im, { x: o.x + img.h * 0.25, y: o.y - img.w / 2, width: img.w, height: img.h, rotate: degrees(90) }); }
              else { const o = map(lb.x - img.w / 2, ly); pg.drawImage(im, { x: o.x, y: o.y - img.h * 0.25, width: img.w, height: img.h }); }
            } else {
              const t = asciiLabel(text, 'job ' + (it.i + 1)), w = font.widthOfTextAtSize(t, lb.size);
              if (it.rot) { const o = map(lb.x, ly); pg.drawText(t, { x: o.x, y: o.y - w / 2, size: lb.size, font, color: cmyk(0, 0, 0, lk), rotate: degrees(90) }); }
              else { const o = map(lb.x - w / 2, ly); pg.drawText(t, { x: o.x, y: o.y, size: lb.size, font, color: cmyk(0, 0, 0, lk) }); }
            }
          }
        }
        if (st.cropMarks) {
          const x0 = it.x, y0 = it.y, x1 = it.x + it.W, y1 = it.y + it.H, o = 2 * MM, l = 4 * MM, c = cmyk(0, 0, 0, 1);
          for (const [cx, cy, sx, sy] of [[x0, y0, -1, -1], [x1, y0, 1, -1], [x0, y1, -1, 1], [x1, y1, 1, 1]]) {
            pg.drawLine({ start: { x: cx + sx * o, y: cy }, end: { x: cx + sx * (o + l), y: cy }, thickness: 0.3, color: c });
            pg.drawLine({ start: { x: cx, y: cy + sy * o }, end: { x: cx, y: cy + sy * (o + l) }, thickness: 0.3, color: c });
          }
        }
      }
    }
    return { bytes: await out.save(), plan };
  }

  /* ---------- built-in demo: one file, two designs, notes and guides around them ---------- */
  async function makeSample() {
    const d = await PDFDocument.create(); const p = d.addPage([1000, 760]);
    const font = await d.embedFont(StandardFonts.Helvetica);
    const green = cmyk(0.75, 0.05, 0.9, 0.05), purple = cmyk(0.6, 0.9, 0, 0), red = cmyk(0, 1, 1, 0), grey = cmyk(0, 0, 0, 0.3), black = cmyk(0, 0, 0, 1);
    const frame = (x0, y0, w, h) => p.drawRectangle({ x: x0, y: y0, width: w, height: h, borderColor: grey, borderWidth: 0.5, borderDashArray: [3, 3] });
    const pairAt = (ox, oy, fw, fh, kind) => {
      [0, 1].forEach(k => {
        const x0 = ox + k * (fw + 35 * MM), y0 = oy, cx = x0 + fw / 2;
        frame(x0, y0, fw, fh);
        for (let r = 0; r * 13 * MM < fh - 20 * MM; r++) for (let c = 0; c * 12 * MM < fw - 22 * MM; c++) {
          const x = x0 + 13 * MM + c * 12 * MM + (r % 2 ? 6 * MM : 0), y = y0 + 12 * MM + r * 13 * MM;
          if (x > x0 + fw - 10 * MM) continue;
          if (kind) p.drawRectangle({ x: x - 3.5 * MM, y: y - 3.5 * MM, width: 7 * MM, height: 7 * MM, color: purple });
          else p.drawEllipse({ x, y, xScale: 3.5 * MM, yScale: 4.5 * MM, color: green });
        }
        p.drawCircle({ x: cx, y: y0 + fh - fw / 2, size: fw / 2, borderColor: red, borderWidth: 0.6 });   // guide inside the frame
        p.drawLine({ start: { x: x0, y: y0 + fh + 12 }, end: { x: x0 + fw, y: y0 + fh + 12 }, thickness: 0.5, color: red });
        p.drawText(`${Math.round(fw / MM / 10)} cm`, { x: cx - 8, y: y0 + fh + 16, size: 7, font, color: black });
      });
      p.drawText(`${Math.round(fh / MM / 10)} cm`, { x: ox - 30, y: oy + fh / 2, size: 8, font, color: black });
    };
    pairAt(60, 60, 80 * MM, 190 * MM, 0);
    pairAt(60 + 2 * 80 * MM + 35 * MM + 30 * MM, 60 + 40 * MM, 70 * MM, 150 * MM, 1);
    // a sample colour patch outside the frames, as customers often add
    p.drawRectangle({ x: 920, y: 680, width: 12 * MM, height: 12 * MM, color: green });
    p.drawText('PANTONE 361C', { x: 870, y: 665, size: 7, font, color: black });
    return d.save();
  }

  return { compensation, makeSample, pageCount, analyze, designsFor, blocksFor, describe, pack, render, keyInfo, MM, _tokenize: tokenize };
});

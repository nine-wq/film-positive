// Cloudflare Worker: API ของแอปฟิล์มบล็อคสกรีน
// หน้าเว็บ (public/) ถูกเสิร์ฟอัตโนมัติ ส่วน /api/* มาที่โค้ดนี้
//
// ใช้ฐานข้อมูล D1 และ R2 ตัวเดียวกับแอปบันทึกขึ้นบล็อค (stencil-db, stencil-files):
//   - อ่านอย่างเดียว: settings.key = 'master'  -> รายชื่อลูกค้า + ความหนาที่ลูกค้าต้องการ (customerSpecs[ชื่อ].target)
//   - อ่าน/เขียน:   settings.key = 'film'    -> การตั้งค่าของแอปฟิล์ม (ใช้ร่วมกันทุกเครื่อง)
//   - อ่าน/เขียน:   ตาราง film_outputs + R2 key 'film/<id>.pdf' -> ประวัติฟิล์ม PDF ที่บันทึก
// ไม่แตะข้อมูลอื่นของ stencil-log

const json = (d, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const MAX_PDF = 60 * 1024 * 1024;   // 60 MB ต่อไฟล์

// ค่าที่แอปฟิล์มรับ (ค่าอื่นในคำขอถูกทิ้ง)
const NUM_KEYS = ['sheetW', 'sheetH', 'margin', 'gap', 'markArm', 'markGrey', 'markWidthMm', 'labelGrey', 'defaultThick', 'factor'];
const BOOL_KEYS = ['labels', 'cropMarks'];

function clean(input) {
  const out = {};
  for (const k of NUM_KEYS) { const v = Number(input[k]); if (Number.isFinite(v) && v >= 0 && v <= 100000) out[k] = v; }
  for (const k of BOOL_KEYS) if (typeof input[k] === 'boolean') out[k] = input[k];
  if (Array.isArray(input.thicknesses)) out.thicknesses = [...new Set(input.thicknesses.map(Number).filter(v => Number.isFinite(v) && v >= 0 && v <= 100000))].sort((a, b) => a - b).slice(0, 50);
  return out;
}

async function getSetting(env, key) {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  if (!r) return null;
  try { return JSON.parse(r.value); } catch { return null; }
}

function customersFrom(master) {
  if (!master || !Array.isArray(master.customers)) return [];
  const specs = master.customerSpecs || {};
  return master.customers.map(name => {
    const t = Number(specs[name] && specs[name].target);
    return { name, thick: Number.isFinite(t) && t > 0 ? t : null };
  });
}

// ตารางของแอปฟิล์มเอง (สร้างเฉพาะเมื่อยังไม่มี รันซ้ำได้ปลอดภัย)
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL )',
  'CREATE TABLE IF NOT EXISTS film_outputs ( id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL, size INTEGER NOT NULL, info TEXT NOT NULL )',
  'CREATE INDEX IF NOT EXISTS film_outputs_created ON film_outputs(created)'
];
let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) schemaReady = env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))).catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
function safeName(s) {
  const n = String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim().slice(0, 180);
  return /\.pdf$/i.test(n) ? n : (n || 'film') + '.pdf';
}
function cleanInfo(raw) {
  let o = {};
  try { o = JSON.parse(raw || '{}'); } catch { o = {}; }
  const str = (v, n = 200) => String(v == null ? '' : v).slice(0, n);
  const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const items = Array.isArray(o.items) ? o.items.slice(0, 200).map(it => ({
    file: str(it.file), customer: str(it.customer, 100), thick: num(it.thick), compUm: num(it.compUm), mode: str(it.mode, 10)
  })) : [];
  return { sheets: num(o.sheets), blocks: num(o.blocks), sheetW: num(o.sheetW), sheetH: num(o.sheetH), date: str(o.date, 20), items };
}
function contentDisposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (!env.DB) return json({ error: 'no_db', message: 'ยังไม่ได้เชื่อมฐานข้อมูล stencil-db (binding DB)' }, 503);
    try {
      await ensureSchema(env);
      return await api(req, env, url);
    } catch (e) {
      return json({ error: 'server', detail: String(e && e.message || e) }, 500);
    }
  }
};

async function api(req, env, url) {
  const p = url.pathname.slice(4); // ตัด "/api"
  const m = req.method;

  // ---------- การตั้งค่า ----------
  if (p === '/settings') {
    if (m === 'GET') {
      const [film, master] = await Promise.all([getSetting(env, 'film'), getSetting(env, 'master')]);
      return json({ film: film || null, customers: customersFrom(master), features: { history: !!env.FILES } });
    }
    if (m === 'PUT') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
      const cur = await getSetting(env, 'film');
      // ป้องกันเขียนทับการแก้ไขของเครื่องอื่นที่บันทึกก่อนหน้า
      if (cur && cur.updated && body.baseUpdated && Number(body.baseUpdated) < cur.updated)
        return json({ error: 'conflict', film: cur }, 409);
      const film = { ...(cur || {}), ...clean(body.film || {}), updated: Date.now() };
      await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind('film', JSON.stringify(film)).run();
      return json({ film });
    }
    return json({ error: 'method' }, 405);
  }

  // ---------- ประวัติฟิล์ม PDF ----------
  if (p === '/films' || p.startsWith('/films/')) {
    if (!env.FILES) return json({ error: 'no_r2', message: 'ยังไม่ได้เชื่อม R2 (binding FILES)' }, 503);

    if (p === '/films' && m === 'POST') {
      // multipart form: name, info (JSON), file (PDF)
      const len = Number(req.headers.get('content-length') || 0);
      if (len > MAX_PDF + 200000) return json({ error: 'too_large' }, 413);
      let form;
      try { form = await req.formData(); } catch { return json({ error: 'bad_form' }, 400); }
      const file = form.get('file');
      if (!file || typeof file === 'string') return json({ error: 'no_file' }, 400);
      const buf = await file.arrayBuffer();
      if (!buf.byteLength) return json({ error: 'empty' }, 400);
      if (buf.byteLength > MAX_PDF) return json({ error: 'too_large' }, 413);
      const head = new Uint8Array(buf, 0, Math.min(5, buf.byteLength));
      if (String.fromCharCode(...head) !== '%PDF-') return json({ error: 'not_pdf' }, 400);
      const name = safeName(form.get('name'));
      const info = cleanInfo(form.get('info'));
      const id = uid(), created = Date.now();
      await env.FILES.put(`film/${id}.pdf`, buf, { httpMetadata: { contentType: 'application/pdf' }, customMetadata: { name } });
      await env.DB.prepare('INSERT INTO film_outputs (id, name, created, size, info) VALUES (?, ?, ?, ?, ?)')
        .bind(id, name, created, buf.byteLength, JSON.stringify(info)).run();
      return json({ id, name, created, size: buf.byteLength, info }, 201);
    }

    if (p === '/films' && m === 'GET') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
      const before = Number(url.searchParams.get('before')) || 9e15;
      const r = await env.DB.prepare('SELECT id, name, created, size, info FROM film_outputs WHERE created < ? ORDER BY created DESC LIMIT ?')
        .bind(before, limit + 1).all();
      const rows = r.results.slice(0, limit).map(x => ({ id: x.id, name: x.name, created: x.created, size: x.size, info: JSON.parse(x.info || '{}') }));
      return json({ items: rows, more: r.results.length > limit });
    }

    const mm = p.match(/^\/films\/([a-f0-9]{16})$/);
    if (mm) {
      const id = mm[1];
      const row = await env.DB.prepare('SELECT id, name FROM film_outputs WHERE id = ?').bind(id).first();
      if (!row) return json({ error: 'not_found' }, 404);
      if (m === 'GET') {
        const obj = await env.FILES.get(`film/${id}.pdf`);
        if (!obj) return json({ error: 'file_missing' }, 404);
        const kind = url.searchParams.get('dl') ? 'attachment' : 'inline';
        return new Response(obj.body, { headers: {
          'content-type': 'application/pdf', 'content-length': String(obj.size),
          'content-disposition': contentDisposition(kind, row.name), 'cache-control': 'private, max-age=3600' } });
      }
      if (m === 'DELETE') {
        await env.FILES.delete(`film/${id}.pdf`);
        await env.DB.prepare('DELETE FROM film_outputs WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }
      return json({ error: 'method' }, 405);
    }
  }

  return json({ error: 'not_found' }, 404);
}

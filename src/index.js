// Cloudflare Worker: API ของแอปฟิล์มบล็อคสกรีน
// หน้าเว็บ (public/) ถูกเสิร์ฟอัตโนมัติ ส่วน /api/* มาที่โค้ดนี้
//
// ใช้ฐานข้อมูล D1 ตัวเดียวกับแอปบันทึกขึ้นบล็อค (stencil-db):
//   - อ่านอย่างเดียว: settings.key = 'master'  -> รายชื่อลูกค้า + ความหนาที่ลูกค้าต้องการ (customerSpecs[ชื่อ].target)
//   - อ่าน/เขียน:   settings.key = 'film'    -> การตั้งค่าของแอปฟิล์ม (ใช้ร่วมกันทุกเครื่อง)
// ไม่แตะข้อมูลอื่นของ stencil-log

const json = (d, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

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

let tableReady = null;
function ensureTable(env) {
  // ตารางเดียวกับของ stencil-log (สร้างเฉพาะเมื่อยังไม่มี)
  if (!tableReady) tableReady = env.DB.prepare('CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL )').run().catch(e => { tableReady = null; throw e; });
  return tableReady;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (!env.DB) return json({ error: 'no_db', message: 'ยังไม่ได้เชื่อมฐานข้อมูล stencil-db (binding DB)' }, 503);
    try {
      await ensureTable(env);
      if (url.pathname === '/api/settings') {
        if (req.method === 'GET') {
          const [film, master] = await Promise.all([getSetting(env, 'film'), getSetting(env, 'master')]);
          return json({ film: film || null, customers: customersFrom(master) });
        }
        if (req.method === 'PUT') {
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
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      return json({ error: 'server', detail: String(e && e.message || e) }, 500);
    }
  }
};

// สำรองไฟล์ต้นฉบับของลูกค้าขึ้น Google Drive ด้วย service account
//
// ตั้งค่าใน Cloudflare (Workers → film-positive → Settings → Variables and Secrets) เป็นชนิด Secret:
//   GDRIVE_SA_KEY    = เนื้อหาไฟล์ JSON ของ service account ทั้งไฟล์
//   GDRIVE_FOLDER_ID = ID ของโฟลเดอร์ปลายทาง (ใน Shared drive ที่เพิ่ม service account เป็นสมาชิกแล้ว)
// ไฟล์ถูกเก็บเป็น <โฟลเดอร์>/<ปี-เดือน>/<ชื่อไฟล์เดิม> ไฟล์ที่เนื้อหาเหมือนกัน (sha256 เดียวกัน) จะไม่อัปโหลดซ้ำ

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com';
const FOLDER = 'application/vnd.google-apps.folder';

export const driveReady = (env) => !!(env.GDRIVE_SA_KEY && env.GDRIVE_FOLDER_ID);

const b64url = (bytes) => {
  let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));

let cached = null;   // { token, exp } ต่อ isolate
let keyCache = null; // { raw, key, email }

function serviceAccount(env) {
  let sa;
  try { sa = JSON.parse(env.GDRIVE_SA_KEY); } catch { throw new DriveError('bad_key', 'GDRIVE_SA_KEY ไม่ใช่ JSON ของ service account'); }
  if (!sa.client_email || !sa.private_key) throw new DriveError('bad_key', 'GDRIVE_SA_KEY ไม่มี client_email หรือ private_key');
  return sa;
}

export class DriveError extends Error {
  constructor(code, message, status = 502) { super(message); this.code = code; this.status = status; }
}

async function signingKey(env) {
  if (keyCache && keyCache.raw === env.GDRIVE_SA_KEY) return keyCache;
  const sa = serviceAccount(env);
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  keyCache = { raw: env.GDRIVE_SA_KEY, key, email: sa.client_email };
  return keyCache;
}

export async function accessToken(env) {
  if (cached && cached.raw === env.GDRIVE_SA_KEY && cached.exp > Date.now() + 120000) return cached.token;
  const { key, email } = await signingKey(env);
  const now = Math.floor(Date.now() / 1000);
  const tokenUrl = env.GDRIVE_TOKEN_URL || TOKEN_URL;
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' +
    enc({ iss: email, scope: 'https://www.googleapis.com/auth/drive', aud: TOKEN_URL, iat: now, exp: now + 3600 });
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const r = await fetch(tokenUrl, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + unsigned + '.' + b64url(sig)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new DriveError('auth', 'Google ไม่ยอมรับ service account: ' + (d.error_description || d.error || r.status));
  cached = { raw: env.GDRIVE_SA_KEY, token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return cached.token;
}

async function gapi(env, path, opts = {}) {
  const token = await accessToken(env);
  const r = await fetch((env.GDRIVE_API || API) + path, { ...opts, headers: { authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  return r;
}
async function gjson(env, path, opts) {
  const r = await gapi(env, path, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (d.error && d.error.message) || r.status;
    throw new DriveError(r.status === 404 ? 'folder' : 'drive', 'Google Drive: ' + msg);
  }
  return d;
}
const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const LIST = '&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives';

// ตรวจว่าเข้าโฟลเดอร์ปลายทางได้ (ใช้ในหน้าตั้งค่า)
export async function checkDrive(env) {
  const f = await gjson(env, `/drive/v3/files/${encodeURIComponent(env.GDRIVE_FOLDER_ID)}?supportsAllDrives=true&fields=id,name,mimeType,driveId,capabilities(canAddChildren)`);
  if (f.mimeType !== FOLDER) throw new DriveError('folder', 'GDRIVE_FOLDER_ID ไม่ใช่โฟลเดอร์');
  if (f.capabilities && f.capabilities.canAddChildren === false) throw new DriveError('folder', 'service account ไม่มีสิทธิ์เพิ่มไฟล์ในโฟลเดอร์นี้ (ต้องเป็น Content manager)');
  const { email } = await signingKey(env);
  return { folder: f.name, sharedDrive: !!f.driveId, account: email };
}

const folderCache = new Map();
async function monthFolder(env, ym) {
  const k = env.GDRIVE_FOLDER_ID + '/' + ym;
  if (folderCache.has(k)) return folderCache.get(k);
  const found = await gjson(env, '/drive/v3/files?fields=files(id)&pageSize=1' + LIST + '&q=' +
    encodeURIComponent(`name='${q(ym)}' and '${q(env.GDRIVE_FOLDER_ID)}' in parents and mimeType='${FOLDER}' and trashed=false`));
  let id = found.files && found.files[0] && found.files[0].id;
  if (!id) {
    const made = await gjson(env, '/drive/v3/files?supportsAllDrives=true&fields=id', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: ym, mimeType: FOLDER, parents: [env.GDRIVE_FOLDER_ID] })
    });
    id = made.id;
  }
  folderCache.set(k, id);
  return id;
}

// อัปโหลดไฟล์ (body เป็นสตรีม) ถ้ามีไฟล์ sha256 เดียวกันอยู่แล้วจะคืนไฟล์เดิม
export async function uploadOriginal(env, { name, sha, size, type, body, props }) {
  if (/^[a-f0-9]{64}$/.test(sha)) {
    const dup = await gjson(env, '/drive/v3/files?fields=files(id,name,webViewLink)&pageSize=1' + LIST + '&q=' +
      encodeURIComponent(`appProperties has { key='sha256' and value='${sha}' } and trashed=false`));
    if (dup.files && dup.files[0]) return { id: dup.files[0].id, link: dup.files[0].webViewLink, name: dup.files[0].name, reused: true };
  }
  const d = new Date(Date.now() + 7 * 3600e3);   // เวลาไทย
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const parent = await monthFolder(env, ym);
  const start = await gapi(env, '/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': type, 'x-upload-content-length': String(size) },
    body: JSON.stringify({ name, parents: [parent], appProperties: { sha256: sha, ...props } })
  });
  const loc = start.headers.get('location');
  if (!start.ok || !loc) { const e = await start.json().catch(() => ({})); throw new DriveError('drive', 'Google Drive: ' + ((e.error && e.error.message) || start.status)); }
  const put = await fetch(loc, { method: 'PUT', headers: { 'content-type': type, 'content-length': String(size) }, body });
  const f = await put.json().catch(() => ({}));
  if (!put.ok || !f.id) throw new DriveError('drive', 'อัปโหลดขึ้น Google Drive ไม่สำเร็จ: ' + ((f.error && f.error.message) || put.status));
  return { id: f.id, link: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`, name: f.name, reused: false };
}

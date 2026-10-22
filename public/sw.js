// Service worker: makes the app installable, keeps the app shell for offline start,
// and receives files shared from other apps (manifest share_target → POST ./share-target).
const SHELL = 'film-shell-v1';
const ASSETS = ['./', 'js/film-core.js', 'vendor/pdf-lib.min.js', 'vendor/jszip.min.js', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js',
  'favicon.svg', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).catch(() => {}));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('film-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) { e.respondWith(takeShare(req)); return; }
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return;   // data always from the server
  // network first (always the newest app), the stored copy only when offline
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') { const c = await caches.open(SHELL); c.put(req.mode === 'navigate' ? './' : req, res.clone()); }
      return res;
    } catch (err) {
      const hit = await caches.match(req.mode === 'navigate' ? './' : req, { ignoreSearch: req.mode === 'navigate' });
      if (hit) return hit;
      throw err;
    }
  })());
});

async function takeShare(req) {
  let n = 0;
  try {
    const form = await req.formData();
    const cache = await caches.open('film-share');
    for (const k of await cache.keys()) await cache.delete(k);
    for (const f of form.getAll('file')) {
      if (!f || typeof f === 'string' || !f.size) continue;
      await cache.put(`./__shared/${Date.now()}-${n++}`, new Response(f, { headers: { 'x-name': encodeURIComponent(f.name || 'shared') } }));
    }
  } catch (e) {}
  return Response.redirect(`./?share=${n ? Date.now() : 'none'}`, 303);
}

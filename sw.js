// Guarda o app no aparelho pra funcionar sem internet.
const VERSION = 'folha-v9';
const PREFS = 'folha-prefs';   // metas que o lembrete lê
const CORE = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icon-180.png',
  'icon-512.png',
  'lib/pdf.min.js',
  'lib/pdf.worker.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== PREFS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  // Páginas e código do app: tenta a rede primeiro (pra pegar atualizações), cai no cache se estiver offline.
  // Biblioteca de PDF: cache primeiro, porque não muda.
  const isLib = new URL(req.url).pathname.includes('/lib/');

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (isLib) {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      return (await cache.match(req, { ignoreSearch: true })) || (await cache.match('index.html'));
    }
  })());
});

/* ---------- Lembrete de leitura (notificação) ---------- */

// Quanto você já leu hoje e qual é a meta (lê do próprio aparelho)
async function progressoHoje() {
  const d = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let pages = 0, meta = 50;
  try {
    const c = await caches.open(PREFS);
    const r = await c.match('metaDia');
    if (r) meta = Number(await r.text()) || meta;
  } catch { /* sem meta salva */ }
  try {
    pages = await new Promise((resolve) => {
      const req = indexedDB.open('folha');
      req.onerror = () => resolve(0);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('dias')) { db.close(); return resolve(0); }
        const g = db.transaction('dias', 'readonly').objectStore('dias').get(key);
        g.onsuccess = () => { db.close(); resolve(g.result?.pages || 0); };
        g.onerror = () => { db.close(); resolve(0); };
      };
    });
  } catch { /* sem registro */ }
  return { pages, meta };
}

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let data = {};
    try { data = e.data ? e.data.json() : {}; } catch { /* texto simples */ }
    const { pages, meta } = await progressoHoje();
    // o iPhone já põe "from Biblioteca" embaixo do título, então o título traz a novidade
    let title, body;
    if (pages >= meta) {
      title = 'Meta batida 🎉';
      body = `Você leu ${pages} páginas hoje. Se quiser, mais um capítulo 💗`;
    } else if (pages > 0) {
      title = `Faltam ${meta - pages} páginas`;
      body = `Você já leu ${pages} hoje. Bora fechar a meta?`;
    } else {
      title = 'Hora de ler 📚';
      body = `Sua meta de hoje é ${meta} páginas. Bora começar?`;
    }
    await self.registration.showNotification(title, {
      body,
      icon: 'icon-180.png',
      tag: 'lembrete-leitura',
      data: { url: './' },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (list[0]) return list[0].focus();
    return self.clients.openWindow(e.notification.data?.url || './');
  })());
});

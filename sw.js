/* Service Worker — オフライン対応
 * 内容を更新したら VERSION を上げると、次回起動時に新しいファイルに入れ替わります。 */
const VERSION = 'v2.1.0';
const SHELL_CACHE = 'gt-shell-' + VERSION;
const DATA_CACHE = 'gt-data-' + VERSION;
const TILE_CACHE = 'gt-tiles-v1'; // 地図タイルはバージョン更新で消さない

const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.json',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];
const DATA_FILES = ['spots.json', 'glossary.json', 'info.json', 'timeline.json']; // 都市ごとのファイル（timeline.json は任意）

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL);
    const data = await caches.open(DATA_CACHE);
    await data.add('./data/cities.json');
    // data/cities.json に載っている全都市のデータと写真をキャッシュ（都市を追加しても自動で対象になる）
    const cities = (await (await data.match('./data/cities.json')).json()).cities || [];
    for (const c of cities) {
      for (const f of DATA_FILES) {
        try { await data.add('./data/' + c.id + '/' + f); } catch (e) { /* timeline.json など任意ファイルは無くてもよい */ }
      }
      try {
        const res = await data.match('./data/' + c.id + '/spots.json');
        const json = await res.json();
        const photos = (json.spots || []).map((s) => s.photo && s.photo.src).filter(Boolean).concat(c.cover ? [c.cover] : []);
        await shell.addAll([...new Set(photos.map((p) => './' + p.replace(/^\.?\//, '')))]);
      } catch (e) { /* 写真のキャッシュ失敗は致命的ではない */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, DATA_CACHE, TILE_CACHE];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 地図タイル：保存済みならキャッシュから。なければネットワーク（自動では保存しない）
  if (url.hostname === 'tile.openstreetmap.org') {
    event.respondWith((async () => {
      const hit = await caches.match(req.url, { cacheName: TILE_CACHE });
      if (hit) return hit;
      try { return await fetch(req); }
      catch (e) { return new Response('', { status: 504, statusText: 'offline' }); }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  // データ（JSON）：ネットワーク優先（編集がすぐ反映される）→ 失敗したらキャッシュ
  if (url.pathname.endsWith('.json') && url.pathname.includes('/data/')) {
    event.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        return (await cache.match(req, { ignoreSearch: true })) || new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // ページ遷移：キャッシュのアプリ本体を返す
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match('./index.html');
      const network = fetch(req).then((res) => {
        if (res.ok) caches.open(SHELL_CACHE).then((c) => c.put('./index.html', res.clone()));
        return res;
      }).catch(() => null);
      return cached || (await network) || new Response('オフラインです', { status: 503 });
    })());
    return;
  }

  // その他（CSS/JS/画像）：キャッシュ優先、裏で更新
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response('', { status: 504 });
  })());
});

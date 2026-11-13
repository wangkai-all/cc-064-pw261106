// 应用外壳缓存：断网后刷新页面仍可打开并继续录入（数据在 localStorage 中独立持久化）。
const CACHE = 'offline-survey-shell-v1';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/forms.js',
  './js/engine.js',
  './js/storage.js',
  './js/app-core.js',
  './js/components.js',
  './js/views.js',
  './js/main.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

// 纯前端应用：对同源 GET 请求采用“缓存优先，网络回源更新”。
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetched = fetch(request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || fetched;
    }),
  );
});

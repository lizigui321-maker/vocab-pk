// 胖虎单词PK Service Worker：让网页可「添加到主屏幕」当 App 安装
// 策略：接口(/api)始终走网络（保证实时对战）；静态资源缓存优先，离线也能打开首页
const CACHE = 'vocabpk-v24';
const SHELL = ['/', '/index.html', '/books.bundle.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return; // 登录/答题等写操作直接走网络
  var url = new URL(req.url);
  if (url.pathname.indexOf('/api/') === 0) {
    // 接口：网络优先，离线时返回友好 JSON（不破坏实时逻辑）
    e.respondWith(fetch(req).catch(function () {
      return new Response('{"error":"offline"}', { headers: { 'Content-Type': 'application/json' } });
    }));
    return;
  }
  // 静态资源：网络优先、缓存兜底（M3）。发版后用户始终拿到最新 index.html / books.bundle.js，
  // 避免「旧缓存卡住、选不了词本/计划」这类假象；同时又保留离线打开首页的能力。
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && url.origin === self.location.origin) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        if (cached) return cached;
        if (url.pathname === '/' || url.pathname === '/index.html') return caches.match('/index.html');
      });
    })
  );
});

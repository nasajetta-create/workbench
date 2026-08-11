/* 艋舺良的工作台 service worker（強制自動更新版，沿用旅遊分帳做法） */
const CACHE = 'wb-v10';
const CORE = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // 自家檔案：網路優先（拿最新版），失敗回快取（離線可用）
  if (url.origin === location.origin){
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
    );
  }
  // 第三方（Firebase SDK、天氣）走預設網路，不快取
});

/* ── Web Push：收到每朝簡報就跳通知 ── */
self.addEventListener('push', e => {
  let d = {title:'艋舺良的工作台', body:'', url:'./'};
  try { if (e.data) d = Object.assign(d, e.data.json()); }
  catch(err){ if (e.data) d.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: 'wb-brief',              // 同標籤會取代舊的，不會疊一堆
    renotify: true,
    data: {url: d.url || './'}
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
    for (const c of list){ if (c.url.indexOf('/workbench') > -1 && 'focus' in c) return c.focus(); }
    return clients.openWindow(target);
  }));
});

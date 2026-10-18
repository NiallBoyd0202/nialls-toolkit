// Web app only (the Chrome extension doesn't use this): lets the installed app open without internet and
// makes it installable. Always tries the network first, so a new version shows up as soon as it's online;
// falls back to the saved copy when offline or when the network is very slow.
// Only the app's own files are saved; Keepa and Google requests are never touched.
const CACHE = 'nt-app-v2.2.0';
const CORE = ['./dashboard.html', './css/app.css', './js/app.js', './app.webmanifest', './icons/icon48.png', './icons/icon192.png'];
const SLOW_MS = 5000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('nt-app-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const net = fetch(req).then((res) => {
      // ?code=… (Google sign-in) and other one-off addresses aren't worth keeping
      if (res.ok && !url.search) cache.put(req, res.clone());
      return res;
    });
    net.catch(() => {}); // a late failure after the saved copy was used is fine
    const saved = await cache.match(req, { ignoreSearch: true });
    if (!saved) return net;
    // network first, but don't keep you waiting on a bad connection
    const slow = new Promise((r) => setTimeout(() => r(saved), SLOW_MS));
    try { return await Promise.race([net, slow]); } catch { return saved; }
  })());
});

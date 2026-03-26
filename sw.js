// Service Worker — cache Plex artwork for faster CoverFlow and Now Playing
// Cache-first strategy for thumbnail requests to *.plex.direct and *.plex.tv.
// All other requests pass through normally.

const CACHE   = 'dalekpod-art-v1';
const ART_RE  = /\/photo[:%3A]*\/transcode|\/library\/metadata\/\d+\/(thumb|art)/;
const HOST_RE = /\.plex\.direct(:\d+)?$|\.plex\.tv$/;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  // Delete old cache versions on upgrade
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Only intercept Plex art endpoints
  let url;
  try { url = new URL(e.request.url); } catch { return; }
  if (!HOST_RE.test(url.hostname)) return;
  if (!ART_RE.test(url.pathname))  return;

  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request);
      if (cached) return cached;

      try {
        const response = await fetch(e.request);
        // Cache successful image responses (including opaque cross-origin responses)
        if (response.ok || response.type === 'opaque') {
          cache.put(e.request, response.clone());
        }
        return response;
      } catch {
        // Network failure and not cached — return empty 503
        return new Response('', { status: 503 });
      }
    })
  );
});

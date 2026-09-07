// Service worker: make the static shell load instantly on return visits, and
// keep it available offline. Bump VERSION when the precache list or the
// strategy changes; activate() then drops every older cache.
//
// Live data is never cached here: the VBB gate is cross-origin, so it never
// reaches the fetch handler, and the poll keeps going to the network.

const VERSION = 'liveberlin-v1'

// Stable paths only. The hashed JS/CSS bundle names change every build, so they
// are cached on first fetch below rather than listed here.
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './og-image.png',
  './routes.json',
  './stations.json',
  './tracks.json',
  './maplibre-gl-worker.mjs',
  './maplibre-gl-shared.mjs'
]

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION)
      .then(cache => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== location.origin) return

  // Navigations go to the network first so a deploy is seen immediately; the
  // cache is the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone()
          caches.open(VERSION).then(cache => cache.put(request, copy))
          return response
        })
        .catch(() => caches.match(request).then(hit => hit || caches.match('./')))
    )
    return
  }

  // Everything else: cached copy first, refreshed from the network behind it.
  event.respondWith(
    caches.match(request).then(hit => {
      const refresh = fetch(request)
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone()
            caches.open(VERSION).then(cache => cache.put(request, copy))
          }
          return response
        })
        .catch(() => hit)
      return hit || refresh
    })
  )
})

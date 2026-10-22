// Service worker: makes the app work offline.
// Bump VERSION whenever any app file changes, so installed copies pick up the new files.
// Every file the app needs must be listed in PRECACHE (npm run check verifies this).
const VERSION = '1.0.0';
const APP_CACHE = `app-${VERSION}`;
const TILE_CACHE = 'tiles-v1';
const MAX_TILES = 3000;

const PRECACHE = [
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/alarm.js',
  'js/app.js',
  'js/ble.js',
  'js/db.js',
  'js/format.js',
  'js/geo-math.js',
  'js/geo.js',
  'js/map.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

/** Caches every app file, retrying each a few times so one dropped request on a patchy connection doesn't fail the install. */
async function precache() {
  const cache = await caches.open(APP_CACHE);
  await Promise.all(PRECACHE.map(async (url) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(new Request(url, { cache: 'reload' }));
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return await cache.put(url, response);
      } catch (err) {
        if (attempt === 4) throw err;
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
  }));
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('app-') && key !== APP_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'VERSION') event.ports[0]?.postMessage(VERSION);
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.hostname === 'tile.openstreetmap.org') {
    event.respondWith(tile(event));
  } else if (url.origin === self.location.origin) {
    event.respondWith(request.mode === 'navigate' ? page(request) : appFile(request));
  }
});

async function appFile(request) {
  return (await caches.match(request, { cacheName: APP_CACHE, ignoreSearch: true })) ?? fetch(request);
}

/** The app is a single page: serve the cached index.html for it, even offline. */
async function page(request) {
  const scope = new URL(self.registration.scope).pathname;
  const path = new URL(request.url).pathname;
  const cached = await caches.match('index.html', { cacheName: APP_CACHE });
  if (cached && (path === scope || path === `${scope}index.html`)) return cached;
  try {
    return await fetch(request);
  } catch {
    return cached ?? Response.error();
  }
}

/**
 * Map tiles: cache-first, keeping every tile you've looked at (up to MAX_TILES)
 * so those areas work offline. Nothing is downloaded in bulk, per the OSM tile policy.
 */
let tilePuts = 0;

async function tile(event) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(event.request);
  if (cached) return cached;
  try {
    const response = await fetch(event.request);
    if (response.ok) {
      event.waitUntil(cache.put(event.request, response.clone()).then(() => {
        if (++tilePuts % 100 === 0) return trimTiles(cache);
      }));
    }
    return response;
  } catch {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function trimTiles(cache) {
  const keys = await cache.keys(); // oldest first
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_TILES))) await cache.delete(key);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const hash = event.notification.data?.hash || '#/items';
  event.waitUntil((async () => {
    const [client] = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (client) {
      await client.focus();
      client.postMessage({ type: 'navigate', hash });
    } else {
      await self.clients.openWindow(new URL(hash, self.registration.scope).href);
    }
  })());
});

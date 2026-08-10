// Edit these two filenames if yours differ from the defaults.
const APP_HTML = './index.html';
const WORDS_FILE = './words.xlsx';
const VERBS_FILE = './verbs.xlsx';

// The 15 category word lists (Categories game). Add/remove entries here if
// you add or rename a categories-*.xlsx file in the repo.
const CATEGORY_FILES = [
  './categories-animals.xlsx',
  './categories-bodyparts.xlsx',
  './categories-clothing.xlsx',
  './categories-colours.xlsx',
  './categories-dailyverbs.xlsx',
  './categories-daysandmonths.xlsx',
  './categories-emotions.xlsx',
  './categories-family.xlsx',
  './categories-foodanddrink.xlsx',
  './categories-greetings.xlsx',
  './categories-house.xlsx',
  './categories-numbers.xlsx',
  './categories-questionwords.xlsx',
  './categories-transport.xlsx',
  './categories-weather.xlsx',
];

const CACHE_NAME = 'palabra-cache-v3';
const ASSETS_TO_CACHE = [
  './',
  APP_HTML,
  './manifest.json',
  WORDS_FILE,
  VERBS_FILE,
  ...CATEGORY_FILES,
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(ASSETS_TO_CACHE).catch(() => {
        // If one asset 404s (e.g. a renamed file) don't let it block install entirely
        return Promise.allSettled(ASSETS_TO_CACHE.map((url) => cache.add(url)));
      })
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first: always try to fetch the latest version when online, so a
// deploy takes effect on the very next load rather than the one after that.
// Falls back to the cached copy only when the network fails (offline), and
// keeps the cache updated with whatever succeeded, for that fallback to stay
// useful.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // Only handle requests for our own origin. Without this check, taps on
  // external links (e.g. the Telegram contact link) get swallowed here too
  // — the SW tries to fetch/cache a cross-origin navigation, that silently
  // fails, and the link appears to do nothing.
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

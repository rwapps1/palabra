// Edit this filename if yours differs from the default.
const APP_HTML = './index.html';
const WORDS_FILE = './words.xlsx';

// Verbs and the 15 category word lists now live inside WORDS_FILE itself
// (Category column), so there's nothing to list here anymore - one file to
// cache instead of 17.

// v15: Story Mode bug fix. js/cloud-sync.js changed content —
// mergeProgressShape() is a shape gate that starts from defaultProgress() and
// copies only the fields it names, so storyLifetime and storiesRead were reset
// to their defaults on every cloud pull. Reading a story marked it read, then
// the next pull silently unmarked it and took the XP back off. LOAD-BEARING:
// without this bump a device keeps serving the v14 cloud-sync.js and the bug
// persists even though the fix is deployed.
//
// v14: Story Mode. New files (css/story.css, js/game-story.js,
// js/views/render-story.js) plus content changes to config.js, progress-xp.js,
// state.js, base.css, hub.css, render-quiz.js, render-hub.js and
// render-dispatch.js — all already-cached files, so this bump is what makes
// the new code reachable on an installed device.
//
// The stories themselves (stories/index.json, stories/*.json) are
// DELIBERATELY NOT in ASSETS_TO_CACHE. Network-first caches them on first
// read anyway, so a story you have read stays readable offline — and adding a
// new story later then needs no cache bump at all, only a new file and a
// manifest line. A bump is only required if an ALREADY-PUBLISHED story's text
// changes, since a device may be holding the old copy.
//
// v12: progress now pushes with updateDoc (replace) instead of setDoc merge —
// js/firebase-auth.js and js/cloud-sync.js changed. A merged write could not
// remove the records the ID migration merged away, leaving the Firestore
// document holding both key sets and breaching the 40,000 index-entry limit,
// so every push was rejected.
//
// v11 was for the word-ID keying change — words.xlsx gained an ID column and
// js/utils.js, js/data-loading.js, js/progress-xp.js, js/cloud-sync.js and
// js/game-conjugate.js all changed content. THIS BUMP IS LOAD-BEARING, not
// housekeeping: the new code keys progress on the ID column, so a device
// still serving the old cached words.xlsx would be running new code against
// a word list with no IDs in it. remapProgressKeysToIds() refuses to run in
// that state rather than wiping history, but the app would fall back to text
// keys until the cache turned over. admin/ is still deliberately uncached.
//
// /new is still deliberately NOT in ASSETS_TO_CACHE below:
// it's a one-time, no-account ad-funnel page for first-time visitors, not
// part of the installed offline app shell, so it doesn't need precaching or
// offline support the way the main app does. admin/ is likewise absent on
// purpose — it's a dashboard read on demand, never offline.
//
// demo-telemetry.js IS cached, unlike /new, because the real app loads it
// on every page view: leaving it uncached would mean an extra network
// request on every cold start for a file that does nothing for the vast
// majority of users.
const CACHE_NAME = 'palabra-cache-v15';
const ASSETS_TO_CACHE = [
  './',
  APP_HTML,
  './manifest.json',
  WORDS_FILE,
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './css/base.css',
  './css/components.css',
  './css/auth.css',
  './css/quiz.css',
  './css/memory.css',
  './css/progress.css',
  './css/celebration.css',
  './css/daily-double.css',
  './css/hub.css',
  './css/story.css',
  './js/firebase-auth.js',
  './js/config.js',
  './js/demo-telemetry.js',
  './js/utils.js',
  './js/audio.js',
  './js/progress-xp.js',
  './js/state.js',
  './js/auth.js',
  './js/cloud-sync.js',
  './js/data-loading.js',
  './js/word-selection.js',
  './js/conjugation-engine.js',
  './js/achievements.js',
  './js/game-quiz.js',
  './js/game-timeattack.js',
  './js/game-memory.js',
  './js/game-conjugate.js',
  './js/game-story.js',
  './js/views/render-auth.js',
  './js/views/render-hub.js',
  './js/views/render-quiz.js',
  './js/views/render-timeattack.js',
  './js/views/render-memory.js',
  './js/views/render-conjugate.js',
  './js/views/render-progress.js',
  './js/views/render-story.js',
  './js/views/render-dispatch.js',
  './js/navigation.js',
  './js/app-boot.js',
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

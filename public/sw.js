// sw.js — service worker whose ONLY job is to satisfy the browser's "installable
// web app" requirement so SnapReceipt AI can be installed as a desktop/home-screen
// app (2026-08-25), the same way Claude.ai offers a downloadable desktop app.
//
// Scope is deliberately narrow because of ADR-025 ("financial data is never
// cached offline", see index.html's manifest comment): this worker NEVER
// intercepts or caches anything under /api/ — every receipt, expense, and
// account value always comes straight from the network, exactly like before
// this file existed. It only caches the static app SHELL (index.html, css,
// js, icons, manifest) so the site can install and, as a side benefit, shows
// the last-loaded shell instead of the browser's blank offline error page if
// the connection briefly drops. That is the full extent of what it does.
'use strict';

var SHELL_CACHE = 'snapreceipt-shell-v1';

// Only stable, non-versioned paths — the actual CSS/JS bundles carry a
// ?v=CACHE_BUST query string that changes on every deploy (see index.html's
// own comment on that), so precaching them here would need updating on every
// release; instead they're picked up by the runtime "network-first, cache as
// you go" logic in the fetch handler below.
var SHELL_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/icons/app-icon-192.png',
  '/icons/app-icon-512.png',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function (cache) { return cache.addAll(SHELL_ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.filter(function (n) { return n !== SHELL_CACHE; }).map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  // Never intercept writes (all mutations are POST/PUT/PATCH/DELETE) — GET-only.
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // Never touch cross-origin requests (Google Fonts, etc.) — let the browser
  // handle those exactly as if this worker didn't exist.
  if (url.origin !== self.location.origin) return;
  // The one hard rule: /api/ always bypasses this worker entirely. No receipt,
  // expense, account, or auth response is ever read from or written to a cache.
  if (url.pathname.indexOf('/api/') === 0) return;

  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(SHELL_CACHE).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (cached) { return cached || caches.match('/'); });
    })
  );
});

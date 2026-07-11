# Installable dashboard (PWA) — design record

**Date:** 2026-07-11 · **Author:** Jeevan (Owner-directed) · **Status:** built
**Scope:** frontend-only static assets. `public/manifest.webmanifest`, `public/icons/app-icon.svg`,
`public/index.html` `<head>`. **No backend, no dependency, no service worker.**

## Why
The product ships as a **hosted web app**, not a download (ADR-020: no APK, no `.exe`, no installer,
no store). Clients asked "how does it sit on my PC?" — the honest answer was "bookmark the URL." This
adds a **web-app manifest** so the browser offers **Install / Add to Home screen**: the dashboard then
opens in its own window with a real app icon on the desktop/taskbar/home screen. Still no packaging to
ship — the "install" is the browser's, driven by files we already serve.

## What
- **`manifest.webmanifest`** — `name`/`short_name`/`description`, `start_url` + `scope` = `/`,
  `display: standalone`, brand `theme_color` (#5f7a47 moss) / `background_color` (#e6e1ce paper), and
  one SVG icon (`purpose: "any maskable"`).
- **`icons/app-icon.svg`** — a brand-green, maskable-safe receipt-and-magnifier mark (all art inside the
  centre-80% safe zone; full-bleed background so a circular/squircle mask never clips to transparency).
- **`index.html`** — `<link rel="manifest">`, `theme-color`, `application-name`, `apple-touch-icon`,
  `rel="icon"`, and `mobile-web-app-capable` / `apple-mobile-web-app-*` meta.

## Deliberate non-goals / decisions
- **No service worker.** A caching SW is the usual PWA companion, but caching a financial dashboard's
  data offline collides with ADR-025 (SEC — offline-cache handling of financial PII). Desktop Chrome/Edge
  offer **Install from the menu with just a manifest + icons**, so we get the app-icon/standalone-window
  win without ever persisting receipts/expenses on disk. If a true offline mode is ever wanted, it needs
  its own security design (what may be cached, encryption at rest, eviction) — out of scope here.
- **No new dependency, no build step** (ADR-012 two-deps ethos holds).
- **No CSP change needed.** `manifest-src` falls back to `default-src 'self'`, and the icon is covered by
  `img-src 'self'` (`lib/security-headers.js`) — the manifest and icon are same-origin.
- **Per-client branding (ADR-020).** Each client instance is a separate deploy; rebranding = edit
  `name`/`short_name`/`theme_color` in the manifest and swap `icons/app-icon.svg`. Kept as static files
  (not a dynamic route) precisely because per-client customisation is a deploy-time edit, not runtime.
- **iOS note:** `apple-touch-icon` points at the SVG; older iOS Safari prefers a PNG for the home-screen
  icon. If iOS home-screen polish is requested, add a 180×180 PNG — desktop (the primary surface) is
  unaffected.

## Tests
`tests/pwa.manifest.test.js` — manifest parses, required install fields present, every referenced icon
exists on disk with a declared type, at least one maskable icon, and `index.html` wires the manifest +
theme-color + apple-touch-icon. Guards against a silent break of installability.

## Verification
Manifest + icon are static; the guard test covers structure. Live "Install" prompt is a browser-driven
behaviour best confirmed on the deployed instance (needs HTTPS — currently self-signed; a real cert is
the standing deferred blocker, after which the Install affordance is fully clean).

# Frontend Issues Log

Records frontend bugs found and how they were fixed. Updated automatically whenever a frontend fix is made (public/js, public/css, public/index.html). Records only — no general docs here.

---

## 2026-08-23 — Refresh button reloaded the whole app and logged users out

**Issue:** The dashboard header's Refresh (↻) button called a full `location.reload()`. This reran the entire boot flow and could log a user (or Guest Mode session) out instead of just refreshing the current page's data.

**Fix:** Added `refreshCurrentView()` in `public/js/app.js`, which re-runs `select(currentViewId)` — the same view-switch/data-refetch path every nav-button click already uses. Wired the header's Refresh button to it instead of `reloadPage()`. No page reload, no session loss.

**Files:** `public/js/app.js`

**Verified:** Full test suite (2259/2259) passing. Live-tested on the real site as a Guest Mode user — clicking Refresh only re-fetched the current view's data (`/api/review`), no `/api/config` re-fetch, no reload, no logout.

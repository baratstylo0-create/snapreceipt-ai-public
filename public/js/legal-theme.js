// legal-theme.js — standalone pages (privacy.html, accountdeletion.html) aren't part of
// the dashboard SPA, so app.js's applyTheme() never runs for them; they always rendered
// the default :root (tan/light) palette regardless of the user's actual dashboard theme
// (2026-08-19, Barat: "why the theme colour not same as app colour"). Reads the SAME
// sessionStorage key app.js writes ('theme') and applies the matching body class before
// first paint — a tab opened via target=_blank inherits a copy of the opener's
// sessionStorage (HTML living standard), so a user who came from Settings sees their own
// theme immediately. No sessionStorage / not a recognised value -> falls back to 'light',
// matching app.js's own applyTheme() fallback exactly. Never throws.
(function () {
  'use strict';
  var ALL_THEMES = ['light', 'warm', 'dark', 'ocean', 'ocean-dark'];
  var stored = null;
  try { stored = sessionStorage.getItem('theme'); } catch (e) { /* ignore */ }
  var theme = ALL_THEMES.indexOf(stored) !== -1 ? stored : 'light';
  if (document.body) document.body.classList.add('theme-' + theme);
}());

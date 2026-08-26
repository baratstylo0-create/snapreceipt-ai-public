// download.js — OS detection for download.html's install card, plus the DOM wiring
// that acts on it. The detection half is pure (no DOM), UMD-shimmed like authgate.js so
// node:test can exercise it directly; the DOM half only runs in a real browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DownloadPage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // detectOS(ua, platform, maxTouchPoints) -> 'windows' | 'mac' | 'other'.
  // iPhone/iPad report "Macintosh" in Safari's desktop-mode UA on newer iOS, so a bare
  // "Mac" string match isn't enough — excluded by the touch-first MacIntel+multitouch
  // signal a real Mac never has (real Macs are never touch devices).
  function detectOS(ua, platform, maxTouchPoints) {
    var combined = (ua || '') + ' ' + (platform || '');
    if (/Windows|Win32|Win64|WOW64/i.test(combined)) return 'windows';
    var looksLikeMacUA = /Macintosh|Mac OS X/i.test(combined) && !/iPhone|iPad|iPod/i.test(combined);
    var isIpadDesktopMode = (Number(maxTouchPoints) > 1) && /MacIntel/.test(platform || '');
    if (looksLikeMacUA && !isIpadDesktopMode) return 'mac';
    return 'other';
  }

  return { detectOS: detectOS };
});

// DOM wiring — swaps the download card to match the visitor's OS. The page ships
// Windows-first content with no JS needed (most visitors), then this progressively
// swaps it for Mac/other. Only runs in a real browser (Node require() above must not
// touch document/navigator).
if (typeof document !== 'undefined' && typeof navigator !== 'undefined') {
  (function () {
    var DownloadPage = (typeof module === 'object' && module.exports)
      ? module.exports
      : (typeof self !== 'undefined' ? self.DownloadPage : this.DownloadPage);
    var os = DownloadPage.detectOS(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
    if (os === 'windows') return;

    var winPanel = document.getElementById('dl-windows');
    if (winPanel) winPanel.hidden = true;
    var note = document.getElementById('dl-browser-note');
    if (note) note.hidden = true;

    var targetId = os === 'mac' ? 'dl-mac' : 'dl-other';
    var targetPanel = document.getElementById(targetId);
    if (targetPanel) targetPanel.hidden = false;
  })();

  // "Back" button history fix (2026-08-25, Barat: browser Back from the Login
  // screen was landing on THIS page instead of going straight to Main). Root
  // cause: .dl-back was a plain <a href="/"> — clicking it always PUSHES a
  // fresh "/" history entry on top of the stack, even though the visitor
  // already has a perfectly good "/" entry right behind this page (the one
  // they arrived from). That leaves the stack looking like
  // [ /, /download.html, / ] instead of [ /, /download.html ]. Everything
  // done on the SPA's Main/Login screens afterward (Login has no URL/history
  // of its own) never touches that stack, so the NEXT native Back press pops
  // the duplicate "/" first, re-revealing /download.html before Main.
  // Fix: when we can tell the visitor actually came from this same site
  // (same-origin referrer + a real entry to return to), use history.back()
  // instead — that just moves the stack pointer back to the existing "/"
  // entry rather than pushing a new one, so the duplicate never gets
  // created. Falls back to the plain href="/" navigation (unchanged
  // behavior) for anyone who opened this page directly — a bookmark, a
  // shared link, a new tab — where there's no same-site page to return to.
  (function () {
    var backLink = document.querySelector('.dl-back');
    if (!backLink) return;
    backLink.addEventListener('click', function (ev) {
      var sameOriginReferrer = document.referrer && document.referrer.indexOf(location.origin + '/') === 0;
      if (sameOriginReferrer && window.history.length > 1) {
        ev.preventDefault();
        window.history.back();
      }
    });
  })();
}

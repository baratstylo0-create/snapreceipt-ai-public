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
}

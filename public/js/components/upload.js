// components/upload.js — the Mass Upload screen (Task D): drag-and-drop + file
// picker for images AND PDFs, client-side base64 encode, POST /api/upload, and a
// rendered batch summary. This surface renders server-sanitized-but-still-treated-
// as-untrusted text (failed[].reason, flagged[].reason/merchant) — Iron rule
// (same as activity.js): every value put in the DOM goes through Escape.setText /
// Escape.safeText; we NEVER assign innerHTML from data.
//
// TWO layers, kept apart so the logic is unit-testable without a DOM:
//   1. PURE helpers — buildUploadBody / summarize / errorMessage. No DOM, no
//      network, no escaping (render owns escaping), never throw on junk. Covered
//      by tests/frontend/upload.test.js.
//   2. RENDER layer (mount + drag/drop + FileReader) — real DOM + browser-only
//      APIs (document, FileReader). No-ops outside a browser.
//
// Endpoint contract (read from routes/upload.js + lib/massupload.js):
//   POST /api/upload  body: { images: [ <base64 or data-URI string> , ... ] }
//     (data-URI prefix is accepted; the server strips it. PDFs go in the SAME
//      array and are detected server-side by their %PDF magic bytes.)
//   200 -> { images, receipts, saved,
//            failed:[{image_index, receipt_index?, reason}],
//            flagged:[{image_index, receipt_index, merchant, reason}],
//            truncated_images:[i...], pages_truncated? }
//   400 malformed body · 413 too many images / PDF too large · 422 bad PDF
//   502 upstream/analyzer failure · 503 upload not available yet.
//   All error bodies are fixed { error: '<string>' } (already sanitized).
//
// UMD shim: window.Upload in the browser; require()-able in Node (the render layer
// simply isn't exercised there — no document / FileReader).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../escape'), require('../format'), require('../api'));
  } else {
    root.Upload = factory(root.Escape, root.Format, root.Api);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape, Format, Api) {
  'use strict';

  // The server enforces this cap (MASS_MAX_IMAGES, default 10 in routes/upload.js)
  // and it is NOT exposed by /api/config, so we mirror the server default here for a
  // friendly client-side hint only. The server remains the sole real enforcer; if
  // the deployment raises MASS_MAX_IMAGES the client just hints early (harmless).
  var MASS_MAX_IMAGES = 10;
  // Friendly hint threshold for a "very large" PDF (bytes). Purely advisory — the
  // server's own byte cap (413 TOO_LARGE) is the real limit.
  var PDF_LARGE_HINT_BYTES = 8 * 1024 * 1024; // ~8 MB

  // ---- pure helpers -------------------------------------------------------

  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function toInt(v) { var n = Number(v); return Number.isFinite(n) ? Math.floor(n) : 0; }

  // Assemble the POST body from already-encoded entries. Each entry may be a bare
  // base64/data-URI string, or an object carrying its encoded payload on `.data`
  // (the shape the render layer builds after FileReader). Non-usable entries are
  // dropped so `images` is always an array of non-empty strings — matching what
  // /api/upload validates. Never throws.
  function buildUploadBody(entries) {
    var list = Array.isArray(entries) ? entries : [];
    var images = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var data = typeof e === 'string' ? e : (e && typeof e === 'object' ? e.data : null);
      if (typeof data === 'string' && data !== '') images.push(data);
    }
    return { images: images };
  }

  // Reduce the server's batch summary to a flat view model for the render layer.
  // Uses the REAL server field names (images/receipts/saved/failed/flagged/
  // truncated_images/pages_truncated). Tolerates a null/garbage response — never
  // throws. Escaping is deliberately NOT done here (render owns it).
  function summarize(resp) {
    var r = resp && typeof resp === 'object' ? resp : {};
    var failed = Array.isArray(r.failed) ? r.failed : [];
    var flagged = Array.isArray(r.flagged) ? r.flagged : [];
    var truncated = Array.isArray(r.truncated_images) ? r.truncated_images : [];
    return {
      images: toInt(r.images),
      receipts: toInt(r.receipts),
      saved: toInt(r.saved),
      failed: failed,
      flagged: flagged,
      failedCount: failed.length,
      flaggedCount: flagged.length,
      truncatedImages: truncated.length,
      hasTruncatedImages: truncated.length > 0,
      pagesTruncated: r.pages_truncated === true,
    };
  }

  // Map an HTTP status (from apiFetch's thrown { status, body }) to a fixed,
  // friendly message. The parsed body is intentionally IGNORED for its contents —
  // we never surface server internals (SOP §7.2), only branch on the status. Any
  // unknown status falls back to a safe generic.
  function errorMessage(status, /* body */ _body) {
    switch (Number(status)) {
      case 400: return 'We couldn’t read that upload. Please pick image or PDF files and try again.';
      case 413: return 'Too many files, or a file was too large (max ' + MASS_MAX_IMAGES + ' at once).';
      case 422: return 'That PDF couldn’t be processed (it may be encrypted, corrupt, or not a real PDF).';
      case 502: return 'The analyzer is busy right now. Please try again in a moment.';
      case 503: return 'Upload is temporarily unavailable. Please try again later.';
      default:  return 'Something went wrong with the upload. Please try again.';
    }
  }

  // ---- DOM / browser helpers (browser only) -------------------------------

  function hasDom() { return typeof document !== 'undefined'; }
  function hasFileReader() { return typeof FileReader !== 'undefined'; }
  function el(tag, className) { var n = document.createElement(tag); if (className) n.className = className; return n; }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function msg(className, text) { var p = el('p', className); Escape.setText(p, text); return p; }

  function isPdfFile(file) {
    return !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(str(file.name)));
  }
  function isImageFile(file) {
    return !!file && (/^image\//.test(str(file.type)) || /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(str(file.name)));
  }
  function acceptedFile(file) { return isPdfFile(file) || isImageFile(file); }

  function humanSize(bytes) {
    var n = toInt(bytes);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // Read a File as a bare base64 string (data-URI prefix stripped). The server
  // accepts either, but we send bare base64 to keep the payload minimal. Resolves
  // { name, size, data } or rejects.
  function readFileAsBase64(file) {
    return new Promise(function (resolve, reject) {
      if (!hasFileReader()) { reject(new Error('no FileReader')); return; }
      var fr = new FileReader();
      fr.onload = function () {
        var res = str(fr.result);
        var comma = res.indexOf(',');
        var data = comma !== -1 ? res.slice(comma + 1) : res; // strip "data:...;base64,"
        resolve({ name: file.name, size: file.size, data: data });
      };
      fr.onerror = function () { reject(fr.error || new Error('read failed')); };
      fr.readAsDataURL(file);
    });
  }

  // Compute friendly, non-blocking hints for the current selection.
  function selectionHints(files) {
    var hints = [];
    if (files.length > MASS_MAX_IMAGES) {
      hints.push('You picked ' + files.length + ' files — only the first ' + MASS_MAX_IMAGES +
        ' are processed per upload. The rest may be skipped.');
    }
    var bigPdf = files.some(function (f) { return isPdfFile(f) && toInt(f.size) > PDF_LARGE_HINT_BYTES; });
    if (bigPdf) hints.push('One of your PDFs is quite large and may be rejected or truncated.');
    return hints;
  }

  // ---- render layer -------------------------------------------------------

  function mount(section, opts) {
    if (!hasDom() || !section) return null;
    opts = opts || {};
    var apiFetch = opts.apiFetch || (opts.Api && opts.Api.apiFetch) || (Api && Api.apiFetch);

    var rootEl = el('div', 'up-root');
    section.appendChild(rootEl);

    // Intro line.
    rootEl.appendChild(msg('up-intro muted', 'Drag receipts here, or pick files. Images and PDFs are supported.'));

    // Drop zone + hidden file input + browse button.
    var zone = el('div', 'up-zone');
    zone.setAttribute('role', 'button');
    zone.setAttribute('tabindex', '0');
    zone.setAttribute('aria-label', 'Upload receipts: drag files here or press Enter to browse');
    var zoneText = msg('up-zone-text', 'Drop images or PDFs here');
    zone.appendChild(zoneText);
    var browse = el('button', 'up-browse'); browse.type = 'button'; Escape.setText(browse, 'Choose files');
    zone.appendChild(browse);

    var input = el('input', 'up-input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('accept', 'image/*,application/pdf');
    input.hidden = true;
    zone.appendChild(input);
    rootEl.appendChild(zone);

    // Selected-files list + hints.
    var hintsArea = el('div', 'up-hints');
    var listArea = el('div', 'up-list');
    rootEl.appendChild(hintsArea);
    rootEl.appendChild(listArea);

    // Actions + status + summary areas.
    var actions = el('div', 'up-actions');
    var uploadBtn = el('button', 'up-upload'); uploadBtn.type = 'button'; Escape.setText(uploadBtn, 'Upload');
    var clearBtn = el('button', 'up-clear'); clearBtn.type = 'button'; Escape.setText(clearBtn, 'Clear');
    actions.appendChild(uploadBtn); actions.appendChild(clearBtn);
    rootEl.appendChild(actions);
    var statusEl = msg('up-status muted', '');
    rootEl.appendChild(statusEl);
    var summaryArea = el('div', 'up-summary');
    rootEl.appendChild(summaryArea);

    // State: current File objects (not yet encoded) + a busy flag.
    var files = [];
    var busy = false;

    function renderList() {
      clear(listArea);
      clear(hintsArea);
      if (!files.length) {
        uploadBtn.disabled = true;
        clearBtn.disabled = true;
        return;
      }
      uploadBtn.disabled = busy;
      clearBtn.disabled = busy;

      selectionHints(files).forEach(function (h) { hintsArea.appendChild(msg('up-hint', h)); });

      var ul = el('ul', 'up-files');
      files.forEach(function (f, idx) {
        var li = el('li', 'up-file');
        var kind = el('span', 'up-file-kind up-file-kind--' + (isPdfFile(f) ? 'pdf' : 'img'));
        Escape.setText(kind, isPdfFile(f) ? 'PDF' : 'IMG');
        li.appendChild(kind);
        li.appendChild(textSpan('up-file-name', f.name));            // filename is untrusted text
        li.appendChild(textSpan('up-file-size muted', humanSize(f.size)));
        var rm = el('button', 'up-file-remove'); rm.type = 'button';
        rm.setAttribute('aria-label', 'Remove file');
        Escape.setText(rm, '×');
        rm.disabled = busy;
        rm.addEventListener('click', function () {
          if (busy) return;
          files.splice(idx, 1);
          renderList();
        });
        li.appendChild(rm);
        ul.appendChild(li);
      });
      listArea.appendChild(ul);
    }

    function textSpan(className, value) {
      var s = el('span', className);
      Escape.setText(s, value);
      return s;
    }

    function addFiles(fileList) {
      var incoming = Array.prototype.slice.call(fileList || []);
      var accepted = incoming.filter(acceptedFile);
      var rejected = incoming.length - accepted.length;
      files = files.concat(accepted);
      renderList();
      if (rejected > 0) {
        Escape.setText(statusEl, rejected + ' file(s) were skipped (only images and PDFs are supported).');
      } else {
        Escape.setText(statusEl, '');
      }
    }

    // --- drag & drop wiring (CSP-clean: addEventListener, no on*=) ---
    ['dragenter', 'dragover'].forEach(function (evt) {
      zone.addEventListener(evt, function (ev) { ev.preventDefault(); ev.stopPropagation(); zone.classList.add('is-dragover'); });
    });
    ['dragleave', 'dragend'].forEach(function (evt) {
      zone.addEventListener(evt, function (ev) { ev.preventDefault(); ev.stopPropagation(); zone.classList.remove('is-dragover'); });
    });
    zone.addEventListener('drop', function (ev) {
      ev.preventDefault(); ev.stopPropagation(); zone.classList.remove('is-dragover');
      if (busy) return;
      var dt = ev.dataTransfer;
      if (dt && dt.files) addFiles(dt.files);
    });

    // Browse: click / keyboard opens the native picker.
    browse.addEventListener('click', function () { if (!busy) input.click(); });
    zone.addEventListener('click', function (ev) {
      if (busy) return;
      if (ev.target === browse) return; // browse handles its own click
      input.click();
    });
    zone.addEventListener('keydown', function (ev) {
      if ((ev.key === 'Enter' || ev.key === ' ') && !busy) { ev.preventDefault(); input.click(); }
    });
    input.addEventListener('change', function () {
      addFiles(input.files);
      input.value = ''; // allow re-selecting the same file
    });

    clearBtn.addEventListener('click', function () {
      if (busy) return;
      files = [];
      clear(summaryArea);
      Escape.setText(statusEl, '');
      renderList();
    });

    uploadBtn.addEventListener('click', function () {
      if (busy || !files.length || !apiFetch) return;
      doUpload();
    });

    function setBusy(b) {
      busy = b;
      uploadBtn.disabled = b || !files.length;
      clearBtn.disabled = b;
      renderList();
    }

    function doUpload() {
      setBusy(true);
      clear(summaryArea);
      Escape.setText(statusEl, 'Reading files…');
      Promise.all(files.map(readFileAsBase64)).then(function (entries) {
        Escape.setText(statusEl, 'Uploading ' + entries.length + ' file(s)…');
        var body = buildUploadBody(entries);
        return apiFetch('/api/upload', { method: 'POST', body: body });
      }).then(function (resp) {
        setBusy(false);
        Escape.setText(statusEl, 'Done.');
        renderSummary(summarize(resp));
      }).catch(function (err) {
        setBusy(false);
        var status = err && typeof err === 'object' ? err.status : 0;
        var body = err && typeof err === 'object' ? err.body : null;
        Escape.setText(statusEl, errorMessage(status, body));
      });
    }

    function renderSummary(vm) {
      clear(summaryArea);

      var counts = el('div', 'up-counts');
      counts.appendChild(countChip('saved', 'Saved', vm.saved));
      counts.appendChild(countChip('failed', 'Failed', vm.failedCount));
      counts.appendChild(countChip('flagged', 'Flagged', vm.flaggedCount));
      counts.appendChild(countChip('images', 'Files', vm.images));
      summaryArea.appendChild(counts);

      if (vm.hasTruncatedImages) {
        summaryArea.appendChild(msg('up-notice', vm.truncatedImages +
          ' image(s) were partially processed (truncated by the server).'));
      }
      if (vm.pagesTruncated) {
        summaryArea.appendChild(msg('up-notice', 'Some PDF pages were skipped (page limit reached).'));
      }

      if (vm.flaggedCount) {
        summaryArea.appendChild(textHead('up-list-title', 'Flagged for review'));
        var fl = el('ul', 'up-result-list');
        vm.flagged.forEach(function (f) {
          var li = el('li', 'up-result up-result--flagged');
          var m = (f && f.merchant) ? str(f.merchant) : 'Receipt';
          var reason = (f && f.reason) ? str(f.reason) : 'flagged';
          Escape.setText(li, m + ' — ' + reason);   // both untrusted -> escaped
          fl.appendChild(li);
        });
        summaryArea.appendChild(fl);
      }

      if (vm.failedCount) {
        summaryArea.appendChild(textHead('up-list-title', 'Could not process'));
        var ff = el('ul', 'up-result-list');
        vm.failed.forEach(function (f) {
          var li = el('li', 'up-result up-result--failed');
          var label = 'File ' + (toInt(f && f.image_index) + 1) +
            (f && f.receipt_index != null ? ', receipt ' + (toInt(f.receipt_index) + 1) : '');
          var reason = (f && f.reason) ? str(f.reason) : 'could not process';
          Escape.setText(li, label + ' — ' + reason);   // reason is server-sanitized, escaped anyway
          ff.appendChild(li);
        });
        summaryArea.appendChild(ff);
      }

      if (!vm.failedCount && !vm.flaggedCount && vm.saved) {
        summaryArea.appendChild(msg('up-notice up-notice--ok', 'All receipts saved cleanly.'));
      }
    }

    function countChip(kind, label, n) {
      var chip = el('span', 'up-count up-count--' + kind);
      var num = el('span', 'up-count-num'); Escape.setText(num, Format ? Format.formatCount(n) : String(n));
      var lab = el('span', 'up-count-label'); Escape.setText(lab, label);
      chip.appendChild(num); chip.appendChild(lab);
      return chip;
    }

    function textHead(className, text) { var h = el('h4', className); Escape.setText(h, text); return h; }

    // initial state
    renderList();

    // No lazy data to load (this view is action-driven), but expose a no-op load()
    // so app.js's switcher can call it uniformly like the other views.
    return { el: rootEl, load: function () {} };
  }

  return {
    // pure
    buildUploadBody: buildUploadBody,
    summarize: summarize,
    errorMessage: errorMessage,
    selectionHints: selectionHints,
    MASS_MAX_IMAGES: MASS_MAX_IMAGES,
    // render (browser)
    mount: mount,
  };
});

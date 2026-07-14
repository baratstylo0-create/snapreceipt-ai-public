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
    // QA report #1: what was actually extracted (merchant/amount/category), so a clean
    // save doesn't just say "1 saved" with no way to tell it read the receipt correctly.
    var savedItems = Array.isArray(r.saved_items) ? r.saved_items : [];
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
      savedItems: savedItems,
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

  function branchIdsForSavedItems(items) {
    var set = {};
    (Array.isArray(items) ? items : []).forEach(function (it) {
      if (it && it.branch_id) set[String(it.branch_id)] = true;
    });
    return Object.keys(set).sort();
  }

  function selectedBranchId(items, selected) {
    var branches = {};
    var count = 0;
    (Array.isArray(items) ? items : []).forEach(function (it) {
      if (it && it.id && selected && selected[it.id]) {
        count += 1;
        branches[String(it.branch_id || '')] = true;
      }
    });
    if (!count) return '';
    var ids = Object.keys(branches);
    return ids.length === 1 ? ids[0] : null;
  }

  function normalizeStaff(resp) {
    var rows = resp && Array.isArray(resp.staff) ? resp.staff : [];
    return rows.filter(function (r) { return r && r.id; }).map(function (r) {
      return { id: String(r.id), display_name: str(r.display_name || r.name || r.id) };
    });
  }

  function applyStaffAssignResult(items, ids, staffId, resp) {
    var ok = {};
    var results = resp && Array.isArray(resp.results) ? resp.results : null;
    if (results) {
      results.forEach(function (r) { if (r && r.ok && r.id) ok[String(r.id)] = true; });
    } else {
      (Array.isArray(ids) ? ids : []).forEach(function (id) { ok[String(id)] = true; });
    }
    (Array.isArray(items) ? items : []).forEach(function (it) {
      if (it && ok[String(it.id)]) it.staff_user_id = staffId == null ? null : String(staffId);
    });
  }

  function flaggedDisplay(f) {
    var m = (f && f.merchant) ? str(f.merchant) : 'Receipt';
    if (f && f.existing_expense_id) {
      return { text: m + ' — Possible duplicate of existing expense ' + str(f.existing_expense_id), duplicate: true };
    }
    var reason = (f && f.reason) ? str(f.reason) : 'flagged';
    return { text: m + ' — ' + reason, duplicate: false };
  }

  // ---- "Enter manually" (QA 2026-07-14, Untitled document (2).md) --------------
  // A second way to log an expense on this page: type every field by hand, no photo/OCR.
  // POSTs to the new POST /api/expenses (routes/expenses.js) — nothing here touches the
  // file-upload flow above, which stays byte-for-byte unchanged.

  var DEFAULT_MANUAL_CATEGORIES = ['Others'];

  function normaliseUploadMode(v) { return v === 'manual' ? 'manual' : 'file'; }

  // resolveManualCategories(config, fallback) -> mirrors activity.js's resolveCategories
  // (same /api/config shape: { categories:[...] }, same never-empty/never-throw contract).
  // Duplicated locally rather than a shared cross-file import, matching this codebase's
  // existing per-component convention (each UMD module is self-contained).
  function resolveManualCategories(config, fallback) {
    var fb = Array.isArray(fallback) && fallback.length ? fallback : DEFAULT_MANUAL_CATEGORIES;
    if (!config || typeof config !== 'object') return fb;
    var cats = config.categories;
    if (!Array.isArray(cats) || !cats.length) return fb;
    var clean = cats.filter(function (c) { return typeof c === 'string' && c.trim() !== ''; });
    return clean.length ? clean : fb;
  }

  // Mirrors routes/expenses.js's MANUAL_DATE_RE exactly — kept in sync deliberately (both
  // reject a structurally-invalid month/day like '2026-13-01', not just a shape mismatch).
  var MANUAL_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

  // validateManualEntry(fields) -> { ok:true, body } | { ok:false, error }. Mirrors the
  // server's required-field floor exactly (merchant/date/amount/category all mandatory,
  // amount > 0) so the client never submits something the server would reject anyway — a
  // UX nicety, not the security boundary (the server independently re-validates everything).
  function validateManualEntry(fields) {
    fields = (fields && typeof fields === 'object') ? fields : {};
    var merchant = str(fields.merchant).trim();
    if (!merchant) return { ok: false, error: 'Merchant is required.' };
    var expense_date = str(fields.expense_date).trim();
    if (!MANUAL_DATE_RE.test(expense_date)) return { ok: false, error: 'Date is required (YYYY-MM-DD).' };
    var amount = Number(fields.amount);
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Amount must be a positive number.' };
    var category = str(fields.category).trim();
    if (!category) return { ok: false, error: 'Category is required.' };
    var body = { merchant: merchant, expense_date: expense_date, amount: amount, category: category };
    var currency = str(fields.currency).trim();
    if (currency) body.currency = currency;
    var remark = str(fields.remark).trim();
    if (remark) body.remark = remark;
    return { ok: true, body: body };
  }

  // manualErrorMessage(status, body) -> a 400 carries the server's OWN fixed validation
  // reason (routes/expenses.js's validateManualCreate — every message is a static string,
  // never interpolated user input or internals), so it's safe to surface directly instead
  // of a generic "something went wrong". Every other status gets a safe generic message.
  function manualErrorMessage(status, body) {
    var s = Number(status);
    if (s === 400 && body && typeof body.error === 'string' && body.error) return body.error;
    if (s === 401 || s === 403) return 'You are not signed in. Please refresh the page and try again.';
    if (s === 429) return 'Too many requests right now. Please wait a moment and try again.';
    return 'Could not save that expense. Please try again.';
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
    var switchView = typeof opts.switchView === 'function' ? opts.switchView : null;

    var rootEl = el('div', 'up-root');
    section.appendChild(rootEl);

    // "Upload a file" / "Enter manually" toggle (QA 2026-07-14, Untitled document (2).md).
    // Two pill buttons — mirrors the toggle pattern already used elsewhere (e.g. activity.js's
    // Table/Cards switch). "Upload a file" is the default; the existing OCR flow below is
    // completely untouched by this — only its section gets a hidden/shown wrapper.
    var uploadMode = 'file';
    var modeToggle = el('div', 'up-mode-toggle');
    modeToggle.setAttribute('role', 'group');
    modeToggle.setAttribute('aria-label', 'Choose how to add an expense');
    var fileModeBtn = el('button', 'up-mode-btn'); fileModeBtn.type = 'button'; Escape.setText(fileModeBtn, 'Upload a file');
    var manualModeBtn = el('button', 'up-mode-btn'); manualModeBtn.type = 'button'; Escape.setText(manualModeBtn, 'Enter manually');
    modeToggle.appendChild(fileModeBtn);
    modeToggle.appendChild(manualModeBtn);
    rootEl.appendChild(modeToggle);

    // Existing file-upload flow — wrapped in its own section so the toggle can hide/show it as
    // a whole, without touching a single line of its own logic below.
    var fileSection = el('div', 'up-file-section');
    rootEl.appendChild(fileSection);

    // Intro line.
    fileSection.appendChild(msg('up-intro muted', 'Drag receipts here, or pick files. Images and PDFs are supported.'));

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
    fileSection.appendChild(zone);

    // Selected-files list + hints.
    var hintsArea = el('div', 'up-hints');
    var listArea = el('div', 'up-list');
    fileSection.appendChild(hintsArea);
    fileSection.appendChild(listArea);

    // Actions + status + summary areas.
    var actions = el('div', 'up-actions');
    var uploadBtn = el('button', 'up-upload'); uploadBtn.type = 'button'; Escape.setText(uploadBtn, 'Upload');
    var clearBtn = el('button', 'up-clear'); clearBtn.type = 'button'; Escape.setText(clearBtn, 'Clear');
    actions.appendChild(uploadBtn); actions.appendChild(clearBtn);
    fileSection.appendChild(actions);
    var statusEl = msg('up-status muted', '');
    fileSection.appendChild(statusEl);
    var summaryArea = el('div', 'up-summary');
    fileSection.appendChild(summaryArea);

    // State: current File objects (not yet encoded) + a busy flag.
    var files = [];
    var busy = false;
    var staffByBranch = {};
    var loadingStaff = {};
    var savedSelected = {};
    var savedItemsState = [];
    var staffMsg = null;

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
        savedSelected = {};
        staffMsg = null;
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
      savedItemsState = vm.savedItems || [];

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

      // QA report #1: show WHAT was actually read off each saved receipt (merchant,
      // amount, category, reference number) instead of a bare count — a clean "1 saved"
      // with nothing else read as "maybe it didn't upload" / "did it read this right?".
      if (vm.savedItems.length) {
        summaryArea.appendChild(textHead('up-list-title', 'Saved'));
        if (staffMsg) summaryArea.appendChild(msg('up-staff-msg', staffMsg));
        var staffHost = el('div', 'up-staff-host');
        summaryArea.appendChild(staffHost);
        renderStaffGrid(staffHost);
        loadStaffForSavedItems(staffHost);
        if (switchView) {
          var viewBtn = el('button', 'up-view-activity');
          viewBtn.type = 'button';
          Escape.setText(viewBtn, 'View in Activity');
          viewBtn.addEventListener('click', function () { switchView('activity'); });
          summaryArea.appendChild(viewBtn);
        }
      }

      if (vm.flaggedCount) {
        summaryArea.appendChild(textHead('up-list-title', 'Flagged for review'));
        var fl = el('ul', 'up-result-list');
        vm.flagged.forEach(function (f) {
          var li = el('li', 'up-result up-result--flagged');
          var display = flaggedDisplay(f);
          Escape.setText(li, display.text);   // merchant/reason/id are untrusted -> escaped
          if (display.duplicate && (switchView || (apiFetch && f.expense_id))) {
            var actions = el('span', 'up-flag-actions');
            if (switchView) {
              var viewDup = el('button', 'up-flag-action');
              viewDup.type = 'button';
              Escape.setText(viewDup, 'View');
              viewDup.addEventListener('click', function () { switchView('activity'); });
              actions.appendChild(viewDup);
            }
            if (apiFetch && f.expense_id) {
              var discard = el('button', 'up-flag-action up-flag-action--discard');
              discard.type = 'button';
              Escape.setText(discard, 'Discard');
              discard.addEventListener('click', function () {
                discard.disabled = true;
                apiFetch('/api/review/' + encodeURIComponent(f.expense_id), {
                  method: 'POST',
                  body: { decision: 'reject', note: 'discarded from upload duplicate prompt' },
                }).then(function () {
                  Escape.setText(discard, 'Discarded');
                }).catch(function () {
                  discard.disabled = false;
                  Escape.setText(discard, 'Try again');
                });
              });
              actions.appendChild(discard);
            }
            li.appendChild(actions);
          }
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

    function loadStaffForSavedItems(host) {
      if (!apiFetch) return;
      branchIdsForSavedItems(savedItemsState).forEach(function (branchId) {
        if (!branchId || staffByBranch[branchId] || loadingStaff[branchId]) return;
        loadingStaff[branchId] = true;
        apiFetch('/api/branches/' + encodeURIComponent(branchId) + '/staff').then(function (resp) {
          staffByBranch[branchId] = normalizeStaff(resp);
        }).catch(function () {
          staffByBranch[branchId] = [];
        }).then(function () {
          loadingStaff[branchId] = false;
          renderStaffGrid(host);
        });
      });
    }

    function staffName(branchId, staffId) {
      var rows = staffByBranch[String(branchId || '')] || [];
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].id) === String(staffId)) return rows[i].display_name;
      }
      return staffId ? String(staffId) : 'Unassigned';
    }

    function fillStaffSelect(sel, branchId, currentId) {
      var empty = document.createElement('option');
      empty.value = '';
      Escape.setText(empty, 'Unassigned');
      sel.appendChild(empty);
      (staffByBranch[String(branchId || '')] || []).forEach(function (s) {
        var opt = document.createElement('option');
        opt.value = s.id;
        Escape.setText(opt, s.display_name);
        sel.appendChild(opt);
      });
      sel.value = currentId || '';
    }

    function savedLine(it) {
      var line = str(it && it.merchant) || 'Receipt';
      if (it && it.amount != null) line += ' — ' + (Format ? Format.formatMoney(it.amount) : str(it.amount)) + ' ' + str(it.currency);
      if (it && it.category) line += ' · ' + str(it.category);
      if (it && it.voucher_no) line += ' · ' + str(it.voucher_no);
      return line;
    }

    function renderStaffGrid(host) {
      clear(host);
      if (!savedItemsState.length) return;
      var selectedIds = Object.keys(savedSelected).filter(function (id) { return savedSelected[id]; });
      var branchId = selectedBranchId(savedItemsState, savedSelected);

      var bulk = el('div', 'up-staff-bulk');
      bulk.appendChild(textSpan('up-staff-bulk-label', selectedIds.length + ' selected'));
      var bulkSelect = el('select', 'up-staff-bulk-select');
      fillStaffSelect(bulkSelect, branchId || '', '');
      bulkSelect.disabled = !selectedIds.length || branchId === null || !branchId;
      if (branchId === null) {
        clear(bulkSelect);
        var mixed = document.createElement('option');
        mixed.value = '';
        Escape.setText(mixed, 'Pick rows from one branch');
        bulkSelect.appendChild(mixed);
      }
      bulkSelect.addEventListener('change', function () {
        if (!selectedIds.length || bulkSelect.disabled) return;
        assignStaff(selectedIds, bulkSelect.value || null, host);
      });
      bulk.appendChild(bulkSelect);
      host.appendChild(bulk);

      var table = el('table', 'up-staff-table');
      var thead = document.createElement('thead');
      var hr = document.createElement('tr');
      ['Select', 'Receipt', 'Staff'].forEach(function (label) {
        var th = document.createElement('th'); Escape.setText(th, label); hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = document.createElement('tbody');
      savedItemsState.forEach(function (it) {
        var tr = document.createElement('tr');
        var tdSel = document.createElement('td');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!savedSelected[it.id];
        cb.addEventListener('change', function () {
          savedSelected[it.id] = cb.checked;
          renderStaffGrid(host);
        });
        tdSel.appendChild(cb);
        tr.appendChild(tdSel);

        var tdReceipt = document.createElement('td');
        Escape.setText(tdReceipt, savedLine(it));
        tr.appendChild(tdReceipt);

        var tdStaff = document.createElement('td');
        var sel = el('select', 'up-staff-select');
        fillStaffSelect(sel, it.branch_id || '', it.staff_user_id || '');
        sel.disabled = !it.branch_id || loadingStaff[String(it.branch_id || '')];
        sel.addEventListener('change', function () {
          assignStaff([it.id], sel.value || null, host);
        });
        tdStaff.appendChild(sel);
        tdStaff.appendChild(textSpan('up-staff-current muted', staffName(it.branch_id, it.staff_user_id)));
        tr.appendChild(tdStaff);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      host.appendChild(table);
    }

    function assignStaff(ids, staffId, host) {
      if (!apiFetch || !ids.length) return;
      staffMsg = 'Assigning staff…';
      renderStaffGrid(host);
      apiFetch('/api/expenses', { method: 'PATCH', body: { ids: ids, staff_user_id: staffId == null ? null : String(staffId) } }).then(function (resp) {
        applyStaffAssignResult(savedItemsState, ids, staffId, resp);
        savedSelected = {};
        staffMsg = 'Updated ' + (resp && resp.updated != null ? resp.updated : ids.length) + ' receipt(s).';
        renderStaffGrid(host);
      }).catch(function () {
        staffMsg = 'Could not assign staff. Please try again.';
        renderStaffGrid(host);
      });
    }

    // ---- "Enter manually" section (QA 2026-07-14) --------------------------------
    var manualSection = el('div', 'up-manual-section');
    rootEl.appendChild(manualSection);

    var manualCategories = resolveManualCategories(opts.config);
    var defaultCurrency = (opts.config && typeof opts.config.default_currency === 'string' && opts.config.default_currency) || '';

    function manualField(labelText, inputEl) {
      var wrap = el('label', 'up-manual-field');
      var lab = el('span', 'up-manual-label'); Escape.setText(lab, labelText); wrap.appendChild(lab);
      wrap.appendChild(inputEl);
      return wrap;
    }

    var manualForm = el('form', 'up-manual-form');

    var manualMerchant = el('input', 'up-manual-input');
    manualMerchant.type = 'text';
    manualMerchant.setAttribute('aria-label', 'Merchant');
    manualForm.appendChild(manualField('Merchant', manualMerchant));

    var manualDate = el('input', 'up-manual-input');
    manualDate.type = 'date';
    manualDate.setAttribute('aria-label', 'Date');
    manualForm.appendChild(manualField('Date', manualDate));

    var manualAmount = el('input', 'up-manual-input');
    manualAmount.type = 'number';
    manualAmount.step = 'any';
    manualAmount.setAttribute('aria-label', 'Amount');
    manualForm.appendChild(manualField('Amount', manualAmount));

    var manualCurrency = el('input', 'up-manual-input');
    manualCurrency.type = 'text';
    manualCurrency.value = defaultCurrency;
    manualCurrency.setAttribute('aria-label', 'Currency');
    manualForm.appendChild(manualField('Currency', manualCurrency));

    var manualCategory = el('select', 'up-manual-input');
    manualCategory.setAttribute('aria-label', 'Category');
    manualCategories.forEach(function (c) {
      var o = el('option'); o.value = c; Escape.setText(o, c); manualCategory.appendChild(o);
    });
    manualForm.appendChild(manualField('Category', manualCategory));

    var manualRemark = el('input', 'up-manual-input');
    manualRemark.type = 'text';
    manualRemark.setAttribute('aria-label', 'Remark (optional)');
    manualForm.appendChild(manualField('Remark', manualRemark));

    var manualSaveBtn = el('button', 'up-manual-save'); manualSaveBtn.type = 'submit'; Escape.setText(manualSaveBtn, 'Save');
    manualForm.appendChild(manualSaveBtn);
    manualSection.appendChild(manualForm);

    var manualStatus = msg('up-manual-status muted', '');
    manualSection.appendChild(manualStatus);

    function resetManualForm() {
      manualMerchant.value = '';
      manualDate.value = '';
      manualAmount.value = '';
      manualCurrency.value = defaultCurrency;
      manualCategory.value = manualCategories[0] || '';
      manualRemark.value = '';
    }
    resetManualForm();

    var manualBusy = false;
    manualForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (manualBusy || !apiFetch) return;
      var v = validateManualEntry({
        merchant: manualMerchant.value, expense_date: manualDate.value, amount: manualAmount.value,
        currency: manualCurrency.value, category: manualCategory.value, remark: manualRemark.value,
      });
      if (!v.ok) { Escape.setText(manualStatus, v.error); return; }
      manualBusy = true;
      manualSaveBtn.disabled = true;
      Escape.setText(manualStatus, 'Saving…');
      apiFetch('/api/expenses', { method: 'POST', body: v.body }).then(function (resp) {
        manualBusy = false;
        manualSaveBtn.disabled = false;
        var savedMerchant = (resp && typeof resp.merchant === 'string' && resp.merchant) || v.body.merchant;
        Escape.setText(manualStatus, 'Saved: ' + savedMerchant + '.');
        resetManualForm();
      }).catch(function (err) {
        manualBusy = false;
        manualSaveBtn.disabled = false;
        var status = err && typeof err === 'object' ? err.status : 0;
        var body = err && typeof err === 'object' ? err.body : null;
        Escape.setText(manualStatus, manualErrorMessage(status, body));
      });
    });

    // ---- mode toggle wiring --------------------------------------------------------
    function setMode(mode) {
      uploadMode = normaliseUploadMode(mode);
      fileSection.hidden = uploadMode !== 'file';
      manualSection.hidden = uploadMode !== 'manual';
      fileModeBtn.classList.toggle('is-active', uploadMode === 'file');
      manualModeBtn.classList.toggle('is-active', uploadMode === 'manual');
      fileModeBtn.setAttribute('aria-pressed', String(uploadMode === 'file'));
      manualModeBtn.setAttribute('aria-pressed', String(uploadMode === 'manual'));
    }
    fileModeBtn.addEventListener('click', function () { setMode('file'); });
    manualModeBtn.addEventListener('click', function () { setMode('manual'); });
    setMode('file');

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
    branchIdsForSavedItems: branchIdsForSavedItems,
    selectedBranchId: selectedBranchId,
    normalizeStaff: normalizeStaff,
    applyStaffAssignResult: applyStaffAssignResult,
    flaggedDisplay: flaggedDisplay,
    MASS_MAX_IMAGES: MASS_MAX_IMAGES,
    normaliseUploadMode: normaliseUploadMode,
    resolveManualCategories: resolveManualCategories,
    validateManualEntry: validateManualEntry,
    manualErrorMessage: manualErrorMessage,
    // render (browser)
    mount: mount,
  };
});

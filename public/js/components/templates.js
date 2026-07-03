// components/templates.js — the Templates screen (Task E): paste/import a CSV
// to define the account's FieldSpec, and view the current FieldSpec.
// GET/POST /api/templates render server-sanitized-but-still-treated-as-untrusted
// text (FieldSpec column keys/labels come from the CUSTOMER'S CSV — SOP §7.3) —
// Iron rule (same as upload.js/activity.js): every value put in the DOM goes
// through Escape.setText / Escape.safeText; we NEVER assign innerHTML from data.
//
// TWO layers, kept apart so the logic is unit-testable without a DOM:
//   1. PURE helpers — buildImportBody / summarizeFieldSpec / errorMessage. No
//      DOM, no network, no escaping (render owns escaping), never throw on junk.
//      Covered by tests/frontend/templates.test.js.
//   2. RENDER layer (mount + form/table) — real DOM + browser-only APIs
//      (document, FileReader). No-ops outside a browser.
//
// Endpoint contract (read from routes/templates.js + lib/templates.js):
//   GET  /api/templates  -> 200 FieldSpec { account_id, columns:[{key,label,
//                           type,required}], updated_at } — ALWAYS 200, falls
//                           back to a DEFAULT column set when nothing imported
//                           yet (getFieldSpec in lib/templates.js), so there is
//                           no true "empty" state to render, just the default.
//   POST /api/templates  body: JSON { csv, name? } (or raw text/csv — we always
//                        send JSON here, matching the route's JSON body path).
//     200 -> the resulting FieldSpec (same shape as GET).
//     400 -> { error: '<safe, pre-sanitized, SHOW-VERBATIM string>' } — either
//            "provide CSV text (text/csv body, or JSON {\"csv\": \"...\"})" or a
//            parseTemplate:/saveTemplate:-prefixed validation message. UNLIKE
//            upload.js's errorMessage, these ARE shown to the user (reject-and-
//            explain, per the plan) — still routed through Escape at render time
//            for defense in depth.
//     502 -> { error: 'load failed' } / { error: 'save failed' } — generic
//            upstream failure; body text ignored, fixed friendly message shown
//            (house convention: never surface 5xx internals).
//     400 (malformed body, e.g. bad JSON) -> route-local { error: 'malformed
//            request body' } — same generic-400-per-context handling as any
//            other 400 without a usable body.error string.
//
// UMD shim: window.Templates in the browser; require()-able in Node (the render
// layer simply isn't exercised there — no document / FileReader).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../escape'), require('../api'));
  } else {
    root.Templates = factory(root.Escape, root.Api);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape, Api) {
  'use strict';

  // ---- pure helpers -------------------------------------------------------

  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  // Build the POST body from the pasted/loaded CSV text + an optional template
  // name. Trims csvText; blank (after trim) -> {ok:false, reason:'empty'}. Name
  // defaults to 'default' when blank/omitted, and is always trimmed. Never throws.
  function buildImportBody(csvText, name) {
    var csv = typeof csvText === 'string' ? csvText : str(csvText);
    var trimmedCsv = csv.trim();
    if (trimmedCsv === '') return { ok: false, reason: 'empty' };

    var rawName = typeof name === 'string' ? name : str(name);
    var trimmedName = rawName.trim();
    return { ok: true, csv: csv, name: trimmedName !== '' ? trimmedName : 'default' };
  }

  // Reduce a FieldSpec response { account_id, columns:[...], updated_at } to a
  // view model for the render layer. Tolerates null/garbage input — never
  // throws; falls back to safe defaults (columns: [], count: 0) if the shape
  // is off. Escaping is deliberately NOT done here (render owns it).
  function summarizeFieldSpec(spec) {
    var s = isPlainObject(spec) ? spec : {};
    var columns = Array.isArray(s.columns) ? s.columns : [];
    return {
      accountId: s.account_id !== undefined ? s.account_id : null,
      columns: columns,
      count: columns.length,
      updatedAt: s.updated_at !== undefined ? s.updated_at : null,
    };
  }

  // Map an HTTP status + parsed body to a display message.
  //   400: body.error IS shown verbatim when it is a string (server already
  //        sanitized it — this is the "reject-and-explain" the plan asks for).
  //        Falls back to a generic message if body.error isn't usable.
  //   502/other: fixed generic message per context ('load' | 'save') — body
  //        text is intentionally ignored (house convention: never surface 5xx
  //        internals to the user).
  // Never throws, even on a garbage body (array/string/number/null).
  function errorMessage(status, body, context) {
    var ctx = context === 'load' ? 'load' : 'save';
    var generic = ctx === 'load'
      ? 'Could not load the template. Please try again.'
      : 'Could not save the template. Please try again.';

    if (Number(status) === 400) {
      var reason = isPlainObject(body) ? body.error : null;
      if (typeof reason === 'string' && reason.trim() !== '') return reason;
      return generic;
    }
    return generic;
  }

  // ---- DOM helpers (browser only) -----------------------------------------

  function hasDom() { return typeof document !== 'undefined'; }
  function hasFileReader() { return typeof FileReader !== 'undefined'; }
  function el(tag, className) { var n = document.createElement(tag); if (className) n.className = className; return n; }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function msg(className, text) { var p = el('p', className); Escape.setText(p, text); return p; }

  function renderFieldSpecTable(vm) {
    var wrap = el('div', 'tp-spec');

    var meta = el('p', 'tp-spec-meta muted');
    Escape.setText(meta, vm.count + ' field(s)' + (vm.updatedAt ? ' — last updated ' + str(vm.updatedAt) : ' — showing the default field set'));
    wrap.appendChild(meta);

    if (!vm.columns.length) {
      wrap.appendChild(msg('tp-empty', 'No template imported yet — showing the default field set.'));
      return wrap;
    }

    var table = el('table', 'tp-table');
    var thead = el('thead');
    var headRow = el('tr');
    ['Key', 'Label', 'Type', 'Required'].forEach(function (h) {
      var th = el('th');
      Escape.setText(th, h);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    vm.columns.forEach(function (c) {
      var col = isPlainObject(c) ? c : {};
      var tr = el('tr');

      var tdKey = el('td');
      Escape.setText(tdKey, str(col.key));
      tr.appendChild(tdKey);

      var tdLabel = el('td');
      Escape.setText(tdLabel, str(col.label));   // untrusted (customer CSV) -> escaped
      tr.appendChild(tdLabel);

      var tdType = el('td');
      Escape.setText(tdType, str(col.type));
      tr.appendChild(tdType);

      var tdReq = el('td');
      var badge = el('span', 'tp-badge ' + (col.required ? 'tp-badge--required' : 'tp-badge--optional'));
      Escape.setText(badge, col.required ? 'Required' : 'Optional');
      tdReq.appendChild(badge);
      tr.appendChild(tdReq);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  // Read a File as plain text (for the optional CSV file picker). Resolves the
  // text content, or rejects.
  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      if (!hasFileReader()) { reject(new Error('no FileReader')); return; }
      var fr = new FileReader();
      fr.onload = function () { resolve(str(fr.result)); };
      fr.onerror = function () { reject(fr.error || new Error('read failed')); };
      fr.readAsText(file);
    });
  }

  // ---- render layer --------------------------------------------------------

  function mount(section, opts) {
    if (!hasDom() || !section) return null;
    opts = opts || {};
    var apiFetch = opts.apiFetch || (opts.Api && opts.Api.apiFetch) || (Api && Api.apiFetch);

    var rootEl = el('div', 'tp-root');
    section.appendChild(rootEl);

    rootEl.appendChild(msg('tp-intro muted', 'Import a CSV to define your field template, or view the current one.'));

    // Current FieldSpec area.
    var specArea = el('div', 'tp-spec-area');
    rootEl.appendChild(specArea);

    // Import form: textarea (primary) + optional file picker + name input + submit.
    var form = el('form', 'tp-form');

    var textareaLabel = el('label', 'tp-form-label');
    textareaLabel.setAttribute('for', 'tp-csv-textarea');
    Escape.setText(textareaLabel, 'Paste CSV (header row = your field names)');
    form.appendChild(textareaLabel);

    var textarea = el('textarea', 'tp-csv-textarea');
    textarea.id = 'tp-csv-textarea';
    textarea.rows = 6;
    form.appendChild(textarea);

    var fileLabel = el('label', 'tp-form-label');
    fileLabel.setAttribute('for', 'tp-csv-file');
    Escape.setText(fileLabel, 'Or choose a CSV file');
    form.appendChild(fileLabel);

    var fileInput = el('input', 'tp-csv-file');
    fileInput.type = 'file';
    fileInput.id = 'tp-csv-file';
    fileInput.setAttribute('accept', '.csv,text/csv');
    form.appendChild(fileInput);

    var nameLabel = el('label', 'tp-form-label');
    nameLabel.setAttribute('for', 'tp-name-input');
    Escape.setText(nameLabel, 'Template name (optional)');
    form.appendChild(nameLabel);

    var nameInput = el('input', 'tp-name-input');
    nameInput.type = 'text';
    nameInput.id = 'tp-name-input';
    nameInput.setAttribute('placeholder', 'default');
    form.appendChild(nameInput);

    var submitBtn = el('button', 'tp-submit');
    submitBtn.type = 'submit';
    Escape.setText(submitBtn, 'Import template');
    form.appendChild(submitBtn);

    var statusEl = msg('tp-status muted', '');
    form.appendChild(statusEl);

    rootEl.appendChild(form);

    var busy = false;

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      readFileAsText(file).then(function (text) {
        textarea.value = text;
      }).catch(function () {
        Escape.setText(statusEl, 'Could not read that file. Please paste the CSV text instead.');
      });
    });

    function setBusy(b) {
      busy = b;
      submitBtn.disabled = b;
    }

    function renderSpec(spec) {
      clear(specArea);
      specArea.appendChild(renderFieldSpecTable(summarizeFieldSpec(spec)));
    }

    function loadCurrent() {
      if (!apiFetch) return;
      clear(specArea);
      specArea.appendChild(msg('tp-loading muted', 'Loading current template…'));
      return apiFetch('/api/templates').then(function (spec) {
        renderSpec(spec);
      }).catch(function (err) {
        var status = err && typeof err === 'object' ? err.status : 0;
        var body = err && typeof err === 'object' ? err.body : null;
        clear(specArea);
        specArea.appendChild(msg('tp-error', errorMessage(status, body, 'load')));
      });
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (busy || !apiFetch) return;

      var built = buildImportBody(textarea.value, nameInput.value);
      if (!built.ok) {
        Escape.setText(statusEl, 'Please paste or choose a CSV file before importing.');
        return;
      }

      setBusy(true);
      Escape.setText(statusEl, 'Importing…');
      apiFetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { csv: built.csv, name: built.name },
      }).then(function (spec) {
        setBusy(false);
        Escape.setText(statusEl, 'Template imported.');
        renderSpec(spec);
      }).catch(function (err) {
        setBusy(false);
        var status = err && typeof err === 'object' ? err.status : 0;
        var body = err && typeof err === 'object' ? err.body : null;
        Escape.setText(statusEl, errorMessage(status, body, 'save'));
      });
    });

    // Lazy-load on first view (mirrors overview.js's load-on-first-show pattern).
    var state = { loaded: false, loading: false };
    function load() {
      if (state.loading || state.loaded || !apiFetch) return;
      state.loading = true;
      var p = loadCurrent();
      if (p && typeof p.then === 'function') {
        p.then(function () { state.loading = false; state.loaded = true; })
         .catch(function () { state.loading = false; }); // leave loaded=false so a revisit can retry
      } else {
        state.loading = false;
      }
    }

    return { el: rootEl, load: load };
  }

  return {
    // pure
    buildImportBody: buildImportBody,
    summarizeFieldSpec: summarizeFieldSpec,
    errorMessage: errorMessage,
    // render (browser)
    mount: mount,
  };
});

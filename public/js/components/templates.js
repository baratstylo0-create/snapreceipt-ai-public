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
    module.exports = factory(require('../escape'), require('../api'), require('../i18n'));
  } else {
    root.Templates = factory(root.Escape, root.Api, root.I18n);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape, Api, I18n) {
  'use strict';

  var t = (I18n && I18n.t) || function (k) { return k; };
  var tp = (I18n && I18n.tp) || function (k) { return k; };

  // ---- pure helpers -------------------------------------------------------

  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  // Human-facing field name for the template view: prefer the label; if only a machine key
  // exists, prettify it ("and_how_much" -> "And how much") so non-technical staff never see
  // raw snake_case. Pure/deterministic — returns '' for an empty field.
  function fieldDisplayName(col) {
    col = isPlainObject(col) ? col : {};
    var label = str(col.label).trim();
    if (label) return label;
    var key = str(col.key).trim();
    if (!key) return '';
    var words = key.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
  }

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

  // ---- visual field builder (additive) ------------------------------------
  // Lets a customer with zero CSV knowledge build the field list visually:
  // a list of {name, type, required} rows -> a CSV header row (buildCsvHeader)
  // -> fed into the SAME buildImportBody/POST path the paste/upload flow uses.
  //
  // IMPORTANT, read from lib/templates.js's parseTemplate (Barat's file, READ
  // ONLY): a CSV import is HEADER-ROW-ONLY — it can only carry field NAMES.
  // type/required on the resulting FieldSpec column come from parseTemplate's
  // CANON dictionary (matched against the normalised name) or default to
  // text/not-required for an unrecognised name. The client's type-select and
  // required-checkbox are NEVER read by the server. So buildCsvHeader only
  // ever emits names — it does NOT and cannot encode type/required. The
  // builder UI is honest about this (see the inline note rendered near the
  // type/required controls).

  var FIELD_TYPES = ['text', 'date', 'number', 'currency', 'category'];

  // Keep only rows with a non-blank (after trim) string name. Tolerates
  // null/garbage input and null/garbage entries — never throws.
  function namedFields(fields) {
    var list = Array.isArray(fields) ? fields : [];
    return list.filter(function (f) {
      return isPlainObject(f) && typeof f.name === 'string' && f.name.trim() !== '';
    });
  }

  // CSV-escape a single field per ordinary CSV quoting rules: wrap in double
  // quotes (doubling any internal quotes) if the value contains a comma,
  // double quote, or newline; otherwise leave it bare.
  function csvEscape(value) {
    var v = str(value);
    if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }

  // buildCsvHeader(fields) -> CSV header-row string built from field NAMES
  // only (type/required are not carried — see note above). Skips blank-name
  // rows. Empty result (no named fields) -> '' (defined sentinel: nothing to
  // save). Never throws on garbage input.
  function buildCsvHeader(fields) {
    return namedFields(fields).map(function (f) { return csvEscape(f.name); }).join(',');
  }

  // Pure validation backing the "Save template" button: at least one row
  // with a non-blank name is required. Never throws.
  function canSaveBuilder(fields) {
    return namedFields(fields).length > 0;
  }

  // ---- category editor (additive, ADR-021 business category set) ---------
  // A second, independent visual builder for FieldSpec.categories (the chart of
  // accounts shown in the receipt dropdown, the bot's category picker, and the
  // Statement export's numbered sections — order matters there).
  //
  // 2026-07-09 (independent-review finding #4): this used to resend a locally-cached
  // snapshot of the current columns alongside every categories save, because
  // POST /api/templates always overwrote `columns` from whatever csv it was given.
  // That meant a stale/racing snapshot could silently revert a concurrent columns
  // save. Fixed at the SERVER (routes/templates.js + lib/templates.js's new
  // saveCategories()): a JSON body with `categories` and no `csv` is now a TRUE
  // partial update that never reads or writes `columns` at all. The client no
  // longer needs to track or resend columns for a categories-only save — see
  // submitCategories below.

  // Trim + drop blank rows. Unlike the server's sanitizeCategories, this does NOT
  // dedupe/cap/append 'Others' — that stays server-side (single source of truth);
  // this only prepares what the user typed for the wire. Never throws.
  function namedCategoryNames(names) {
    var list = Array.isArray(names) ? names : [];
    return list.map(str).map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
  }

  // QA report #4: importing a real .xlsx used to get read via FileReader.readAsText,
  // which garbles binary bytes into a string; POSTing that garbage broke JSON.parse
  // server-side, surfacing only "malformed request body" — a dead end for the user.
  // Real .xlsx is now properly supported (readFileAsArrayBuffer + isExcelFile below) —
  // this blocklist now only covers formats we genuinely can't read (legacy .xls/.xlsm,
  // Word/PDF/images/zip). Never throws on a garbage/missing file.
  var NON_CSV_EXTENSIONS = ['xls', 'xlsm', 'docx', 'doc', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'zip'];
  function isNonCsvFile(file) {
    if (!file) return false;
    var name = str(file.name);
    var m = /\.([a-z0-9]+)$/i.exec(name);
    var ext = m ? m[1].toLowerCase() : '';
    if (ext === 'csv' || ext === 'xlsx') return false;
    if (NON_CSV_EXTENSIONS.indexOf(ext) !== -1) return true;
    var type = str(file.type);
    return type !== '' && type !== 'text/csv' && type !== 'text/plain' && type.indexOf('text/') !== 0
      && type !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
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
      ? t('templates.load_failed')
      : t('templates.save_failed');

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

  // Small centered popup confirm (Owner request 2026-07-05: "make the confirm
  // message also as a popup window" — replaces the earlier inline two-click
  // button state). Appended to document.body so it always sits centered over
  // the whole page regardless of scroll position. Dismiss via Cancel, clicking
  // the dimmed backdrop, or Escape; onConfirm only fires on the explicit
  // confirm button.
  function showConfirmDialog(message, confirmLabel, onConfirm) {
    if (!hasDom()) return;
    var overlay = el('div', 'tp-confirm-host');
    var card = el('div', 'tp-confirm-card');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    card.appendChild(msg('tp-confirm-msg', message));

    var actions = el('div', 'tp-confirm-actions');
    var cancelBtn = el('button', 'tp-confirm-cancel'); cancelBtn.type = 'button';
    Escape.setText(cancelBtn, t('templates.cancel'));
    var confirmBtn = el('button', 'tp-confirm-ok'); confirmBtn.type = 'button';
    Escape.setText(confirmBtn, confirmLabel || t('templates.confirm'));
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function onKeydown(ev) { if (ev.key === 'Escape') close(); }
    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener('keydown', onKeydown);
    }
    document.addEventListener('keydown', onKeydown);
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
    cancelBtn.addEventListener('click', close);
    confirmBtn.addEventListener('click', function () { close(); onConfirm(); });
    confirmBtn.focus();
  }

  function renderFieldSpecTable(vm) {
    var wrap = el('div', 'tp-spec');

    var meta = el('p', 'tp-spec-meta muted');
    Escape.setText(meta, tp('templates.field_count', vm.count) + (vm.updatedAt ? tp('templates.last_updated', str(vm.updatedAt)) : t('templates.showing_default')));
    wrap.appendChild(meta);

    if (!vm.columns.length) {
      wrap.appendChild(msg('tp-empty', t('templates.no_template_imported')));
      return wrap;
    }

    var table = el('table', 'tp-table');
    var thead = el('thead');
    var headRow = el('tr');
    // Non-technical staff only ever see the human-readable field name — the machine `key`
    // (e.g. "and_how_much") is intentionally NOT shown here. It's still used under the hood
    // for OCR/DB; this view is for people, not engineers.
    [t('templates.col_field'), t('templates.col_type'), t('templates.col_required')].forEach(function (h) {
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

      var tdLabel = el('td');
      // Show the human label; if a template ever has only a machine key, prettify it
      // ("and_how_much" -> "And how much") so staff never see raw snake_case. Untrusted
      // (customer CSV) -> escaped via Escape.setText.
      Escape.setText(tdLabel, fieldDisplayName(col));
      tr.appendChild(tdLabel);

      var tdType = el('td');
      Escape.setText(tdType, str(col.type));
      tr.appendChild(tdType);

      var tdReq = el('td');
      var badge = el('span', 'tp-badge ' + (col.required ? 'tp-badge--required' : 'tp-badge--optional'));
      Escape.setText(badge, col.required ? t('templates.required') : t('templates.optional'));
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

  // Read a File as raw bytes (for a real .xlsx upload — reading it as text
  // would corrupt the binary, same reasoning as the QA #4 fix above). Resolves
  // an ArrayBuffer, or rejects.
  function readFileAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      if (!hasFileReader()) { reject(new Error('no FileReader')); return; }
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('read failed')); };
      fr.readAsArrayBuffer(file);
    });
  }

  // A real Excel file, by extension — kept separate from isNonCsvFile's
  // blocklist so both stay simple: this is a small allowlist of "we now know
  // how to read this one", that one is "definitely refuse these".
  function isExcelFile(file) {
    if (!file) return false;
    var name = str(file.name);
    return /\.xlsx$/i.test(name);
  }

  // ---- render layer --------------------------------------------------------

  // Build one "field row" of the visual builder: order handle (up/down), name
  // input, type select, required checkbox, remove button. Returns
  // { el, getField(), setBusy(b), setMoveEnabled(canUp, canDown) }.
  //
  // Remove is a two-step confirm (same inline pattern as Activity's delete
  // button, act-delete/is-confirming — no native confirm() dialog, CSP/UX
  // consistent) so an accidental click on "Remove" no longer hard-deletes a
  // row with zero warning. onMove(rowApi, delta) shifts this row's position in
  // the rows array (delta -1/+1), which IS the CSV column order left-to-right
  // (buildCsvHeader emits fields in array order).
  function buildFieldRow(onRemove, onMove, initial) {
    var seed = isPlainObject(initial) ? initial : {};
    var row = el('div', 'tp-fb-row');

    var moveWrap = el('div', 'tp-fb-move');
    var upBtn = el('button', 'tp-fb-move-btn'); upBtn.type = 'button';
    upBtn.setAttribute('aria-label', t('templates.move_field_up')); upBtn.title = t('templates.move_up');
    Escape.setText(upBtn, '▲');
    var downBtn = el('button', 'tp-fb-move-btn'); downBtn.type = 'button';
    downBtn.setAttribute('aria-label', t('templates.move_field_down')); downBtn.title = t('templates.move_down');
    Escape.setText(downBtn, '▼');
    upBtn.addEventListener('click', function () { onMove(rowApi, -1); });
    downBtn.addEventListener('click', function () { onMove(rowApi, 1); });
    moveWrap.appendChild(upBtn); moveWrap.appendChild(downBtn);
    row.appendChild(moveWrap);

    var nameInput = el('input', 'tp-fb-name');
    nameInput.type = 'text';
    nameInput.setAttribute('placeholder', t('templates.field_name_placeholder'));
    nameInput.value = typeof seed.label === 'string' ? seed.label : (typeof seed.name === 'string' ? seed.name : '');
    row.appendChild(nameInput);

    var typeSelect = el('select', 'tp-fb-type');
    FIELD_TYPES.forEach(function (t) {
      var opt = el('option');
      opt.value = t;
      Escape.setText(opt, t);
      typeSelect.appendChild(opt);
    });
    typeSelect.value = FIELD_TYPES.indexOf(seed.type) !== -1 ? seed.type : 'text';
    row.appendChild(typeSelect);

    var reqLabel = el('label', 'tp-fb-required');
    var reqCheckbox = el('input');
    reqCheckbox.type = 'checkbox';
    reqCheckbox.checked = !!seed.required;
    reqLabel.appendChild(reqCheckbox);
    var reqText = el('span');
    Escape.setText(reqText, t('templates.required'));
    reqLabel.appendChild(reqText);
    row.appendChild(reqLabel);

    var removeBtn = el('button', 'tp-fb-remove');
    removeBtn.type = 'button';
    Escape.setText(removeBtn, t('templates.remove'));
    removeBtn.addEventListener('click', function () {
      var name = nameInput.value.trim();
      showConfirmDialog(
        name ? tp('templates.remove_field_named', name) : t('templates.remove_field_generic'),
        t('templates.remove_field'),
        function () { onRemove(rowApi); }
      );
    });
    row.appendChild(removeBtn);

    var moveState = { canUp: true, canDown: true };
    var rowApi = {
      el: row,
      getField: function () {
        return { name: nameInput.value, type: typeSelect.value, required: reqCheckbox.checked };
      },
      setBusy: function (b) {
        nameInput.disabled = b; typeSelect.disabled = b; reqCheckbox.disabled = b; removeBtn.disabled = b;
        upBtn.disabled = b || !moveState.canUp;
        downBtn.disabled = b || !moveState.canDown;
      },
      setMoveEnabled: function (canUp, canDown) {
        moveState.canUp = !!canUp; moveState.canDown = !!canDown;
        upBtn.disabled = !canUp;
        downBtn.disabled = !canDown;
      },
    };
    return rowApi;
  }

  // Category-editor counterpart to buildFieldRow above — same move/remove
  // mechanics, minus type/required (a category is just a name). Returns
  // { el, getName(), setBusy(b), setMoveEnabled(canUp, canDown) }.
  function buildCategoryRow(onRemove, onMove, initialName) {
    var row = el('div', 'tp-fb-row');

    var moveWrap = el('div', 'tp-fb-move');
    var upBtn = el('button', 'tp-fb-move-btn'); upBtn.type = 'button';
    upBtn.setAttribute('aria-label', t('templates.move_category_up')); upBtn.title = t('templates.move_up');
    Escape.setText(upBtn, '▲');
    var downBtn = el('button', 'tp-fb-move-btn'); downBtn.type = 'button';
    downBtn.setAttribute('aria-label', t('templates.move_category_down')); downBtn.title = t('templates.move_down');
    Escape.setText(downBtn, '▼');
    upBtn.addEventListener('click', function () { onMove(rowApi, -1); });
    downBtn.addEventListener('click', function () { onMove(rowApi, 1); });
    moveWrap.appendChild(upBtn); moveWrap.appendChild(downBtn);
    row.appendChild(moveWrap);

    var nameInput = el('input', 'tp-fb-name');
    nameInput.type = 'text';
    nameInput.setAttribute('placeholder', t('templates.category_name_placeholder'));
    nameInput.value = typeof initialName === 'string' ? initialName : '';
    row.appendChild(nameInput);

    var removeBtn = el('button', 'tp-fb-remove');
    removeBtn.type = 'button';
    Escape.setText(removeBtn, t('templates.remove'));
    removeBtn.addEventListener('click', function () {
      var name = nameInput.value.trim();
      showConfirmDialog(
        name ? tp('templates.remove_category_named', name) : t('templates.remove_category_generic'),
        t('templates.remove_category'),
        function () { onRemove(rowApi); }
      );
    });
    row.appendChild(removeBtn);

    var moveState = { canUp: true, canDown: true };
    var rowApi = {
      el: row,
      getName: function () { return nameInput.value; },
      setBusy: function (b) {
        nameInput.disabled = b; removeBtn.disabled = b;
        upBtn.disabled = b || !moveState.canUp;
        downBtn.disabled = b || !moveState.canDown;
      },
      setMoveEnabled: function (canUp, canDown) {
        moveState.canUp = !!canUp; moveState.canDown = !!canDown;
        upBtn.disabled = !canUp;
        downBtn.disabled = !canDown;
      },
    };
    return rowApi;
  }

  function mount(section, opts) {
    if (!hasDom() || !section) return null;
    opts = opts || {};
    var categoryOnly = !!opts.categoryOnly;
    var apiFetch = opts.apiFetch || (opts.Api && opts.Api.apiFetch) || (Api && Api.apiFetch);

    var rootEl = el('div', 'tp-root');
    section.appendChild(rootEl);

    if (!categoryOnly) {
      rootEl.appendChild(msg('tp-intro muted', t('templates.intro')));
    }

    // Current FieldSpec area.
    var specArea = el('div', 'tp-spec-area');
    if (!categoryOnly) rootEl.appendChild(specArea);

    // Import form: textarea (primary) + optional file picker + name input + submit.
    var form = el('form', 'tp-form');

    var textareaLabel = el('label', 'tp-form-label');
    textareaLabel.setAttribute('for', 'tp-csv-textarea');
    Escape.setText(textareaLabel, t('templates.paste_csv_label'));
    form.appendChild(textareaLabel);

    var textarea = el('textarea', 'tp-csv-textarea');
    textarea.id = 'tp-csv-textarea';
    textarea.rows = 6;
    form.appendChild(textarea);

    var fileLabel = el('label', 'tp-form-label');
    fileLabel.setAttribute('for', 'tp-csv-file');
    Escape.setText(fileLabel, t('templates.choose_file_label'));
    form.appendChild(fileLabel);

    // QA report #1b: give the CSV file picker the same drag-and-drop affordance
    // already built for the main Upload screen, instead of "Choose File" only.
    var fileZone = el('div', 'tp-file-zone');
    fileZone.setAttribute('role', 'button');
    fileZone.setAttribute('tabindex', '0');
    fileZone.appendChild(msg('tp-file-zone-text muted', t('templates.drop_file_here')));

    var fileInput = el('input', 'tp-csv-file');
    fileInput.type = 'file';
    fileInput.id = 'tp-csv-file';
    fileInput.setAttribute('accept', '.csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    fileZone.appendChild(fileInput);
    form.appendChild(fileZone);

    var nameLabel = el('label', 'tp-form-label');
    nameLabel.setAttribute('for', 'tp-name-input');
    Escape.setText(nameLabel, t('templates.template_name_label'));
    form.appendChild(nameLabel);

    var nameInput = el('input', 'tp-name-input');
    nameInput.type = 'text';
    nameInput.id = 'tp-name-input';
    nameInput.setAttribute('placeholder', 'default');
    form.appendChild(nameInput);

    var submitBtn = el('button', 'tp-submit');
    submitBtn.type = 'submit';
    Escape.setText(submitBtn, t('templates.import_template'));
    form.appendChild(submitBtn);

    var statusEl = msg('tp-status muted', '');
    form.appendChild(statusEl);

    if (!categoryOnly) rootEl.appendChild(form);

    var busy = false;
    // Set when the user picked a real .xlsx file — the Import button submits THIS
    // instead of the textarea's CSV text when set. Cleared if they type into the
    // textarea by hand (a clear sign they've switched back to the CSV path) or
    // after a successful/attempted import.
    var pendingExcelFile = null;

    // Shared by the file input's change AND the drop zone — QA report #4: reject an
    // obvious non-CSV/non-Excel file BEFORE attempting to read it, with a message
    // that tells the user exactly what to do, instead of a cryptic server 400 later.
    function handleChosenFile(file) {
      if (!file) return;
      if (isNonCsvFile(file)) {
        pendingExcelFile = null;
        Escape.setText(statusEl, tp('templates.unsupported_file', str(file.name).split('.').pop() || t('templates.unsupported_fallback')));
        return;
      }
      if (isExcelFile(file)) {
        pendingExcelFile = file;
        textarea.value = '';
        Escape.setText(statusEl, tp('templates.file_ready', str(file.name)));
        return;
      }
      pendingExcelFile = null;
      readFileAsText(file).then(function (text) {
        Escape.setText(statusEl, '');
        textarea.value = text;
      }).catch(function () {
        Escape.setText(statusEl, t('templates.could_not_read_file'));
      });
    }
    textarea.addEventListener('input', function () { pendingExcelFile = null; });
    fileInput.addEventListener('change', function () {
      handleChosenFile(fileInput.files && fileInput.files[0]);
    });
    ['dragenter', 'dragover'].forEach(function (evt) {
      fileZone.addEventListener(evt, function (ev) { ev.preventDefault(); ev.stopPropagation(); fileZone.classList.add('is-dragover'); });
    });
    ['dragleave', 'dragend'].forEach(function (evt) {
      fileZone.addEventListener(evt, function (ev) { ev.preventDefault(); ev.stopPropagation(); fileZone.classList.remove('is-dragover'); });
    });
    fileZone.addEventListener('drop', function (ev) {
      ev.preventDefault(); ev.stopPropagation(); fileZone.classList.remove('is-dragover');
      var dt = ev.dataTransfer;
      var file = dt && dt.files && dt.files[0];
      if (file) handleChosenFile(file);
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
      specArea.appendChild(msg('tp-loading muted', t('templates.loading_current')));
      return apiFetch('/api/templates').then(function (spec) {
        renderSpec(spec);
        return spec;
      }).catch(function (err) {
        var status = err && typeof err === 'object' ? err.status : 0;
        var body = err && typeof err === 'object' ? err.body : null;
        clear(specArea);
        specArea.appendChild(msg('tp-error', errorMessage(status, body, 'load')));
      });
    }

    // Shared submit path: both the "paste CSV" form and the visual field
    // builder call this with their own csv/name + status element + busy
    // setter, so the fetch/error-handling logic is written exactly once.
    // Never touches categories (columns-only contract — saveTemplate leaves
    // the stored category set untouched when categories is omitted).
    function submitCsv(csv, name, statusTarget, setBusyFn, onSuccess) {
      if (!apiFetch) return;
      var built = buildImportBody(csv, name);
      if (!built.ok) {
        Escape.setText(statusTarget, t('templates.add_named_field'));
        return;
      }
      setBusyFn(true);
      Escape.setText(statusTarget, t('templates.saving'));
      apiFetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { csv: built.csv, name: built.name },
      }).then(function (spec) {
        setBusyFn(false);
        Escape.setText(statusTarget, t('templates.template_saved'));
        renderSpec(spec);
        if (typeof onSuccess === 'function') onSuccess(spec);
      }).catch(function (err) {
        setBusyFn(false);
        var status = err && typeof err === 'object' ? err.status : 0;
        var body = err && typeof err === 'object' ? err.body : null;
        Escape.setText(statusTarget, errorMessage(status, body, 'save'));
      });
    }

    // Categories-only submit path (2026-07-09, independent-review finding #4): a JSON body
    // with `categories` and NO `csv` at all — routes/templates.js treats this as a TRUE
    // partial update (lib/templates.js's saveCategories()) that never reads or writes
    // `columns`, so it cannot revert a concurrent/just-prior columns save.
    function submitCategories(names, name, statusTarget, setBusyFn, onSuccess) {
      if (!apiFetch) return;
      setBusyFn(true);
      Escape.setText(statusTarget, t('templates.saving'));
      var trimmedName = str(name).trim();
      apiFetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { name: trimmedName !== '' ? trimmedName : 'default', categories: names },
      }).then(function (spec) {
        setBusyFn(false);
        Escape.setText(statusTarget, t('templates.categories_saved'));
        if (typeof onSuccess === 'function') onSuccess(spec);
      }).catch(function (err) {
        setBusyFn(false);
        var status = err && typeof err === 'object' ? err.status : 0;
        var body = err && typeof err === 'object' ? err.body : null;
        Escape.setText(statusTarget, errorMessage(status, body, 'save'));
      });
    }

    // Excel counterpart to submitCsv: reads the file as raw bytes (readAsText
    // would corrupt it — same QA #4 reasoning) and POSTs the buffer directly,
    // with ?name= carrying the template name (the body itself is pure binary,
    // unlike submitCsv's JSON {csv, name}).
    function submitExcelFile(file, name, statusTarget, setBusyFn, onSuccess) {
      if (!apiFetch) return;
      var trimmedName = str(name).trim() || 'default';
      setBusyFn(true);
      Escape.setText(statusTarget, t('templates.reading_excel'));
      readFileAsArrayBuffer(file).then(function (buffer) {
        Escape.setText(statusTarget, t('templates.saving'));
        return apiFetch('/api/templates?name=' + encodeURIComponent(trimmedName), {
          method: 'POST',
          headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
          body: buffer,
        });
      }).then(function (spec) {
        setBusyFn(false);
        Escape.setText(statusTarget, t('templates.template_saved'));
        renderSpec(spec);
        if (typeof onSuccess === 'function') onSuccess(spec);
      }).catch(function (err) {
        setBusyFn(false);
        // A FileReader failure rejects with a plain Error (no .status); an
        // apiFetch failure rejects with a { status, body } pair.
        if (err instanceof Error) {
          Escape.setText(statusTarget, t('templates.could_not_read_excel'));
          return;
        }
        var status = err && typeof err === 'object' ? err.status : 0;
        var body = err && typeof err === 'object' ? err.body : null;
        Escape.setText(statusTarget, errorMessage(status, body, 'save'));
      });
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (busy) return;
      if (pendingExcelFile) {
        var excelFile = pendingExcelFile;
        submitExcelFile(excelFile, nameInput.value, statusEl, setBusy, function () { pendingExcelFile = null; });
        return;
      }
      submitCsv(textarea.value, nameInput.value, statusEl, setBusy);
    });

    // ---- visual field builder section (additive) ---------------------------
    var builderWrap = el('div', 'tp-fb');

    var fbTitleRow = el('div', 'view-title-row');
    fbTitleRow.appendChild(msg('tp-fb-title', t('templates.build_visually_title')));
    if (opts.Render && opts.Render.buildInfoIcon) {
      var fbIcon = opts.Render.buildInfoIcon(t('templates.build_visually_info'), t('templates.what_does_this_do'));
      if (fbIcon) fbTitleRow.appendChild(fbIcon);
    }
    builderWrap.appendChild(fbTitleRow);
    builderWrap.appendChild(msg('tp-fb-sub muted', t('templates.build_visually_sub')));
    builderWrap.appendChild(msg('tp-fb-note muted', t('templates.build_visually_note')));

    var rowsWrap = el('div', 'tp-fb-rows');
    builderWrap.appendChild(rowsWrap);

    var rows = [];

    // First/last row can't move further that way; every other row can move
    // both directions. Re-run after every add/remove/move so the ▲/▼ buttons
    // stay accurate.
    function refreshMoveButtons() {
      rows.forEach(function (r, i) {
        r.setMoveEnabled(i > 0, i < rows.length - 1);
      });
    }

    function removeRow(rowApi) {
      var idx = rows.indexOf(rowApi);
      if (idx === -1) return;
      rows.splice(idx, 1);
      rowsWrap.removeChild(rowApi.el);
      refreshMoveButtons();
      refreshBuilderState();
    }

    // Shifts a row's position by delta (-1 = up/earlier column, +1 = down/later
    // column) in BOTH the `rows` array and the DOM — array order is exactly
    // what buildCsvHeader emits, so this IS the left-to-right column order.
    function moveRow(rowApi, delta) {
      var idx = rows.indexOf(rowApi);
      var next = idx + delta;
      if (idx === -1 || next < 0 || next >= rows.length) return;
      rows.splice(idx, 1);
      rows.splice(next, 0, rowApi);
      if (delta < 0) rowsWrap.insertBefore(rowApi.el, rowsWrap.children[next]);
      else rowsWrap.insertBefore(rowApi.el, rowsWrap.children[next + 1] || null);
      refreshMoveButtons();
      refreshBuilderState();
    }

    function addRow(initial) {
      var rowApi = buildFieldRow(removeRow, moveRow, initial);
      rows.push(rowApi);
      rowsWrap.appendChild(rowApi.el);
      refreshMoveButtons();
      refreshBuilderState();
      return rowApi;
    }

    var addRowBtn = el('button', 'tp-fb-add');
    addRowBtn.type = 'button';
    Escape.setText(addRowBtn, t('templates.add_field'));
    addRowBtn.addEventListener('click', function () {
      addRow();
      var last = rows[rows.length - 1];
      if (last) { var input = last.el.querySelector('.tp-fb-name'); if (input) input.focus(); }
    });
    builderWrap.appendChild(addRowBtn);

    var fbSaveBtn = el('button', 'tp-fb-save');
    fbSaveBtn.type = 'button';
    Escape.setText(fbSaveBtn, t('templates.save_template'));
    builderWrap.appendChild(fbSaveBtn);

    var fbStatusEl = msg('tp-status muted', '');
    builderWrap.appendChild(fbStatusEl);

    var fbBusy = false;
    function setFbBusy(b) {
      fbBusy = b;
      fbSaveBtn.disabled = b || !canSaveBuilder(rows.map(function (r) { return r.getField(); }));
      addRowBtn.disabled = b;
      rows.forEach(function (r) { r.setBusy(b); });
    }

    function refreshBuilderState() {
      var fields = rows.map(function (r) { return r.getField(); });
      var can = canSaveBuilder(fields);
      fbSaveBtn.disabled = fbBusy || !can;
      if (!can) {
        Escape.setText(fbStatusEl, rows.length ? t('templates.add_one_field') : t('templates.add_field_get_started'));
      } else if (!fbBusy) {
        Escape.setText(fbStatusEl, '');
      }
    }

    rowsWrap.addEventListener('input', refreshBuilderState);
    rowsWrap.addEventListener('change', refreshBuilderState);
    refreshBuilderState(); // start disabled: 0 rows yet (before addRow/load seeds one)

    fbSaveBtn.addEventListener('click', function () {
      if (fbBusy) return;
      var fields = rows.map(function (r) { return r.getField(); });
      if (!canSaveBuilder(fields)) {
        Escape.setText(fbStatusEl, t('templates.add_one_field'));
        return;
      }
      var csv = buildCsvHeader(fields);
      submitCsv(csv, nameInput.value, fbStatusEl, setFbBusy);
    });

    if (!categoryOnly) rootEl.appendChild(builderWrap);

    // ---- category editor section (additive, ADR-021) -----------------------
    // A second, independent visual builder (chart of accounts, not columns).
    // Reuses the field builder's exact CSS idioms (.tp-fb-row/-move/-name/
    // -remove/-add/-save) — same visual language, per the project's "no new
    // visual language" convention; .tp-cat only distinguishes the container.
    var catWrap = el('div', 'tp-fb tp-cat');

    var catTitleRow = el('div', 'view-title-row');
    catTitleRow.appendChild(msg('tp-fb-title', t('templates.category_list_title')));
    if (opts.Render && opts.Render.buildInfoIcon) {
      var catIcon = opts.Render.buildInfoIcon(t('templates.category_list_info'), t('templates.what_does_this_do'));
      if (catIcon) catTitleRow.appendChild(catIcon);
    }
    catWrap.appendChild(catTitleRow);
    catWrap.appendChild(msg('tp-fb-sub muted', t('templates.category_list_sub')));

    var catRowsWrap = el('div', 'tp-fb-rows');
    catWrap.appendChild(catRowsWrap);

    var catRows = [];

    function refreshCatMoveButtons() {
      catRows.forEach(function (r, i) { r.setMoveEnabled(i > 0, i < catRows.length - 1); });
    }

    function removeCatRow(rowApi) {
      var idx = catRows.indexOf(rowApi);
      if (idx === -1) return;
      catRows.splice(idx, 1);
      catRowsWrap.removeChild(rowApi.el);
      refreshCatMoveButtons();
    }

    // Same left-to-right-order-IS-array-order convention as moveRow above —
    // this order is what the Statement export numbers categories by.
    function moveCatRow(rowApi, delta) {
      var idx = catRows.indexOf(rowApi);
      var next = idx + delta;
      if (idx === -1 || next < 0 || next >= catRows.length) return;
      catRows.splice(idx, 1);
      catRows.splice(next, 0, rowApi);
      if (delta < 0) catRowsWrap.insertBefore(rowApi.el, catRowsWrap.children[next]);
      else catRowsWrap.insertBefore(rowApi.el, catRowsWrap.children[next + 1] || null);
      refreshCatMoveButtons();
    }

    function addCatRow(initialName) {
      var rowApi = buildCategoryRow(removeCatRow, moveCatRow, initialName);
      catRows.push(rowApi);
      catRowsWrap.appendChild(rowApi.el);
      refreshCatMoveButtons();
      return rowApi;
    }

    var addCatBtn = el('button', 'tp-fb-add');
    addCatBtn.type = 'button';
    Escape.setText(addCatBtn, t('templates.add_category'));
    addCatBtn.addEventListener('click', function () {
      addCatRow();
      var last = catRows[catRows.length - 1];
      if (last) { var input = last.el.querySelector('.tp-fb-name'); if (input) input.focus(); }
    });
    catWrap.appendChild(addCatBtn);

    var catSaveBtn = el('button', 'tp-fb-save');
    catSaveBtn.type = 'button';
    Escape.setText(catSaveBtn, t('templates.save_categories'));
    catWrap.appendChild(catSaveBtn);

    var catStatusEl = msg('tp-status muted', '');
    catWrap.appendChild(catStatusEl);

    var catBusy = false;
    function setCatBusy(b) {
      catBusy = b;
      catSaveBtn.disabled = b;
      addCatBtn.disabled = b;
      catRows.forEach(function (r) { r.setBusy(b); });
    }

    // Clears + reseeds the rows from a fresh list (used on initial load and
    // after every save, so the editor always mirrors the server's EFFECTIVE
    // list — sanitized/deduped/'Others'-appended — never a stale local guess).
    function reseedCatRows(names) {
      catRows.slice().forEach(function (r) { catRowsWrap.removeChild(r.el); });
      catRows.length = 0;
      var list = Array.isArray(names) ? names : [];
      if (list.length) list.forEach(function (n) { addCatRow(n); });
      else addCatRow();
    }

    // /api/config (not /api/templates) is the source of the EFFECTIVE list —
    // it already falls back to the built-in default set when nothing custom
    // is stored (routes/expenses.js), so the editor always starts from what's
    // actually active, not an empty box on a fresh account.
    function loadCategories() {
      if (!apiFetch) return;
      return apiFetch('/api/config').then(function (cfg) {
        reseedCatRows(isPlainObject(cfg) && Array.isArray(cfg.categories) ? cfg.categories : []);
      }).catch(function () {
        Escape.setText(catStatusEl, t('templates.could_not_load_categories'));
      });
    }

    catSaveBtn.addEventListener('click', function () {
      if (catBusy) return;
      var names = namedCategoryNames(catRows.map(function (r) { return r.getName(); }));
      submitCategories(names, nameInput.value, catStatusEl, setCatBusy, function () {
        loadCategories(); // re-sync with the server's sanitized/effective list
      });
    });

    rootEl.appendChild(catWrap);

    // ---- lazy load ----------------------------------------------------------
    // Lazy-load on first view (mirrors overview.js's load-on-first-show pattern).
    // Also seeds the builder from the current FieldSpec when one exists, so
    // editing an existing template visually is possible (falls back to one
    // empty row when there is nothing meaningful to seed from).
    var state = { loaded: false, loading: false };
    function seedBuilder(spec) {
      var vm = summarizeFieldSpec(spec);
      if (vm.columns.length) {
        vm.columns.forEach(function (c) {
          var col = isPlainObject(c) ? c : {};
          addRow({ label: str(col.label) || str(col.key), type: col.type, required: !!col.required });
        });
      } else {
        addRow();
      }
    }
    function load() {
      if (state.loading || state.loaded || !apiFetch) return;
      state.loading = true;
      if (categoryOnly) {
        var cats = loadCategories();
        if (cats && typeof cats.then === 'function') {
          cats.then(function () {
            state.loading = false; state.loaded = true;
          }).catch(function () { state.loading = false; });
        } else {
          state.loading = false;
        }
        return cats;
      }
      var p = loadCurrent();
      if (p && typeof p.then === 'function') {
        p.then(function (spec) {
          state.loading = false; state.loaded = true;
          seedBuilder(spec);
          loadCategories();
        }).catch(function () { state.loading = false; }); // leave loaded=false so a revisit can retry
      } else {
        state.loading = false;
      }
    }

    // No-apiFetch/no-DOM-load environments (e.g. some tests) still get one
    // empty starter row so each builder is usable standalone.
    if (!apiFetch) {
      if (!categoryOnly) addRow();
      addCatRow();
    }

    return { el: rootEl, load: load };
  }

  return {
    // pure
    buildImportBody: buildImportBody,
    summarizeFieldSpec: summarizeFieldSpec,
    errorMessage: errorMessage,
    namedFields: namedFields,
    buildCsvHeader: buildCsvHeader,
    canSaveBuilder: canSaveBuilder,
    isNonCsvFile: isNonCsvFile,
    isExcelFile: isExcelFile,
    fieldDisplayName: fieldDisplayName,
    FIELD_TYPES: FIELD_TYPES,
    namedCategoryNames: namedCategoryNames,
    // render (browser)
    mount: mount,
  };
});

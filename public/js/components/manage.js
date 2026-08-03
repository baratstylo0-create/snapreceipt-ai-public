// components/manage.js — the "Manage" shell (ADR-021 Phase 6 follow-up).
//
// Manage is no longer a single screen: it hosts SUB-PAGES chosen from a dropdown, so
// account setup and in-dashboard data editing live in one predictable place instead of
// separate top-level tabs. Sub-pages:
//   1. "Template & Categories" — the field-template + category editors (components/templates.js).
//   2. "Data editor (spreadsheet)" — the excel-lite editable grid (components/grid.js), formerly
//      the standalone "Ledger" tab. Present in BOTH personal and business mode (Barat request,
//      2026-07-24: personal should get the same spreadsheet editing experience) unless the
//      account's excelLiteGrid capability is explicitly off (config.excel_lite_grid === false —
//      the "missing/old config defaults ON" rule). grid.js itself hides the business-only pieces
//      (Petty Cash Statement export, branch dropdown, submit-for-approval) when there's no
//      session — those already 403 server-side for a personal account, so hiding them client-side
//      isn't just cosmetic.
//
// This shell owns NONE of the sub-pages' logic — it just mounts each real component into its own
// panel and toggles which panel is visible, lazy-loading a sub-page's data the first time it's
// shown (mirrors app.js's own load-on-first-show pattern for top-level views). The sub-components
// are unchanged; only their location moved.
//
// Conventions: pure DOM (createElement/textContent — never innerHTML), UMD shim, the routing
// logic (subPagesFor) node-testable without a DOM.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Manage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- pure logic (node-tested) ----------------------------------------------

  // subPagesFor(config, business) -> the ordered sub-page list for this account. The template
  // editor is always present. The excel-lite Data editor is present for BOTH personal and business
  // (2026-07-24: was business-only; Barat asked for the same spreadsheet editor in personal mode)
  // unless the excelLiteGrid capability is explicitly off (config.excel_lite_grid === false — the
  // "missing/old config defaults ON" rule). `business` is kept as a parameter (still used to decide
  // what grid.js itself renders — the business-only Petty Cash Statement/submission pieces), not to
  // gate whether the page exists at all. Pure, never throws.
  function subPagesFor(config, business) {
    var templateBuilderOff = !!(config && config.template_builder === false);
    var pages = [templateBuilderOff ? { id: 'category', label: 'Categories' } : { id: 'template', label: 'Template & Categories' }];
    var gridOff = !!(config && config.excel_lite_grid === false);
    if (!gridOff) pages.push({ id: 'data', label: 'Data editor (spreadsheet)' });
    return pages;
  }

  // defaultSubPage(pages) -> which sub-page Manage OPENS on (2026-07-11, Owner request: the Data
  // editor spreadsheet should be the landing page for BOTH admin and clerk; 2026-07-24: now also
  // personal, since the Data editor exists there too). Whenever the Data editor is present
  // (excel_lite_grid not off), open on it; otherwise fall back to the first page (the template
  // editor) — only when grid-off, since personal now always has a Data editor too. This changes
  // only the initial selection, NOT the dropdown order (subPagesFor still lists template first).
  // Pure, never throws.
  function defaultSubPage(pages) {
    var list = Array.isArray(pages) ? pages : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === 'data') return 'data';
    }
    return (list[0] && list[0].id) || 'template';
  }

  // ---- view (browser only) ---------------------------------------------------

  function mount(section, deps) {
    if (typeof document === 'undefined' || !section) return null;
    deps = deps || {};
    var Templates = deps.Templates || (typeof root !== 'undefined' && root.Templates) || null;
    var Grid = deps.Grid || (typeof root !== 'undefined' && root.Grid) || null;

    // Business mode = a signed-in session that ISN'T a personal 'owner' account (2026-07-25:
    // personal accounts now carry sessions too, so bare session truthiness is no longer the
    // right signal — matches app.js's isBusinessSession helper / grid.js's own guard).
    var pages = subPagesFor(deps.config, !!(deps.session && deps.session.role !== 'owner'));

    var shell = document.createElement('div');
    shell.className = 'manage-shell';
    section.appendChild(shell);

    // -- sub-page dropdown (only shown when there's a real choice to make) --
    var subnav = document.createElement('div');
    subnav.className = 'manage-subnav';
    var label = document.createElement('label');
    label.className = 'manage-subnav-label';
    label.setAttribute('for', 'manage-subnav-select');
    label.textContent = 'Section';
    var select = document.createElement('select');
    select.className = 'manage-subnav-select';
    select.id = 'manage-subnav-select';
    label.setAttribute('for', select.id);
    pages.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      select.appendChild(o);
    });
    subnav.appendChild(label);
    subnav.appendChild(select);
    // A single sub-page needs no chooser — keep the shell clean (the panel still renders).
    if (pages.length > 1) shell.appendChild(subnav);

    // -- panels: one per sub-page, each hosting the real component --
    var panelsWrap = document.createElement('div');
    panelsWrap.className = 'manage-panels';
    shell.appendChild(panelsWrap);

    var panels = {};        // id -> panel element
    var instances = {};     // id -> mounted component instance (exposes load?)
    var loaded = {};        // id -> have we called load() yet

    pages.forEach(function (p) {
      var panel = document.createElement('div');
      panel.className = 'manage-panel';
      panel.setAttribute('data-manage-sub', p.id);
      panelsWrap.appendChild(panel);
      panels[p.id] = panel;

      var comp = (p.id === 'template' || p.id === 'category') ? Templates : p.id === 'data' ? Grid : null;
      if (comp && typeof comp.mount === 'function') {
        var childDeps = deps;
        if (p.id === 'category') {
          childDeps = {};
          for (var k in deps) childDeps[k] = deps[k];
          childDeps.categoryOnly = true;
        }
        var inst = comp.mount(panel, childDeps);
        if (inst) instances[p.id] = inst;
      } else {
        var ph = document.createElement('p');
        ph.className = 'view-placeholder muted';
        ph.textContent = 'Coming soon.';
        panel.appendChild(ph);
      }
    });

    function showSub(id) {
      if (!panels[id]) id = pages[0] && pages[0].id;
      pages.forEach(function (p) {
        if (panels[p.id]) panels[p.id].hidden = (p.id !== id);
      });
      if (select.value !== id) select.value = id;
      // Lazy-load the sub-page's data the first time it becomes visible.
      if (!loaded[id]) {
        loaded[id] = true;
        var inst = instances[id];
        if (inst && typeof inst.load === 'function') inst.load();
      }
    }

    select.addEventListener('change', function () { showSub(select.value); });

    // Default to the Data editor when it exists (Owner request — both admin & clerk land on the
    // spreadsheet), else the template editor; app.js calls load() when Manage first becomes visible.
    var current = defaultSubPage(pages);
    select.value = current; // reflect the default in the dropdown so load() opens the right panel
    pages.forEach(function (p) { if (panels[p.id]) panels[p.id].hidden = (p.id !== current); });

    return {
      // load() is called by app.js EVERY time Manage becomes visible (app.js has no
      // lazy-once gate of its own — see its `select()`), so this is the right place to force
      // a fresh reload of whichever sub-page is showing: drop that sub-page's own lazy-load
      // gate right before re-entering showSub. Fixes a real bug (2026-07-22): the Data editor
      // previously fetched /api/expenses only on Manage's FIRST-ever show and then never again,
      // so a bill deleted from Activity in a later visit kept appearing here until a full page
      // reload. Switching sub-pages WITHIN one Manage visit (e.g. Template <-> Data via the
      // dropdown) still only loads each once — only re-ENTERING Manage forces a refetch.
      load: function () {
        var id = select.value || current;
        loaded[id] = false;
        showSub(id);
      },
    };
  }

  return { subPagesFor: subPagesFor, defaultSubPage: defaultSubPage, mount: mount };
});

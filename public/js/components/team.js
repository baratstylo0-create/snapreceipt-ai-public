// components/team.js — the Team view (ADR-021 Phase 2/8, M2 business layer):
// HQ Admin manages branches + companies + each branch's staff directory; a
// Branch Clerk manages only their own branch's staff directory. Visual shape
// takes cues from Mugi's concept-fresh.html org-tree mockup, but this is a
// REAL component wired to the actual backend (routes/branches.js,
// routes/companies.js) — not the concept's in-memory demo data. Per the
// signed-off design (docs/specs/2026-07-06-business-account-multibranch-design.md
// §9/§12): staff are name-only (no login, no bot ID) — only the branch clerk is
// credentialed/bound, so there is deliberately no bot-ID field, no per-staff
// login, no role-switcher, and no "access request" concept-only UI here.
//
// Business mode only (the section only exists in business nav). Admin sees every
// branch + company management; a clerk sees only their own branch's staff
// directory (server enforces this regardless — hiding admin-only controls for a
// clerk just keeps the UI honest, same convention as payments.js).
//
// Same conventions as every other view: pure DOM (createElement/textContent,
// never innerHTML with a dynamic value), UMD shim, pure logic node-tested.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Team = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- pure logic (node-tested) ----------------------------------------------

  function isAdmin(session) { return !!(session && session.role === 'admin'); }

  // normalizeBranch(b) -> a display-safe shape, tolerant of a garbage/partial row.
  function normalizeBranch(b) {
    b = b || {};
    return {
      id: b.id || '',
      office: b.office || 'Untitled branch',
      state: b.state || '',
      clerkName: b.clerk_name || '',
      companyId: b.company_id || null,
      active: b.active !== false,
    };
  }

  function normalizeStaff(s) {
    s = s || {};
    return { id: s.id || '', name: s.display_name || 'Unnamed' };
  }

  function normalizeCompany(c) {
    c = c || {};
    return { id: c.id || '', name: c.name || 'Untitled company', currency: c.currency || '' };
  }

  // credentialPanel(office, resp) -> the one-time "save these now" model from a
  // successful POST /api/branches response, or null if the response is missing
  // the credentials shape (never throws, never fabricates a password).
  function credentialPanel(office, resp) {
    var creds = resp && resp.credentials;
    if (!creds || !creds.username || !creds.password) return null;
    return {
      office: office || (resp.branch && resp.branch.office) || '',
      username: creds.username,
      password: creds.password,
      bindToken: resp.bindToken || '',
    };
  }

  // botDeepLink(botUsername, bindToken) -> a clickable https://t.me/<bot>?start=<token> URL,
  // or null when botUsername isn't configured (the frontend then falls back to showing the
  // raw code for copy-paste). Mirrors setup/provision.js's CLI bindingLink() — same
  // optional/degrade contract, just returning a URL instead of a printed line.
  function botDeepLink(botUsername, bindToken) {
    var bot = String(botUsername || '').replace(/^@/, '').trim();
    var token = String(bindToken || '').trim();
    if (!bot || !token) return null;
    return 'https://t.me/' + bot + '?start=' + encodeURIComponent(token);
  }

  // branchDeleteWarning(branch) -> { title, message } for the delete-confirmation modal.
  // Tolerant of a garbage/partial branch (falls back to normalizeBranch's own defaults).
  function branchDeleteWarning(branch) {
    var b = normalizeBranch(branch);
    return {
      title: 'Remove ' + b.office + '?',
      message: 'This will permanently remove the branch and revoke the clerk\'s login. '
        + 'The Telegram bot binding for this branch will also be unbound. This cannot be undone.',
    };
  }

  // sortedBranches(branches) -> active branches first, alphabetical by office within each group.
  function sortedBranches(branches) {
    var list = (Array.isArray(branches) ? branches : []).slice();
    list.sort(function (a, b) {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return String(a.office).localeCompare(String(b.office));
    });
    return list;
  }

  // ---- DOM helpers (browser only) ---------------------------------------------

  function hasDom() { return typeof document !== 'undefined'; }
  function el(tag, className) { var n = document.createElement(tag); if (className) n.className = className; return n; }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function mount(section, deps) {
    if (!hasDom() || !section) return null;
    deps = deps || {};
    var Api = deps.Api, Escape = deps.Escape;
    var admin = isAdmin(deps.session);

    var state = {
      loaded: false,
      loading: false,
      branches: [],           // admin only
      staffByBranch: {},      // branchId -> [{id,name}]
      companies: [],          // admin only, [] if the dimension is off
      companiesEnabled: null, // null = not probed yet; feature-detected via a live 404
      newCred: null,          // the just-created branch's one-time credential panel
      error: '',
    };

    var wrap = el('div', 'team');
    section.appendChild(wrap);

    function textEl(tag, className, text) {
      var n = el(tag, className);
      if (Escape && Escape.setText) Escape.setText(n, text); else n.textContent = text;
      return n;
    }

    function ghostBtn(label) { var b = el('button', 'team-btn team-btn--ghost'); b.type = 'button'; Escape.setText(b, label); return b; }

    // ---- one-time credential panel (shown once, dismissible, never re-fetchable) ----
    function renderCredPanel(host) {
      if (!state.newCred) return;
      var c = state.newCred;
      var panel = el('div', 'team-cred-panel');
      panel.appendChild(textEl('div', 'team-cred-title', 'Branch created — save these now'));
      panel.appendChild(textEl('div', 'team-cred-warn', 'This password is shown only once. It cannot be retrieved again — write it down or share it securely with the ' + c.office + ' clerk now.'));

      var grid = el('div', 'team-cred-grid');
      [['Office', c.office], ['Username', c.username], ['Password', c.password]].forEach(function (pair) {
        var row = el('div', 'team-cred-row');
        row.appendChild(textEl('span', 'team-cred-label', pair[0]));
        row.appendChild(textEl('span', 'team-cred-value', pair[1]));
        grid.appendChild(row);
      });
      panel.appendChild(grid);

      if (c.bindToken) {
        var bindRow = el('div', 'team-cred-row');
        bindRow.appendChild(textEl('span', 'team-cred-label', 'Bot binding code'));
        bindRow.appendChild(textEl('span', 'team-cred-value team-cred-value--mono', c.bindToken));
        panel.appendChild(bindRow);

        var botUsername = deps.config && deps.config.bot_username;
        var link = botDeepLink(botUsername, c.bindToken);
        if (link) {
          // A real, clickable deep link — the clerk taps it on their own phone and the
          // bot binding completes with no typing. Opens in a new tab; rel=noopener per
          // the usual target=_blank hardening.
          var a = el('a', 'team-cred-link');
          a.href = link;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          Escape.setText(a, 'Open in Telegram →');
          panel.appendChild(a);
          panel.appendChild(textEl('div', 'team-cred-hint', 'Send this link to the ' + c.office + ' clerk — tapping it links their Telegram account instantly. Or they can send /start ' + c.bindToken + ' to the bot manually.'));
        } else {
          panel.appendChild(textEl('div', 'team-cred-hint', 'The clerk sends /start ' + c.bindToken + ' to the Telegram bot once to link their account.'));
        }
      }

      var dismiss = ghostBtn('I’ve saved this — dismiss');
      dismiss.addEventListener('click', function () { state.newCred = null; render(); });
      panel.appendChild(dismiss);
      host.appendChild(panel);
    }

    // ---- add branch form (admin only) ----
    function renderAddBranch(host) {
      var form = el('form', 'team-add-form');
      var office = el('input', 'team-input'); office.type = 'text'; office.placeholder = 'Branch / office name'; office.required = true;
      var stateInput = el('input', 'team-input'); stateInput.type = 'text'; stateInput.placeholder = 'State / region (optional)';
      var clerkName = el('input', 'team-input'); clerkName.type = 'text'; clerkName.placeholder = 'Clerk’s name (optional)';
      form.appendChild(office); form.appendChild(stateInput); form.appendChild(clerkName);

      var companySel = null;
      if (state.companiesEnabled && state.companies.length) {
        companySel = el('select', 'team-input');
        var noneOpt = el('option'); noneOpt.value = ''; Escape.setText(noneOpt, 'No company');
        companySel.appendChild(noneOpt);
        state.companies.forEach(function (co) {
          var op = el('option'); op.value = co.id; Escape.setText(op, co.name); companySel.appendChild(op);
        });
        form.appendChild(companySel);
      }

      var submit = el('button', 'team-btn team-btn--primary'); submit.type = 'submit';
      Escape.setText(submit, '+ Add branch');
      var status = el('span', 'team-form-status muted');
      form.appendChild(submit); form.appendChild(status);

      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var body = { office: office.value.trim() };
        if (!body.office) { Escape.setText(status, 'Office name is required.'); return; }
        if (stateInput.value.trim()) body.state = stateInput.value.trim();
        if (clerkName.value.trim()) body.clerkName = clerkName.value.trim();
        if (companySel && companySel.value) body.companyId = companySel.value;
        submit.disabled = true;
        Escape.setText(status, 'Creating…');
        Api.apiFetch('/api/branches', { method: 'POST', body: body }).then(function (resp) {
          var b = normalizeBranch(resp && resp.branch);
          state.branches.push(b);
          state.staffByBranch[b.id] = [];
          state.newCred = credentialPanel(b.office, resp);
          render();
        }).catch(function (err) {
          submit.disabled = false;
          var msg = (err && err.body && err.body.error) || 'Could not create the branch.';
          Escape.setText(status, msg);
        });
      });
      host.appendChild(form);
    }

    // ---- add company form (admin only, feature-detected) ----
    function renderAddCompany(host) {
      var form = el('form', 'team-add-form');
      var name = el('input', 'team-input'); name.type = 'text'; name.placeholder = 'Company name'; name.required = true;
      var currency = el('input', 'team-input'); currency.type = 'text'; currency.placeholder = 'Currency (optional, e.g. MYR)'; currency.maxLength = 8;
      var submit = el('button', 'team-btn team-btn--ghost'); submit.type = 'submit';
      Escape.setText(submit, '+ Add company');
      var status = el('span', 'team-form-status muted');
      form.appendChild(name); form.appendChild(currency); form.appendChild(submit); form.appendChild(status);

      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var body = { name: name.value.trim() };
        if (!body.name) { Escape.setText(status, 'Company name is required.'); return; }
        if (currency.value.trim()) body.currency = currency.value.trim();
        submit.disabled = true;
        Escape.setText(status, 'Creating…');
        Api.apiFetch('/api/companies', { method: 'POST', body: body }).then(function (resp) {
          state.companies.push(normalizeCompany(resp && resp.company));
          render();
        }).catch(function (err) {
          submit.disabled = false;
          var msg = (err && err.body && err.body.error) || 'Could not create the company.';
          Escape.setText(status, msg);
        });
      });
      host.appendChild(form);
    }

    // ---- staff directory for one branch (admin: any branch; clerk: own only) ----
    function renderStaffList(host, branchId) {
      var list = state.staffByBranch[branchId] || [];
      var ul = el('div', 'team-staff-list');
      if (!list.length) ul.appendChild(textEl('p', 'team-staff-empty muted', 'No staff yet.'));
      list.forEach(function (s) {
        var row = el('div', 'team-staff-row');
        row.appendChild(textEl('span', 'team-staff-name', s.name));
        var rm = el('button', 'team-staff-remove'); rm.type = 'button';
        Escape.setText(rm, '×');
        rm.setAttribute('aria-label', 'Remove ' + s.name);
        // Two-step confirm — no native confirm() (CSP/UX convention, matches activity.js).
        var confirming = false;
        rm.addEventListener('click', function () {
          if (!confirming) {
            confirming = true;
            rm.classList.add('is-confirming');
            Escape.setText(rm, '✓');
            rm.title = 'Click again to remove';
            return;
          }
          rm.disabled = true;
          Api.apiFetch('/api/staff/' + encodeURIComponent(s.id), { method: 'DELETE' }).then(function () {
            state.staffByBranch[branchId] = (state.staffByBranch[branchId] || []).filter(function (x) { return x.id !== s.id; });
            render();
          }).catch(function () {
            confirming = false;
            rm.disabled = false;
            rm.classList.remove('is-confirming');
            Escape.setText(rm, '×');
          });
        });
        row.appendChild(rm);
        ul.appendChild(row);
      });
      host.appendChild(ul);

      var addForm = el('form', 'team-staff-add');
      var input = el('input', 'team-input team-input--sm'); input.type = 'text'; input.placeholder = 'Add staff name…'; input.required = true;
      var add = el('button', 'team-btn team-btn--ghost team-btn--sm'); add.type = 'submit'; Escape.setText(add, '+');
      addForm.appendChild(input); addForm.appendChild(add);
      addForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var nm = input.value.trim();
        if (!nm) return;
        add.disabled = true;
        Api.apiFetch('/api/branches/' + encodeURIComponent(branchId) + '/staff', { method: 'POST', body: { name: nm } }).then(function (resp) {
          var s = normalizeStaff(resp && resp.staff);
          state.staffByBranch[branchId] = (state.staffByBranch[branchId] || []).concat([s]);
          render();
        }).catch(function () {
          add.disabled = false;
        });
      });
      host.appendChild(addForm);
    }

    // ---- delete-confirmation modal (QA round: was an inline two-step button, now a real
    // warning window so a fast double-click can't accidentally remove a branch) ----
    function openDeleteModal(b, triggerBtn) {
      var warn = branchDeleteWarning(b);
      var overlay = el('div', 'team-modal-overlay');
      var modal = el('div', 'team-modal');
      modal.setAttribute('role', 'alertdialog');
      modal.setAttribute('aria-label', warn.title);
      modal.appendChild(textEl('div', 'team-modal-title', warn.title));
      modal.appendChild(textEl('p', 'team-modal-message', warn.message));

      var actions = el('div', 'team-modal-actions');
      var cancel = el('button', 'team-btn team-btn--ghost'); cancel.type = 'button';
      Escape.setText(cancel, 'Cancel');
      var confirm = el('button', 'team-btn team-btn--danger'); confirm.type = 'button';
      Escape.setText(confirm, 'Remove branch');
      actions.appendChild(cancel); actions.appendChild(confirm);
      modal.appendChild(actions);
      overlay.appendChild(modal);

      function closeModal() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
      overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeModal(); });
      cancel.addEventListener('click', closeModal);
      confirm.addEventListener('click', function () {
        confirm.disabled = true;
        cancel.disabled = true;
        Api.apiFetch('/api/branches/' + encodeURIComponent(b.id), { method: 'DELETE' }).then(function () {
          state.branches = state.branches.filter(function (x) { return x.id !== b.id; });
          delete state.staffByBranch[b.id];
          closeModal();
          render();
        }).catch(function () {
          confirm.disabled = false;
          cancel.disabled = false;
          Escape.setText(confirm, 'Failed — try again');
        });
      });

      document.body.appendChild(overlay);
    }

    // ---- one branch card (admin: full card + remove; clerk: staff-only, no card chrome) ----
    function renderBranchCard(host, b) {
      var card = el('div', 'team-branch-card' + (b.active ? '' : ' is-inactive'));
      var head = el('div', 'team-branch-head');
      head.appendChild(textEl('span', 'team-branch-name', b.office + (b.state ? ' · ' + b.state : '')));
      if (b.clerkName) head.appendChild(textEl('span', 'team-branch-clerk', 'Clerk: ' + b.clerkName));
      card.appendChild(head);

      if (admin) {
        var rmBranch = el('button', 'team-branch-remove'); rmBranch.type = 'button';
        Escape.setText(rmBranch, 'Remove branch');
        rmBranch.addEventListener('click', function () {
          openDeleteModal(b, rmBranch);
        });
        card.appendChild(rmBranch);
      }

      card.appendChild(textEl('div', 'team-staff-title', 'Staff'));
      renderStaffList(card, b.id);
      host.appendChild(card);
    }

    function render() {
      clear(wrap);
      wrap.appendChild(textEl('p', 'view-sub muted',
        admin ? 'Manage your branches, their clerks, and each branch’s staff directory.'
          : 'Manage your branch’s staff directory.'));

      renderCredPanel(wrap);

      if (state.error) {
        wrap.appendChild(textEl('p', 'team-error', state.error));
        return;
      }
      if (!state.loaded) {
        wrap.appendChild(textEl('p', 'muted', 'Loading…'));
        return;
      }

      if (admin) {
        var addRow = el('div', 'team-add-row');
        renderAddBranch(addRow);
        wrap.appendChild(addRow);

        if (state.companiesEnabled) {
          var coSection = el('div', 'team-companies');
          coSection.appendChild(textEl('div', 'team-section-title', 'Companies'));
          if (state.companies.length) {
            var coList = el('div', 'team-company-list');
            state.companies.forEach(function (co) {
              coList.appendChild(textEl('span', 'team-company-chip', co.name + (co.currency ? ' (' + co.currency + ')' : '')));
            });
            coSection.appendChild(coList);
          }
          renderAddCompany(coSection);
          wrap.appendChild(coSection);
        }

        var list = sortedBranches(state.branches);
        if (!list.length) {
          wrap.appendChild(textEl('p', 'team-staff-empty muted', 'No branches yet — add your first branch above.'));
        } else {
          var branchesHost = el('div', 'team-branches');
          list.forEach(function (b) { renderBranchCard(branchesHost, b); });
          wrap.appendChild(branchesHost);
        }
      } else {
        var ownId = deps.session && deps.session.branch_id;
        if (!ownId) {
          wrap.appendChild(textEl('p', 'team-error', 'No branch is linked to your account yet.'));
          return;
        }
        var ownCard = el('div', 'team-branch-card');
        ownCard.appendChild(textEl('div', 'team-branch-head', deps.session.display_name || 'Your branch'));
        ownCard.appendChild(textEl('div', 'team-staff-title', 'Staff'));
        renderStaffList(ownCard, ownId);
        wrap.appendChild(ownCard);
      }
    }

    function load() {
      if (state.loading) return;
      state.loading = true;
      render();

      if (admin) {
        Api.apiFetch('/api/branches').then(function (resp) {
          var branches = (resp && resp.branches || []).map(normalizeBranch);
          state.branches = branches;
          return Promise.all(branches.map(function (b) {
            return Api.apiFetch('/api/branches/' + encodeURIComponent(b.id) + '/staff').then(function (r) {
              state.staffByBranch[b.id] = (r && r.staff || []).map(normalizeStaff);
            }).catch(function () { state.staffByBranch[b.id] = []; });
          }));
        }).then(function () {
          // Feature-detect the company dimension: a 404 means the capability is off
          // for this account — never surface company UI a client can't actually use.
          return Api.apiFetch('/api/companies').then(function (resp) {
            state.companiesEnabled = true;
            state.companies = (resp && resp.companies || []).map(normalizeCompany);
          }).catch(function (err) {
            state.companiesEnabled = !(err && err.status === 404);
            state.companies = [];
          });
        }).then(function () {
          state.loaded = true;
          state.loading = false;
          render();
        }).catch(function (err) {
          state.loading = false;
          state.error = (err && err.body && err.body.error) || 'Could not load your team.';
          render();
        });
      } else {
        var ownId = deps.session && deps.session.branch_id;
        if (!ownId) { state.loaded = true; state.loading = false; render(); return; }
        Api.apiFetch('/api/branches/' + encodeURIComponent(ownId) + '/staff').then(function (r) {
          state.staffByBranch[ownId] = (r && r.staff || []).map(normalizeStaff);
          state.loaded = true;
          state.loading = false;
          render();
        }).catch(function (err) {
          state.loading = false;
          state.error = (err && err.body && err.body.error) || 'Could not load your branch.';
          render();
        });
      }
    }

    render();
    return { el: wrap, load: load };
  }

  return {
    // pure
    isAdmin: isAdmin,
    normalizeBranch: normalizeBranch,
    normalizeStaff: normalizeStaff,
    normalizeCompany: normalizeCompany,
    credentialPanel: credentialPanel,
    sortedBranches: sortedBranches,
    botDeepLink: botDeepLink,
    branchDeleteWarning: branchDeleteWarning,
    // render (browser)
    mount: mount,
  };
});

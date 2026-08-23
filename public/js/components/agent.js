// components/agent.js — the Agent chat screen (Task G): a stateless chat
// widget over POST /api/agent. The SERVER holds no conversation state — the
// client owns the running transcript and RESENDS the full thing each turn.
// On success the server returns the authoritative updated transcript
// (messages: [...including the new assistant reply]); we replace our local
// copy with it rather than manually appending, so client and server never
// drift.
//
// SECURITY (SOP §7.3): the assistant's answer is MODEL OUTPUT — untrusted,
// same bar as OCR text or a customer's CSV. A prompt-injection that tries to
// return markup (e.g. "><img onerror=...>) must render as inert text.
// EVERY message bubble's content, and the tools-used line, goes through
// Escape.setText (textContent). We NEVER assign innerHTML anywhere in this
// file.
//
// TWO layers, kept apart so the logic is unit-testable without a DOM:
//   1. PURE helpers — appendUserMessage / transcriptStats / exceedsCaps /
//      toolsUsedLabel / agentErrorMessage. No DOM, no network, never throw on
//      junk. Covered by tests/frontend/agent.test.js.
//   2. RENDER layer (mount + render*) — real DOM via createElement +
//      Escape.setText. No innerHTML. No-ops outside a browser.
//
// Endpoint contract (read from routes/agent.js):
//   POST /api/agent  body: JSON { messages: [{role:'user'|'assistant',
//     content:string}, ...] }  (the FULL transcript, resent every turn)
//     -> 200 { answer: string, messages: <full updated transcript INCLUDING
//              the new assistant reply>, toolCalls: [{name, args?}, ...] }
//     -> 400 messages not an array of {role:user|assistant, content:string}
//     -> 413 messages.length > 20 (MAX_MESSAGES) OR total content chars >
//            12000 (MAX_CHARS) — mirrored client-side by exceedsCaps() so we
//            can block BEFORE sending and show a friendly message instead of
//            eating a 413.
//     -> 502 upstream/agent failure
//     All error bodies are fixed { error: '<string>' } — never shown
//     verbatim (house convention, same as upload.js's errorMessage).
//   toolCalls entries are treated defensively (each may be missing .name);
//   tool names come from a fixed server allow-list but are still rendered
//   via Escape for defense in depth.
//
// UMD shim: window.Agent in the browser; require()-able in Node (the render
// layer simply isn't exercised there — no document).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../escape'), require('../api'), require('../i18n'));
  } else {
    root.Agent = factory(root.Escape, root.Api, root.I18n);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape, Api, I18n) {
  'use strict';

  var t = (I18n && I18n.t) || function (k) { return k; };
  var tp = (I18n && I18n.tp) || function (k) { return k; };

  var MAX_MESSAGES = 20;
  var MAX_CHARS = 12000;

  // ---- pure helpers -------------------------------------------------------

  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  // Returns a NEW array = transcript + {role:'user', content: String(text)},
  // trimmed. Blank (after trim) text leaves the transcript unchanged (no
  // empty message added). Never mutates the input array, never throws.
  function appendUserMessage(transcript, text) {
    var base = Array.isArray(transcript) ? transcript : [];
    var content = str(text).trim();
    if (content === '') return base;
    return base.concat([{ role: 'user', content: content }]);
  }

  // {count, chars} for a transcript — chars = sum of content lengths.
  // Tolerant of null/garbage entries (skips non-objects / non-string
  // content). Never throws.
  function transcriptStats(transcript) {
    var list = Array.isArray(transcript) ? transcript : [];
    var count = 0, chars = 0;
    list.forEach(function (m) {
      if (!isPlainObject(m) || typeof m.content !== 'string') return;
      count += 1;
      chars += m.content.length;
    });
    return { count: count, chars: chars };
  }

  // Mirrors the server's MAX_MESSAGES/MAX_CHARS caps so the client can block
  // BEFORE sending and show a friendly message instead of eating a 413.
  // Message-count is checked first (matches the server's check order).
  // Never throws.
  function exceedsCaps(transcript) {
    var stats = transcriptStats(transcript);
    if (stats.count > MAX_MESSAGES) return { ok: false, reason: 'messages' };
    if (stats.chars > MAX_CHARS) return { ok: false, reason: 'chars' };
    return { ok: true };
  }

  // Reduce a toolCalls array to a short display string, e.g.
  // 'Tools used: getReport, topMerchants' (dedupe names, first-seen order),
  // or '' when empty/garbage. Entries missing .name (or non-object entries)
  // are skipped. Never throws.
  function toolsUsedLabel(toolCalls) {
    var list = Array.isArray(toolCalls) ? toolCalls : [];
    var seen = [];
    list.forEach(function (t) {
      if (!isPlainObject(t)) return;
      var name = typeof t.name === 'string' ? t.name : null;
      if (name && seen.indexOf(name) === -1) seen.push(name);
    });
    if (!seen.length) return '';
    return tp('agent.tools_used', seen.join(', '));
  }

  // ---- write-proposal helpers (ADR-019) -----------------------------------

  // A pending write action arrives as { id, kind, summary, diff }. `diff` is a
  // small object whose values are display strings (field -> "before → after",
  // or a `caveat` string for the template-add kind). We do NOT assume a fixed
  // key set — render whatever keys are present, generically. This pure helper
  // flattens the diff object into an ordered [{label, value}] list for the
  // render layer to escape + display. Both label and value stay raw here (the
  // render layer owns escaping, matching activity.js's pure/render split);
  // values may embed OCR'd merchant names, so they're untrusted text.
  // Tolerates a missing/non-object diff (-> []). Never throws.
  function diffPairs(diff) {
    if (!isPlainObject(diff)) return [];
    return Object.keys(diff).map(function (k) {
      return { label: k, value: str(diff[k]) };
    });
  }

  // Is `proposal` a well-formed pending write proposal? The server omits the
  // field entirely (never null) when there's nothing to confirm, so a plain
  // truthiness+shape check is enough. Requires an id (needed to POST the
  // confirm) — a proposal without one can't be actioned, so we treat it as
  // absent. Never throws.
  function hasProposal(proposal) {
    return isPlainObject(proposal) && typeof proposal.id === 'string' && proposal.id !== '';
  }

  // Map an HTTP status to a fixed, friendly message. Status-only (mirrors
  // upload.js's errorMessage / reports.js's exportErrorMessage) — body text
  // is never surfaced (house convention: never leak server internals).
  // Never throws.
  function agentErrorMessage(status) {
    switch (Number(status)) {
      case 400: return t('agent.err_400');
      case 413: return t('agent.err_413');
      case 502: return t('agent.err_502');
      default:  return t('agent.err_default');
    }
  }

  // ---- DOM helpers (browser only) -----------------------------------------

  function hasDom() { return typeof document !== 'undefined'; }
  function el(tag, className) { var n = document.createElement(tag); if (className) n.className = className; return n; }

  // QA report #5 ("I need chat memory like Claude") — the transcript already survives
  // WITHIN one open tab (the client resends it every turn, server is stateless), but a
  // page refresh wiped it since it only ever lived in a JS variable. Persist it in
  // sessionStorage — same lifetime as the dashboard auth token (cleared when the tab
  // closes), so a refresh doesn't lose the conversation but it's not kept forever either.
  // Never throws (private browsing / storage quota / no sessionStorage e.g. in Node).
  var TRANSCRIPT_KEY = 'agent_transcript';
  function loadPersistedTranscript() {
    try {
      if (typeof sessionStorage === 'undefined') return [];
      var raw = sessionStorage.getItem(TRANSCRIPT_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }
  function persistTranscript(transcript) {
    try {
      if (typeof sessionStorage === 'undefined') return;
      sessionStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(Array.isArray(transcript) ? transcript : []));
    } catch (e) { /* private browsing / quota exceeded — the chat still works, just isn't persisted */ }
  }
  function clearPersistedTranscript() {
    try { if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(TRANSCRIPT_KEY); } catch (e) { /* ignore */ }
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function msg(className, text) { var p = el('p', className); Escape.setText(p, text); return p; }

  // Render one message bubble. content ALWAYS goes through Escape.setText
  // (textContent) — never innerHTML — because assistant content is untrusted
  // model output (SOP §7.3).
  function renderBubble(list, message, toolsLabel) {
    var role = message && message.role === 'user' ? 'user' : 'assistant';
    var bubbleWrap = el('div', 'ag-msg ag-msg--' + role);

    var bubble = el('div', 'ag-msg-bubble');
    Escape.setText(bubble, message && message.content);
    bubbleWrap.appendChild(bubble);

    if (role === 'assistant' && toolsLabel) {
      var tools = el('p', 'ag-tools muted');
      Escape.setText(tools, toolsLabel);
      bubbleWrap.appendChild(tools);
    }

    list.appendChild(bubbleWrap);
    return bubbleWrap;
  }

  // Render the confirm card for a pending write proposal (ADR-019). Shows the
  // proposal summary + a readable diff, with Confirm / Cancel buttons. EVERY
  // piece of text (summary, diff labels AND values, later confirmation/error
  // lines) goes through Escape.setText — never innerHTML — because diffs embed
  // OCR'd merchant names (untrusted), same bar as every other bubble here.
  //
  // handlers: { onConfirm(card, buttons, msgEl), onCancel(card) }
  //   - onConfirm gets the card element, its two buttons (to disable), and the
  //     status line element to write into.
  //   - onCancel just removes the card.
  function renderConfirmCard(list, proposal, handlers) {
    var card = el('div', 'ag-confirm');

    card.appendChild(msg('ag-confirm-summary', proposal && proposal.summary));

    var pairs = diffPairs(proposal && proposal.diff);
    if (pairs.length) {
      var dl = el('div', 'ag-confirm-diff');
      pairs.forEach(function (p) {
        var row = el('div', 'ag-confirm-diff-row');
        row.appendChild(msg('ag-confirm-diff-label', p.label));
        row.appendChild(msg('ag-confirm-diff-value', p.value));
        dl.appendChild(row);
      });
      card.appendChild(dl);
    }

    var statusEl = msg('ag-confirm-msg muted', '');
    var actions = el('div', 'ag-confirm-actions');

    var confirmBtn = el('button', 'ag-confirm-yes');
    confirmBtn.type = 'button';
    Escape.setText(confirmBtn, t('agent.confirm'));

    var cancelBtn = el('button', 'ag-confirm-no');
    cancelBtn.type = 'button';
    Escape.setText(cancelBtn, t('agent.cancel'));

    confirmBtn.addEventListener('click', function () {
      handlers.onConfirm(card, [confirmBtn, cancelBtn], statusEl);
    });
    cancelBtn.addEventListener('click', function () {
      handlers.onCancel(card);
    });

    actions.appendChild(confirmBtn);
    actions.appendChild(cancelBtn);
    card.appendChild(actions);
    card.appendChild(statusEl);

    list.appendChild(card);
    list.scrollTop = list.scrollHeight;
    return card;
  }

  // ---- render layer --------------------------------------------------------

  function mount(section, opts) {
    if (!hasDom() || !section) return null;
    opts = opts || {};
    var apiFetch = opts.apiFetch || (opts.Api && opts.Api.apiFetch) || (Api && Api.apiFetch);
    // getAutoMode is called FRESH on every submit (never snapshotted at mount),
    // so flipping the Settings switch mid-session takes effect on the very next
    // send with no remount. Defaults to always-off. Tolerant of a non-function
    // or a throwing implementation (-> false).
    var getAutoMode = typeof opts.getAutoMode === 'function' ? opts.getAutoMode : function () { return false; };
    function readAutoMode() {
      try { return getAutoMode() === true; } catch (e) { return false; }
    }

    var rootEl = el('div', 'ag-root');
    section.appendChild(rootEl);

    var list = el('div', 'ag-list');
    rootEl.appendChild(list);

    var noticeEl = msg('ag-notice muted', '');
    rootEl.appendChild(noticeEl);

    var form = el('form', 'ag-form');

    var inputRow = el('div', 'ag-input-row');

    var textarea = el('textarea', 'ag-input');
    textarea.rows = 1;
    textarea.setAttribute('placeholder', t('agent.input_placeholder'));
    inputRow.appendChild(textarea);

    var sendBtn = el('button', 'ag-send');
    sendBtn.type = 'submit';
    sendBtn.setAttribute('aria-label', t('agent.send'));
    var sendIcon = el('span', 'ag-send-icon');
    sendIcon.setAttribute('aria-hidden', 'true');
    sendIcon.textContent = '↑'; // static glyph, not user data — plain textContent is fine
    sendBtn.appendChild(sendIcon);
    inputRow.appendChild(sendBtn);

    form.appendChild(inputRow);

    var clearBtn = el('button', 'ag-clear');
    clearBtn.type = 'button';
    Escape.setText(clearBtn, t('agent.new_conversation'));
    form.appendChild(clearBtn);

    rootEl.appendChild(form);

    // Client owns the running transcript; the server is stateless. Restored from
    // sessionStorage on mount (e.g. after a page refresh) so the conversation survives.
    var transcript = loadPersistedTranscript();
    var busy = false;
    // True while a write-proposal confirm card is on screen and unresolved: a
    // new message must not be sendable mid-confirmation ("can't land ambiguously
    // mid-confirmation"). Cleared the instant the card is Confirmed/Cancelled or
    // errors. Input is disabled whenever EITHER busy or a proposal is pending.
    var proposalPending = false;

    function refreshInputEnabled() {
      var disabled = busy || proposalPending;
      sendBtn.disabled = disabled;
      textarea.disabled = disabled;
    }

    function setBusy(b) {
      busy = b;
      refreshInputEnabled();
    }

    function setProposalPending(p) {
      proposalPending = p;
      refreshInputEnabled();
    }

    function setNotice(text) {
      Escape.setText(noticeEl, text || '');
    }

    function triggerSubmit() {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true }));
    }

    // Before the first real message, the transcript is empty — show a welcome
    // bubble (same look as an assistant reply) plus a few tappable suggestion
    // chips so a new user isn't staring at a blank box. Chip text is fixed,
    // developer-authored copy from i18n (not user data), same as the welcome
    // line itself.
    var SUGGESTION_KEYS = ['agent.suggestions.upload', 'agent.suggestions.spend', 'agent.suggestions.telegram'];
    function renderWelcome() {
      var wrap = el('div', 'ag-msg ag-msg--assistant');
      var bubble = el('div', 'ag-msg-bubble');
      Escape.setText(bubble, t('agent.intro'));
      wrap.appendChild(bubble);
      list.appendChild(wrap);

      var chips = el('div', 'ag-suggestions');
      SUGGESTION_KEYS.forEach(function (key) {
        var chip = el('button', 'ag-chip');
        chip.type = 'button';
        var text = t(key);
        Escape.setText(chip, text);
        chip.addEventListener('click', function () {
          if (busy || proposalPending) return;
          textarea.value = text;
          triggerSubmit();
        });
        chips.appendChild(chip);
      });
      list.appendChild(chips);
    }

    function renderTranscript(lastToolsLabel) {
      clear(list);
      if (!transcript.length) {
        renderWelcome();
        return;
      }
      transcript.forEach(function (m, i) {
        var isLast = i === transcript.length - 1;
        renderBubble(list, m, isLast ? lastToolsLabel : '');
      });
      list.scrollTop = list.scrollHeight;
    }

    function resetConversation() {
      transcript = [];
      clearPersistedTranscript();
      setNotice('');
      textarea.value = '';
      setProposalPending(false);
      renderTranscript();
    }

    // Render the confirm card for a pending write proposal and lock input until
    // it resolves. Confirm -> POST /api/agent/confirm exactly once (buttons
    // disabled on click to block a double-submit); Cancel -> client-side only,
    // no network. Either outcome (and any error) re-enables the textarea/Send.
    function showProposal(proposal) {
      setProposalPending(true);
      renderConfirmCard(list, proposal, {
        onConfirm: function (card, buttons, statusEl) {
          buttons.forEach(function (b) { b.disabled = true; }); // no double-click
          Escape.setText(statusEl, t('agent.applying'));
          apiFetch('/api/agent/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { proposalId: proposal.id },
          }).then(function (res) {
            if (res && res.ok) {
              // Replace the interactive card content with a short done line.
              clear(card);
              var kindLabel = res.kind ? ' (' + str(res.kind) + ')' : '';
              card.appendChild(msg('ag-confirm-done', t('agent.done') + kindLabel));
            } else {
              // Server returned { ok:false, error } — error is already a safe,
              // sanitized string. Show it and let the user try again.
              Escape.setText(statusEl, (res && res.error) || t('agent.err_default'));
              buttons.forEach(function (b) { b.disabled = false; });
            }
            setProposalPending(false);
          }).catch(function () {
            // Network/transport failure: never surface raw internals; re-enable
            // so the user can retry or ask something else.
            Escape.setText(statusEl, t('agent.err_default'));
            buttons.forEach(function (b) { b.disabled = false; });
            setProposalPending(false);
          });
        },
        onCancel: function (card) {
          // Cancel is purely client-side (nothing to undo server-side).
          if (card.parentNode) card.parentNode.removeChild(card);
          setProposalPending(false);
        },
      });
    }

    // Show whatever was restored from sessionStorage, or the welcome bubble
    // + suggestion chips when there's no prior conversation.
    renderTranscript();

    clearBtn.addEventListener('click', function () {
      if (busy) return;
      resetConversation();
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (busy || !apiFetch) return;

      var next = appendUserMessage(transcript, textarea.value);
      if (next === transcript) return; // blank input, nothing to send

      var capCheck = exceedsCaps(next);
      if (!capCheck.ok) {
        setNotice(t('agent.conversation_too_long'));
        return;
      }

      setNotice('');
      transcript = next;
      persistTranscript(transcript);
      textarea.value = '';
      renderTranscript();

      var thinking = msg('ag-msg ag-msg--assistant ag-thinking muted', t('agent.thinking'));
      list.appendChild(thinking);
      list.scrollTop = list.scrollHeight;

      setBusy(true);
      apiFetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // autoMode read FRESH here (not cached at mount) so toggling the
        // Settings switch mid-session takes effect on the very next send.
        body: { messages: transcript, autoMode: readAutoMode() },
      }).then(function (response) {
        setBusy(false);
        if (thinking.parentNode) thinking.parentNode.removeChild(thinking);
        // The server's response is authoritative — replace our local
        // transcript with it rather than manually appending.
        var updated = response && Array.isArray(response.messages) ? response.messages : transcript;
        transcript = updated;
        persistTranscript(transcript);
        var toolsLabel = toolsUsedLabel(response && response.toolCalls);
        renderTranscript(toolsLabel);
        // A pending write action (ADR-019) arrives as response.proposal ONLY
        // when human confirmation is required (omitted otherwise). Render the
        // confirm card below the just-rendered answer bubble and lock the input
        // until the user Confirms/Cancels.
        var proposal = response && response.proposal;
        if (hasProposal(proposal)) showProposal(proposal);
      }).catch(function (err) {
        setBusy(false);
        if (thinking.parentNode) thinking.parentNode.removeChild(thinking);
        var status = err && typeof err === 'object' ? err.status : 0;
        // Keep the user's transcript intact so they can retry.
        setNotice(agentErrorMessage(status));
      });
    });

    textarea.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        triggerSubmit();
      }
    });

    // No lazy load() needed — the agent view starts empty with a prompt to
    // ask a question; it's interactive, not data-loaded-on-view.
    return { el: rootEl };
  }

  return {
    // pure
    appendUserMessage: appendUserMessage,
    transcriptStats: transcriptStats,
    exceedsCaps: exceedsCaps,
    toolsUsedLabel: toolsUsedLabel,
    agentErrorMessage: agentErrorMessage,
    diffPairs: diffPairs,
    hasProposal: hasProposal,
    loadPersistedTranscript: loadPersistedTranscript,
    persistTranscript: persistTranscript,
    clearPersistedTranscript: clearPersistedTranscript,
    // render (browser)
    mount: mount,
  };
});

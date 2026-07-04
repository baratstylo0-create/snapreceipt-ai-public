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
    module.exports = factory(require('../escape'), require('../api'));
  } else {
    root.Agent = factory(root.Escape, root.Api);
  }
})(typeof self !== 'undefined' ? self : this, function (Escape, Api) {
  'use strict';

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
    return 'Tools used: ' + seen.join(', ');
  }

  // Map an HTTP status to a fixed, friendly message. Status-only (mirrors
  // upload.js's errorMessage / reports.js's exportErrorMessage) — body text
  // is never surfaced (house convention: never leak server internals).
  // Never throws.
  function agentErrorMessage(status) {
    switch (Number(status)) {
      case 400: return "Sorry, I couldn't understand that request.";
      case 413: return 'This conversation is too long — start a new one to continue.';
      case 502: return 'The assistant is unavailable right now. Please try again in a moment.';
      default:  return 'Something went wrong. Please try again.';
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

  // ---- render layer --------------------------------------------------------

  function mount(section, opts) {
    if (!hasDom() || !section) return null;
    opts = opts || {};
    var apiFetch = opts.apiFetch || (opts.Api && opts.Api.apiFetch) || (Api && Api.apiFetch);

    var rootEl = el('div', 'ag-root');
    section.appendChild(rootEl);

    rootEl.appendChild(msg('ag-intro muted', 'Ask a question about your expenses.'));

    var list = el('div', 'ag-list');
    rootEl.appendChild(list);

    var noticeEl = msg('ag-notice muted', '');
    rootEl.appendChild(noticeEl);

    var form = el('form', 'ag-form');

    var textarea = el('textarea', 'ag-input');
    textarea.rows = 2;
    textarea.setAttribute('placeholder', 'Ask about your expenses…');
    form.appendChild(textarea);

    var actions = el('div', 'ag-actions');

    var sendBtn = el('button', 'ag-send');
    sendBtn.type = 'submit';
    Escape.setText(sendBtn, 'Send');
    actions.appendChild(sendBtn);

    var clearBtn = el('button', 'ag-clear');
    clearBtn.type = 'button';
    Escape.setText(clearBtn, 'New conversation');
    actions.appendChild(clearBtn);

    form.appendChild(actions);
    rootEl.appendChild(form);

    // Client owns the running transcript; the server is stateless. Restored from
    // sessionStorage on mount (e.g. after a page refresh) so the conversation survives.
    var transcript = loadPersistedTranscript();
    var busy = false;

    function setBusy(b) {
      busy = b;
      sendBtn.disabled = b;
    }

    function setNotice(text) {
      Escape.setText(noticeEl, text || '');
    }

    function renderTranscript(lastToolsLabel) {
      clear(list);
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
      clear(list);
      textarea.value = '';
    }

    // Show whatever was restored from sessionStorage (if anything) right away.
    if (transcript.length) renderTranscript();

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
        setNotice(capCheck.reason === 'messages'
          ? 'This conversation is too long — start a new one to continue.'
          : 'This conversation is too long — start a new one to continue.');
        return;
      }

      setNotice('');
      transcript = next;
      persistTranscript(transcript);
      textarea.value = '';
      renderTranscript();

      var thinking = msg('ag-msg ag-msg--assistant ag-thinking muted', 'Thinking…');
      list.appendChild(thinking);
      list.scrollTop = list.scrollHeight;

      setBusy(true);
      apiFetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { messages: transcript },
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
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { cancelable: true }));
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
    loadPersistedTranscript: loadPersistedTranscript,
    persistTranscript: persistTranscript,
    clearPersistedTranscript: clearPersistedTranscript,
    // render (browser)
    mount: mount,
  };
});

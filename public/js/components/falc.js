// components/falc.js — "Falc", the floating expense assistant (Phase 2 of Mugi's
// Treehouse concept). Mugi's design moves the AI chat out of a nav tab and into a
// bottom-right perch: a little peregrine-falcon orb you click to unfurl a chat
// panel. This file is ONLY the floating chrome (perch button + panel shell); the
// actual conversation is the already-shipped, already-tested Agent module
// (components/agent.js) mounted inside the panel body. Reusing Agent means the
// POST /api/agent contract, transcript caps, sessionStorage persistence and
// output-escaping (SOP §7.3) are all inherited unchanged — no duplicated logic.
//
// CSP: every node is built with createElement / createElementNS + textContent
// (never innerHTML), so the strict no-inline policy holds. The bird artwork is a
// static, developer-authored SVG built via createElementNS.
//
// UMD shim: window.Falc in the browser; require()-able in Node (mount no-ops
// without a DOM, so the module is import-safe for the test runner).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./agent'));
  } else {
    root.Falc = factory(root.Agent);
  }
})(typeof self !== 'undefined' ? self : this, function (Agent) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function hasDom() { return typeof document !== 'undefined'; }
  function el(tag, className) { var n = document.createElement(tag); if (className) n.className = className; return n; }

  // Build an SVG element tree from a compact spec: { vb, els:[{t, a:{...}, kids?}] }.
  // Static, developer-authored geometry only — no untrusted input, no innerHTML.
  function svgNode(spec) {
    var node = document.createElementNS(SVG_NS, spec.t);
    if (spec.a) { for (var k in spec.a) { if (Object.prototype.hasOwnProperty.call(spec.a, k)) node.setAttribute(k, spec.a[k]); } }
    if (spec.kids) spec.kids.forEach(function (c) { node.appendChild(svgNode(c)); });
    return node;
  }

  // Mugi's perch bird — a simplified, faithful port of the concept's peregrine
  // orb (body, wing, head, beak, eye + a little wooden perch with a leaf).
  function buildBird() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('aria-hidden', 'true');
    var parts = [
      { t: 'rect', a: { x: '20', y: '84', width: '60', height: '11', rx: '4', fill: '#8a6a44', stroke: '#2b332a', 'stroke-width': '1.7' } },
      { t: 'path', a: { d: 'M76 84 C82 82 86 76 84 71 C78 73 75 78 76 84 Z', fill: '#7d9a52', stroke: '#2b332a', 'stroke-width': '1.4', 'stroke-linejoin': 'round' } },
      { t: 'path', a: { d: 'M55 58 L82 70 L78 78 L53 68 Z', fill: '#41716b', stroke: '#2b332a', 'stroke-width': '1.7', 'stroke-linejoin': 'round' } },
      { t: 'path', a: { d: 'M40 42 C34 56 36 76 50 82 C66 78 67 56 60 44 C56 36 44 36 40 42 Z', fill: '#f4efdb', stroke: '#2b332a', 'stroke-width': '1.9', 'stroke-linejoin': 'round' } },
      { t: 'path', a: { 'class': 'sora-wing', d: 'M52 40 C65 36 80 44 80 60 C72 53 62 52 56 56 C50 50 51 43 52 40 Z', fill: '#41716b', stroke: '#2b332a', 'stroke-width': '1.8', 'stroke-linejoin': 'round' } },
      { t: 'path', a: { d: 'M42 30 C32 32 30 42 38 47 C46 50 56 49 58 41 C60 32 50 28 42 30 Z', fill: '#5f7a47', stroke: '#2b332a', 'stroke-width': '1.8', 'stroke-linejoin': 'round' } },
      { t: 'path', a: { d: 'M32 37 C28 36 26 39 28 42 C31 43 35 41 36 39 Z', fill: '#bb8f46', stroke: '#2b332a', 'stroke-width': '1.3', 'stroke-linejoin': 'round' } },
      { t: 'circle', a: { cx: '44', cy: '37', r: '4.6', fill: '#bb8f46', stroke: '#2b332a', 'stroke-width': '1.4' } },
      { t: 'circle', a: { cx: '44', cy: '37.5', r: '2.8', fill: '#2b332a' } },
      { t: 'circle', a: { cx: '45.2', cy: '36.2', r: '1', fill: '#f4efdb' } },
    ];
    var g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('id', 'sproutBody');
    parts.forEach(function (p) { g.appendChild(svgNode(p)); });
    svg.appendChild(g);
    return svg;
  }

  // Small leaf-orb glyph for the chat panel header.
  function buildOrbGlyph() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.appendChild(svgNode({ t: 'path', a: { d: 'M5 14c2-1 4-1 6 1 2-2 5-3 8-2-1-4-5-6-8-5-4 1-6 4-6 6z', fill: 'var(--accent)' } }));
    svg.appendChild(svgNode({ t: 'circle', a: { cx: '9', cy: '9.5', r: '1.1', fill: 'var(--accent-contrast)' } }));
    return svg;
  }

  // Mount the floating assistant. opts:
  //   root     — where to append (defaults to document.body)
  //   Agent    — the Agent module (defaults to the required/global one)
  //   apiFetch / Api — passed through to Agent.mount for POST /api/agent
  // Returns { el, open, close, toggle, isOpen } or null outside a browser.
  function mount(opts) {
    if (!hasDom()) return null;
    opts = opts || {};
    var mountRoot = opts.root || document.body;
    var AgentMod = opts.Agent || Agent;

    // --- perch (launcher) ---
    var perch = el('div', 'sora-perch');
    var launcher = el('button', 'sora-btn');
    launcher.type = 'button';
    launcher.setAttribute('aria-label', 'Open Falc, your expense assistant');
    launcher.setAttribute('title', 'Falc — your expense assistant');
    launcher.appendChild(buildBird());
    perch.appendChild(launcher);

    // --- chat panel ---
    var panel = el('div', 'sora-chat');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Falc — expense assistant');

    var head = el('div', 'sc-head');
    var orb = el('div', 'sc-orb');
    orb.appendChild(buildOrbGlyph());
    head.appendChild(orb);
    var titleWrap = el('div', 'sc-title');
    var name = el('div', 'sc-name'); name.textContent = 'Falc';
    var status = el('div', 'sc-status'); status.textContent = 'your expense assistant';
    titleWrap.appendChild(name); titleWrap.appendChild(status);
    head.appendChild(titleWrap);
    var closeBtn = el('button', 'sc-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close assistant');
    closeBtn.textContent = '✕';
    head.appendChild(closeBtn);
    panel.appendChild(head);

    var body = el('div', 'sc-body');
    panel.appendChild(body);

    mountRoot.appendChild(perch);
    mountRoot.appendChild(panel);

    // Lazily mount the Agent chat the first time the panel is opened, so a user
    // who never touches Falc pays no cost. Agent.mount builds its own intro,
    // transcript list, notice line and input form inside `body`.
    var chatMounted = false;
    var isOpen = false;

    function ensureChat() {
      if (chatMounted) return;
      chatMounted = true;
      if (AgentMod && typeof AgentMod.mount === 'function') {
        AgentMod.mount(body, opts);
      }
    }
    function open() {
      ensureChat();
      panel.classList.add('open');
      launcher.setAttribute('aria-expanded', 'true');
      isOpen = true;
      var ta = body.querySelector('textarea');
      if (ta) { try { ta.focus(); } catch (e) { /* ignore */ } }
    }
    function close() {
      panel.classList.remove('open');
      launcher.setAttribute('aria-expanded', 'false');
      isOpen = false;
    }
    function toggle() { if (isOpen) close(); else open(); }

    launcher.setAttribute('aria-expanded', 'false');
    launcher.addEventListener('click', toggle);
    closeBtn.addEventListener('click', close);
    // Esc closes the panel when it's open (nice-to-have, keyboard-friendly).
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && isOpen) close();
    });

    return { el: panel, perch: perch, open: open, close: close, toggle: toggle, isOpen: function () { return isOpen; } };
  }

  return { mount: mount, buildBird: buildBird };
});

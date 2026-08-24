'use strict';
// checkDashSession -> touchDevice wiring (P-02a, #35). Cross-lane pre-review on #48 (Codex)
// found that touchDevice was implemented, exported and unit-tested (tests/deviceSessions.test.js)
// but never actually CALLED from the authenticated request path -- so a device's "last seen"
// field was set once at login and then frozen forever, no matter how active the session was.
//
// This file proves the wiring itself, not touchDevice's own internal behaviour (throttle,
// best-effort error swallowing) -- that is already covered where the function is defined.
// The two URL shapes below are NOT interchangeable: lib/auth.js's lookupSession puts
// token_hash first; lib/deviceSessions.js's sessionsUrl puts account_id first. A stub that
// only matched one shape would let this exact regression back in silently.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { checkDash } = require('../routes/expenses');
const { tokenHash } = require('../lib/auth');

function appWithGate() {
  const app = express();
  app.get('/probe', checkDash, (req, res) => res.json({ ok: true, scope: req.scope || null }));
  return app;
}

async function get(app, headers = {}) {
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/probe', { headers });
    return { status: r.status, json: await r.json().catch(() => null) };
  } finally { srv.close(); }
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

// Stubs BOTH request shapes touchDevice's wiring depends on: the GET lookupSession uses to
// resolve the bearer, and the PATCH touchDevice fires to bookkeep it. Everything else
// (notably the test's own probe request) goes to the real fetch.
function stubSessionsAndTouches(rowFor) {
  const realFetch = global.fetch;
  const patches = [];
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    const method = (opt.method || 'GET').toUpperCase();
    // lookupSession (lib/auth.js): token_hash=eq. comes FIRST.
    if (method === 'GET' && u.includes('/sessions?token_hash=eq.')) {
      const m = /token_hash=eq\.([0-9a-f]+)/.exec(u);
      const row = m ? rowFor(m[1]) : undefined;
      return { text: async () => JSON.stringify(row ? [row] : []) };
    }
    // touchDevice (lib/deviceSessions.js sessionsUrl): account_id=eq. comes FIRST,
    // token_hash=eq. is a LATER query param -- deliberately a different shape from the
    // lookup above, so a stub that only matched one would miss the other.
    if (method === 'PATCH' && u.includes('/sessions?') && u.includes('token_hash=eq.')) {
      const m = /token_hash=eq\.([0-9a-f]+)/.exec(u);
      patches.push({ tokenHash: m && m[1], body: opt.body ? JSON.parse(opt.body) : null });
      return { text: async () => JSON.stringify([{ ok: true }]) };
    }
    return realFetch(url, opt);
  };
  return { patches, restore: () => { global.fetch = realFetch; } };
}

test('an authenticated dashboard request touches the session (last_seen_at is bookkept)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const token = 'touchdevice-live-token';
    const hash = tokenHash(token);
    const stub = stubSessionsAndTouches((h) => h === hash
      ? { user_id: 'u1', account_id: 'default', role: 'clerk', branch_id: 'b1',
          expires_at: new Date(Date.now() + 60000).toISOString() }
      : undefined);
    try {
      const { status } = await get(appWithGate(), {
        Authorization: 'Bearer ' + token,
        'User-Agent': 'IntegrationProbe/1.0',
      });
      assert.strictEqual(status, 200, 'the fix must not change checkDashSession\'s own outcome');

      // touchDevice is fire-and-forget (not awaited by checkDashSession, deliberately -- see
      // the comment at the call site), so give its microtask/promise chain a tick to run
      // before asserting on it.
      await new Promise((resolve) => setImmediate(resolve));

      assert.strictEqual(stub.patches.length, 1,
        'exactly one PATCH to bookkeep last_seen_at was expected for this request');
      assert.strictEqual(stub.patches[0].tokenHash, hash,
        'the PATCH must target the SAME session the request authenticated with');
      assert.ok(stub.patches[0].body && stub.patches[0].body.last_seen_at,
        'the patch body must actually carry a last_seen_at timestamp');
    } finally { stub.restore(); }
  });
});

test('a FAILED auth attempt never reaches touchDevice (nothing to bookkeep for a rejected request)', async () => {
  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    const stub = stubSessionsAndTouches(() => undefined); // no session ever matches
    try {
      const { status } = await get(appWithGate(), { Authorization: 'Bearer ghost-token' });
      assert.strictEqual(status, 401);
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(stub.patches.length, 0, 'a denied request must not write any bookkeeping');
    } finally { stub.restore(); }
  });
});

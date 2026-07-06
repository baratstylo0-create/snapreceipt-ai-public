'use strict';
// Business-account login/logout (ADR-021 Phase 1). Only mounted-behaviour when
// capabilities.multiUser is ON; with the flag OFF both routes 404 (the personal
// product has no login concept — it uses the static DASHBOARD_TOKEN). Admin/clerk
// exchange username+password for an opaque session bearer; staff never log in.
const express = require('express');
const { sbSelect } = require('../lib/supabase');
const { verifyPassword, mintSession, lookupSession, revokeSessionsForUser } = require('../lib/auth');
const { getCapabilities } = require('../lib/account');
const { createRateLimiter } = require('../lib/ratelimit');

// Brute-force defense on the credential endpoint (§7.2). Per-IP fixed window.
const loginLimiter = createRateLimiter({ max: Number(process.env.LOGIN_RATE_MAX) || 20 });

// A constant, well-formed scrypt hash for the unknown-user path so verifyPassword does
// real work (equal-ish timing) whether or not the username exists — no user enumeration
// via response timing. The password is unknowable, so this never authenticates anyone.
const DUMMY_HASH = 'scrypt$00000000000000000000000000000000$'
  + '0000000000000000000000000000000000000000000000000000000000000000';

module.exports = function mountAuth(app) {
  // POST /api/login { username, password } -> { token, role, branch_id, display_name }
  app.post('/api/login', express.json({ limit: '16kb' }), (req, res) => loginLimiter(req, res, async () => {
    if (!getCapabilities().multiUser) return res.status(404).json({ error: 'not found' });
    const { username, password } = req.body || {};
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'username and password are required' });
    }
    try {
      const rows = await sbSelect('users', { eq: { username, active: true }, limit: 1 });
      const user = rows[0];
      // Always verify (dummy hash for unknown user) to keep timing uniform.
      const ok = await verifyPassword(password, user && user.password_hash ? user.password_hash : DUMMY_HASH);
      // staff never log in (no username/hash), and a null-hash row can't authenticate.
      if (!user || !ok || user.role === 'staff') return res.status(401).json({ error: 'invalid credentials' });
      const token = await mintSession(user);
      return res.json({
        token,
        role: user.role,
        branch_id: user.branch_id || null,
        display_name: user.display_name || '',
      });
    } catch (e) {
      console.error('[login]', e.message);
      return res.status(502).json({ error: 'login failed' });
    }
  }));

  // POST /api/logout — revokes ALL sessions for the bearer's user (logs out every
  // device; the safe default for v1). Idempotent: unknown/absent token still 200s.
  app.post('/api/logout', express.json({ limit: '4kb' }), async (req, res) => {
    if (!getCapabilities().multiUser) return res.status(404).json({ error: 'not found' });
    const a = req.get('Authorization') || '';
    const token = a.startsWith('Bearer ') ? a.slice(7) : '';
    try {
      const sess = await lookupSession(token);
      if (sess) await revokeSessionsForUser(sess.user_id);
      return res.json({ ok: true });
    } catch (e) {
      console.error('[logout]', e.message);
      return res.status(502).json({ error: 'logout failed' });
    }
  });
};

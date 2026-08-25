'use strict';
// routes/auth.js — the P-01 email-verification endpoints (issue #34):
//   POST /api/verify-email/request, POST /api/verify-email/confirm, GET /api/verify-email/status
// plus the additive verification fields on /api/signup and /api/login.
//
// These env vars MUST be set before the requires below: lib/config.js snapshots process.env
// into `cfg` at require time, so setting them later would be read too late and the mail
// assertions would silently test nothing.
process.env.CAP_PERSONAL_AUTH = 'true';
process.env.RESEND_API_KEY = 're_test_key_not_real';
process.env.RESEND_FROM_EMAIL = 'noreply@snapreceipt.test';
process.env.PUBLIC_URL = 'https://app.snapreceipt.test';
// The limiters in routes/auth.js are module-level fixed-window counters, so every request in
// this FILE shares one bucket. Left at their production defaults (6 requests/minute) the
// suite starts 429-ing itself partway through and the later tests assert nothing. Raised
// here so each test measures its own behaviour; that the limiter is genuinely wired to these
// endpoints is asserted separately, by the RateLimit headers, at the bottom of this file.
process.env.VERIFY_EMAIL_REQUEST_RATE_MAX = '1000';
process.env.VERIFY_EMAIL_CONFIRM_RATE_MAX = '1000';
process.env.SIGNUP_RATE_MAX = '1000';
process.env.LOGIN_RATE_MAX = '1000';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { createFakePostgrest } = require('./fixtures/fakePostgrest');
const mountAuth = require('../routes/auth');
const { tokenHash } = require('../lib/auth');
const ec = require('../lib/emailChallenge');

const NOW_ISO = new Date().toISOString();
const FUTURE = new Date(Date.now() + 10 * 60 * 1000).toISOString();

function app() {
  const a = express();
  a.set('trust proxy', true);
  mountAuth(a);
  return a;
}

function ownerRow(over = {}) {
  return {
    id: 'u-owner', account_id: 'default', role: 'owner', username: 'ann@example.com',
    password_hash: 'scrypt$aa$bb', display_name: 'Ann', active: true,
    email_verified_at: null, ...over,
  };
}

// A fake Supabase PLUS a capture of anything the Resend SDK tries to send, so the tests can
// assert on the actual outbound email (its code, and critically the origin of its link)
// without ever reaching the network.
function withServer(seed, fn) {
  const fake = createFakePostgrest(seed);
  const mail = [];
  const realFetch = global.fetch;
  fake.install();
  const afterFake = global.fetch;
  global.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (u.includes('resend.com')) {
      mail.push(opt.body ? JSON.parse(opt.body) : {});
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ id: 'mail-1' }), json: async () => ({ id: 'mail-1' }) };
    }
    return afterFake(url, opt);
  };
  const srv = app().listen(0);
  const { port } = srv.address();
  const base = 'http://127.0.0.1:' + port;

  async function req(method, path, { headers = {}, body } = {}) {
    // The probe itself must use the REAL fetch, or it would be swallowed by the stub above.
    const r = await realFetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
  }

  return Promise.resolve()
    .then(() => fn({ req, db: fake.db, mail }))
    .finally(() => { srv.close(); global.fetch = realFetch; });
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

// ---- flag gating -----------------------------------------------------------

test('all three endpoints 404 when personalAuth is off', async () => {
  await withEnv({ CAP_PERSONAL_AUTH: 'false' }, async () => {
    await withServer({ users: [ownerRow()] }, async ({ req }) => {
      assert.strictEqual((await req('POST', '/api/verify-email/request', { body: { email: 'ann@example.com' } })).status, 404);
      assert.strictEqual((await req('POST', '/api/verify-email/confirm', { body: { code: '123456' } })).status, 404);
      assert.strictEqual((await req('GET', '/api/verify-email/status', { headers: { Authorization: 'Bearer x' } })).status, 404);
    });
  });
});

// ---- request ---------------------------------------------------------------

test('request: a real address gets a code, and the reply says nothing specific', async () => {
  await withServer({ users: [ownerRow()] }, async ({ req, db, mail }) => {
    const { status, json } = await req('POST', '/api/verify-email/request', { body: { email: 'ann@example.com' } });
    assert.strictEqual(status, 200);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(db.email_challenges.length, 1);
    assert.strictEqual(mail.length, 1, 'one verification email is sent');
    assert.strictEqual(mail[0].to, 'ann@example.com');
  });
});

test('request: an unknown address gets the IDENTICAL reply and no email', async () => {
  await withServer({ users: [ownerRow()] }, async ({ req, db, mail }) => {
    const known = await req('POST', '/api/verify-email/request', { body: { email: 'ann@example.com' } });
    const unknown = await req('POST', '/api/verify-email/request', { body: { email: 'ghost@example.com' } });

    // Compare the parts a caller can actually read as signal. (RateLimit-Remaining naturally
    // differs between two sequential calls and carries no account information.)
    assert.deepStrictEqual(
      { status: unknown.status, json: unknown.json },
      { status: known.status, json: known.json },
      'the two responses must be indistinguishable');
    assert.strictEqual(db.email_challenges.length, 1, 'no challenge for a non-account');
    assert.strictEqual(mail.length, 1, 'no email to a non-account');
  });
});

test('request: junk input still gets the same 200, never a validation error', async () => {
  // A 400 on a malformed address and a 200 on a well-formed one is itself a weak oracle, and
  // it also hands a scanner a cheap way to distinguish handled from unhandled input.
  await withServer({ users: [ownerRow()] }, async ({ req }) => {
    for (const body of [{}, { email: null }, { email: 123 }, { email: 'not-an-email' }, { email: ['a@b.c'] }]) {
      const r = await req('POST', '/api/verify-email/request', { body });
      assert.strictEqual(r.status, 200, 'body ' + JSON.stringify(body));
      assert.strictEqual(r.json.ok, true);
    }
  });
});

test('request: the mailed link is built from PUBLIC_URL and IGNORES a hostile Host header', async () => {
  // Guards against the reset-link-poisoning finding (High) recorded in the 2026-08-24 gap
  // audit against /api/forgot-password. The new path must never derive a mailed link from a
  // header the caller controls.
  await withServer({ users: [ownerRow()] }, async ({ req, mail }) => {
    await req('POST', '/api/verify-email/request', {
      headers: { Host: 'evil.example.com', 'X-Forwarded-Host': 'evil.example.com' },
      body: { email: 'ann@example.com' },
    });
    assert.strictEqual(mail.length, 1);
    const blob = JSON.stringify(mail[0]);
    assert.ok(blob.includes('https://app.snapreceipt.test/?verify_token='),
      'the link must come from PUBLIC_URL');
    assert.ok(!blob.includes('evil.example.com'),
      'a caller-supplied Host must never appear in an outbound email');
  });
});

test('request: an already-verified address is not a mailbomb target', async () => {
  await withServer({ users: [ownerRow({ email_verified_at: NOW_ISO })] }, async ({ req, mail }) => {
    const r = await req('POST', '/api/verify-email/request', { body: { email: 'ann@example.com' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(mail.length, 0, 'nothing is sent to an address that is already confirmed');
  });
});

// ---- confirm ---------------------------------------------------------------

test('confirm: the right code verifies the account', async () => {
  await withServer({ users: [ownerRow()] }, async ({ req, db, mail }) => {
    await req('POST', '/api/verify-email/request', { body: { email: 'ann@example.com' } });
    const code = String(mail[0].text.match(/code is: (\d{6})/)[1]);

    const r = await req('POST', '/api/verify-email/confirm', { body: { email: 'ann@example.com', code } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { ok: true, email_verified: true });
    assert.ok(db.users[0].email_verified_at, 'the user row is stamped');
  });
});

test('confirm: the magic-link token verifies the account', async () => {
  await withServer({ users: [ownerRow()] }, async ({ req, db, mail }) => {
    await req('POST', '/api/verify-email/request', { body: { email: 'ann@example.com' } });
    const token = decodeURIComponent(mail[0].text.match(/verify_token=([^\s]+)/)[1]);

    const r = await req('POST', '/api/verify-email/confirm', { body: { token } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.email_verified, true);
    assert.strictEqual(db.email_challenges[0].token_hash, tokenHash(token));
    assert.ok(db.users[0].email_verified_at);
  });
});

test('confirm: a wrong code is a 400 with the generic message, and does not verify', async () => {
  await withServer({ users: [ownerRow()] }, async ({ req, db, mail }) => {
    await req('POST', '/api/verify-email/request', { body: { email: 'ann@example.com' } });
    const code = String(mail[0].text.match(/code is: (\d{6})/)[1]);
    const wrong = code === '000000' ? '111111' : '000000';

    const r = await req('POST', '/api/verify-email/confirm', { body: { email: 'ann@example.com', code: wrong } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, ec.GENERIC_FAIL);
    assert.strictEqual(db.users[0].email_verified_at, null);
  });
});

test('confirm: replaying a consumed code is refused', async () => {
  await withServer({ users: [ownerRow()] }, async ({ req, mail }) => {
    await req('POST', '/api/verify-email/request', { body: { email: 'ann@example.com' } });
    const code = String(mail[0].text.match(/code is: (\d{6})/)[1]);
    const body = { email: 'ann@example.com', code };

    assert.strictEqual((await req('POST', '/api/verify-email/confirm', { body })).status, 200);
    const replay = await req('POST', '/api/verify-email/confirm', { body });
    assert.strictEqual(replay.status, 400);
    assert.strictEqual(replay.json.error, ec.GENERIC_FAIL);
  });
});

test('confirm: unknown-account and wrong-code answers are indistinguishable', async () => {
  await withServer({ users: [ownerRow()] }, async ({ req }) => {
    const ghost = await req('POST', '/api/verify-email/confirm', { body: { email: 'ghost@example.com', code: '123456' } });
    const real = await req('POST', '/api/verify-email/confirm', { body: { email: 'ann@example.com', code: '123456' } });
    assert.deepStrictEqual(
      { status: ghost.status, json: ghost.json },
      { status: real.status, json: real.json },
      'responses must be indistinguishable');
  });
});

test('the new endpoints are actually behind a rate limiter', async () => {
  // This file raises the limits so the suite does not throttle itself (see the top). That
  // makes it worth asserting separately that the limiter is genuinely mounted rather than
  // configured away — createRateLimiter emits the IETF RateLimit trio on EVERY response, so
  // their presence is proof the middleware ran.
  await withServer({ users: [ownerRow()] }, async ({ req }) => {
    for (const [method, path, body] of [
      ['POST', '/api/verify-email/request', { email: 'ann@example.com' }],
      ['POST', '/api/verify-email/confirm', { email: 'ann@example.com', code: '123456' }],
    ]) {
      const r = await req(method, path, { body });
      assert.ok(r.headers.get('ratelimit-limit'), method + ' ' + path + ' must carry RateLimit-Limit');
      assert.ok(r.headers.get('ratelimit-remaining') !== null, path + ' must carry RateLimit-Remaining');
    }
  });
});

test('confirm: a caller cannot verify someone else by naming a different email', async () => {
  await withServer({
    users: [ownerRow(), ownerRow({ id: 'u-two', username: 'bob@example.com' })],
  }, async ({ req, db, mail }) => {
    await req('POST', '/api/verify-email/request', { body: { email: 'ann@example.com' } });
    const annCode = String(mail[0].text.match(/code is: (\d{6})/)[1]);

    const r = await req('POST', '/api/verify-email/confirm', { body: { email: 'bob@example.com', code: annCode } });
    assert.strictEqual(r.status, 400, "Ann's code must not verify Bob");
    const bob = db.users.find((u) => u.id === 'u-two');
    assert.strictEqual(bob.email_verified_at, null);
  });
});

// ---- status ----------------------------------------------------------------

test('status: requires a session', async () => {
  await withServer({ users: [ownerRow()] }, async ({ req }) => {
    assert.strictEqual((await req('GET', '/api/verify-email/status')).status, 401);
    assert.strictEqual((await req('GET', '/api/verify-email/status', { headers: { Authorization: 'Bearer nope' } })).status, 401);
  });
});

test('status: reports the verification state for the session holder', async () => {
  const raw = 'session-token-abc';
  const seed = {
    users: [ownerRow()],
    sessions: [{ token_hash: tokenHash(raw), user_id: 'u-owner', account_id: 'default', role: 'owner', branch_id: null, expires_at: FUTURE }],
  };
  await withServer(seed, async ({ req }) => {
    const before = await req('GET', '/api/verify-email/status', { headers: { Authorization: 'Bearer ' + raw } });
    assert.strictEqual(before.status, 200);
    assert.strictEqual(before.json.verified, false);
    assert.strictEqual(before.json.email, 'ann@example.com');
    assert.strictEqual(before.json.verification_required, false, 'the enforcement flag defaults off');
  });
});

test('status: flips to verified once a challenge is confirmed', async () => {
  const raw = 'session-token-xyz';
  const seed = {
    users: [ownerRow()],
    sessions: [{ token_hash: tokenHash(raw), user_id: 'u-owner', account_id: 'default', role: 'owner', branch_id: null, expires_at: FUTURE }],
  };
  await withServer(seed, async ({ req, mail }) => {
    await req('POST', '/api/verify-email/request', { body: { email: 'ann@example.com' } });
    const code = String(mail[0].text.match(/code is: (\d{6})/)[1]);
    await req('POST', '/api/verify-email/confirm', { body: { email: 'ann@example.com', code } });

    const after = await req('GET', '/api/verify-email/status', { headers: { Authorization: 'Bearer ' + raw } });
    assert.strictEqual(after.json.verified, true);
    assert.ok(after.json.verified_at, 'and reports WHEN, for the P-07 evidence trail');
  });
});

// 2026-08-25 regression (live incident — Google-login redirect bug, root-caused via pm2
// logs + a direct DB check): every test above uses account_id: 'default', which happens to
// equal cfg.ACCOUNT_ID's own fallback, so the handler's `sbSelect('users', {eq:{id:
// sess.user_id}})` with no `scope` would have passed them even with the bug this test
// catches. A real migrated personal account (its own unique account_id, e.g. "p_<uuid>",
// every signup since 2026-08-14) got a 401 here on every call — this is what forced the
// full-app logout+reload the user reported, ~19s into a fresh Google login.
test('status: 200s for a MIGRATED account (non-default account_id) — the exact live bug', async () => {
  const raw = 'session-token-migrated';
  const seed = {
    users: [ownerRow({ id: 'u-migrated', account_id: 'p_migrated123' })],
    sessions: [{ token_hash: tokenHash(raw), user_id: 'u-migrated', account_id: 'p_migrated123', role: 'owner', branch_id: null, expires_at: FUTURE }],
  };
  await withServer(seed, async ({ req }) => {
    const r = await req('GET', '/api/verify-email/status', { headers: { Authorization: 'Bearer ' + raw } });
    assert.strictEqual(r.status, 200, 'a valid, unexpired session for a migrated account must not 401 here');
    assert.strictEqual(r.json.email, 'ann@example.com');
    assert.strictEqual(r.json.verified, false);
  });
});

// ---- the additive fields on the existing endpoints --------------------------

test('login: an owner learns their verification state; a clerk is not told anything', async () => {
  const { hashPassword } = require('../lib/auth');
  const hash = await hashPassword('correct horse battery');

  await withServer({ users: [ownerRow({ password_hash: hash })] }, async ({ req }) => {
    const r = await req('POST', '/api/login', { body: { username: 'ann@example.com', password: 'correct horse battery' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.email_verified, false);
    assert.strictEqual(r.json.verification_required, false);
  });

  await withEnv({ CAP_MULTI_USER: 'true' }, async () => {
    await withServer({
      users: [ownerRow({ id: 'u-clerk', role: 'clerk', branch_id: 'b1', username: 'clerk1', password_hash: hash })],
    }, async ({ req }) => {
      const r = await req('POST', '/api/login', { body: { username: 'clerk1', password: 'correct horse battery' } });
      assert.strictEqual(r.status, 200);
      assert.ok(!('email_verified' in r.json),
        'business identities have no self-serve email flow, so claiming a state would be meaningless');
    });
  });
});

test('signup: creates the account, mails a challenge, and reports it is unverified', async () => {
  await withServer({ users: [] }, async ({ req, db, mail }) => {
    const r = await req('POST', '/api/signup', { body: { email: 'new@example.com', password: 'hunter2hunter2' } });
    assert.strictEqual(r.status, 201);
    assert.ok(r.json.token, 'a session is still minted — signup is not a blocking wall');
    assert.strictEqual(r.json.email_verified, false);
    assert.strictEqual(r.json.verification_required, false);
    assert.strictEqual(db.email_challenges.length, 1, 'a challenge row is written');
    assert.strictEqual(mail.length, 1, 'and a confirmation email goes out');
    assert.strictEqual(mail[0].to, 'new@example.com');
    assert.match(mail[0].text, /code is: \d{6}/);
  });
});

test('signup: still succeeds when the verification email cannot be issued', async () => {
  // Recovery path. The account exists and the session is valid the moment signupOwner
  // returns; a mail or challenge failure after that must never turn into a failed signup the
  // user cannot retry (they would be unable to sign up again — the email is now taken).
  await withServer({ users: [] }, async ({ req, db }) => {
    const realFetch = global.fetch;
    let calls = 0;
    global.fetch = async (url, opt) => {
      // Fail only the challenge INSERT, letting user/session/session-mint writes through.
      if (String(url).includes('/email_challenges') && (opt && opt.method) === 'POST') {
        calls += 1;
        throw new Error('simulated challenge-store outage');
      }
      return realFetch(url, opt);
    };
    try {
      const r = await req('POST', '/api/signup', { body: { email: 'resilient@example.com', password: 'hunter2hunter2' } });
      assert.strictEqual(r.status, 201, 'signup must survive a verification-side failure');
      assert.ok(r.json.token);
      assert.strictEqual(calls, 1, 'the challenge insert was genuinely attempted and failed');
      assert.ok(db.users.some((u) => u.username === 'resilient@example.com'), 'the account still exists');
    } finally { global.fetch = realFetch; }
  });
});

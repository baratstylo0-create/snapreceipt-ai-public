'use strict';
// lib/emailChallenge.js — the P-01 verified-email challenge service (issue #34).
//
// These are the security tests, not the smoke tests. Each one names the property it is
// defending, because the point of the suite is that a future refactor which quietly breaks
// single-use, the attempt budget, hashing-at-rest or the no-enumeration contract fails HERE
// rather than in production.
//
// Supabase is stood up by tests/fixtures/fakePostgrest.js, which really evaluates the
// PostgREST filters. That matters: the replay and compare-and-swap defences live in the
// UPDATE's WHERE clause, so a filter-ignoring stub would make those assertions vacuous.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { createFakePostgrest } = require('./fixtures/fakePostgrest');
const ec = require('../lib/emailChallenge');
const { tokenHash } = require('../lib/auth');

const NOW = Date.parse('2026-08-24T10:00:00.000Z');
const MIN = 60 * 1000;

function owner(over = {}) {
  return {
    id: 'u-owner', account_id: 'default', role: 'owner', username: 'ann@example.com',
    password_hash: 'scrypt$aa$bb', display_name: 'Ann', active: true,
    email_verified_at: null, ...over,
  };
}

// Runs fn with a fake Supabase installed, always restoring global.fetch.
async function withDb(seed, fn) {
  const fake = createFakePostgrest(seed);
  fake.install();
  try { return await fn(fake); } finally { fake.restore(); }
}

// ---- issuing ---------------------------------------------------------------

test('issueChallenge: the raw code and token are NEVER persisted — only their sha-256', async () => {
  await withDb({ users: [owner()] }, async (fake) => {
    const { code, token } = await ec.issueChallenge(owner(), NOW);
    const row = fake.db.email_challenges[0];
    const serialised = JSON.stringify(row);

    assert.ok(!serialised.includes(code), 'the 6-digit code must not appear anywhere in the row');
    assert.ok(!serialised.includes(token), 'the magic-link token must not appear anywhere in the row');
    assert.strictEqual(row.code_hash, tokenHash(code));
    assert.strictEqual(row.token_hash, tokenHash(token));
    // and the hashes must not be trivially reversible to the stored email either
    assert.notStrictEqual(row.code_hash, row.token_hash);
  });
});

test('issueChallenge: snapshots the address, sets an expiry and a guess budget', async () => {
  await withDb({ users: [owner()] }, async (fake) => {
    await ec.issueChallenge(owner(), NOW);
    const row = fake.db.email_challenges[0];
    assert.strictEqual(row.email, 'ann@example.com');
    assert.strictEqual(row.purpose, 'verify_email');
    assert.strictEqual(row.attempts, 0);
    assert.strictEqual(row.max_attempts, ec.MAX_ATTEMPTS);
    assert.strictEqual(Date.parse(row.expires_at), NOW + ec.VERIFY_TTL_MS);
    assert.strictEqual(row.consumed_at, null);
  });
});

test('genCode: 6 digits, zero-padded, from the CSPRNG', async () => {
  const seen = new Set();
  for (let i = 0; i < 3000; i += 1) {
    const c = ec.genCode();
    assert.match(c, /^[0-9]{6}$/, 'codes must always be exactly 6 digits (padding included)');
    seen.add(c);
  }
  // A constant or near-constant generator would collapse this set. 3000 draws from 10^6
  // should yield well over 2900 distinct values.
  assert.ok(seen.size > 2900, 'codes must not repeat like this (' + seen.size + '/3000 distinct)');
});

// ---- requesting (enumeration + mailbomb) -----------------------------------

test('requestVerification: returns null for an unknown address (no account leak)', async () => {
  await withDb({ users: [owner()] }, async (fake) => {
    assert.strictEqual(await ec.requestVerification('nobody@example.com', NOW), null);
    assert.strictEqual((fake.db.email_challenges || []).length, 0, 'no challenge row for a non-account');
  });
});

test('requestVerification: business (clerk/admin) identities are out of scope — null', async () => {
  await withDb({ users: [owner({ role: 'clerk', branch_id: 'b1' })] }, async () => {
    assert.strictEqual(await ec.requestVerification('ann@example.com', NOW), null);
  });
});

test('requestVerification: an inactive account gets nothing', async () => {
  await withDb({ users: [owner({ active: false })] }, async () => {
    assert.strictEqual(await ec.requestVerification('ann@example.com', NOW), null);
  });
});

test('requestVerification: an already-verified address gets nothing (anti-mailbomb)', async () => {
  await withDb({ users: [owner({ email_verified_at: '2026-08-01T00:00:00.000Z' })] }, async (fake) => {
    assert.strictEqual(await ec.requestVerification('ann@example.com', NOW), null);
    assert.strictEqual((fake.db.email_challenges || []).length, 0);
  });
});

test('requestVerification: the resend cooldown holds, then releases', async () => {
  await withDb({ users: [owner()] }, async (fake) => {
    const first = await ec.requestVerification('ann@example.com', NOW);
    assert.ok(first && first.code, 'the first request issues a challenge');
    // created_at is a DB default (now()) in production, so the fake stamps it from the wall
    // clock. Pin it to the injected clock or the cooldown arithmetic below compares two
    // different timelines and the test proves nothing.
    fake.db.email_challenges[0].created_at = new Date(NOW).toISOString();

    // Inside the cooldown: refused, and — critically — NO second row is written, so an
    // attacker cannot flood a victim's inbox by rotating source IPs past the rate limiter.
    const tooSoon = await ec.requestVerification('ann@example.com', NOW + ec.RESEND_COOLDOWN_MS - 1);
    assert.strictEqual(tooSoon, null);
    assert.strictEqual(fake.db.email_challenges.length, 1, 'no extra challenge inside the cooldown');

    const later = await ec.requestVerification('ann@example.com', NOW + ec.RESEND_COOLDOWN_MS + 1);
    assert.ok(later && later.code, 'a fresh code is available once the cooldown lapses');
    assert.strictEqual(fake.db.email_challenges.length, 2);
  });
});

// ---- confirming by code ----------------------------------------------------

test('confirmByCode: the happy path verifies the account and consumes the challenge', async () => {
  await withDb({ users: [owner()] }, async (fake) => {
    const { code } = await ec.issueChallenge(owner(), NOW);
    const res = await ec.confirmByCode('ann@example.com', code, NOW + MIN);

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.userId, 'u-owner');
    assert.strictEqual(Date.parse(fake.db.users[0].email_verified_at), NOW + MIN);
    assert.ok(fake.db.email_challenges[0].consumed_at, 'the challenge is marked consumed');
  });
});

test('confirmByCode: the address is normalised, so case/space variants still work', async () => {
  await withDb({ users: [owner()] }, async () => {
    const { code } = await ec.issueChallenge(owner(), NOW);
    const res = await ec.confirmByCode('  Ann@Example.COM ', code, NOW + MIN);
    assert.strictEqual(res.ok, true);
  });
});

test('confirmByCode: SINGLE USE — the same correct code cannot be replayed', async () => {
  await withDb({ users: [owner()] }, async () => {
    const { code } = await ec.issueChallenge(owner(), NOW);
    assert.strictEqual((await ec.confirmByCode('ann@example.com', code, NOW + MIN)).ok, true);

    const replay = await ec.confirmByCode('ann@example.com', code, NOW + 2 * MIN);
    assert.strictEqual(replay.ok, false, 'a consumed challenge must never verify again');
    assert.strictEqual(replay.error, ec.GENERIC_FAIL);
  });
});

test('confirmByCode: a wrong code fails and SPENDS an attempt', async () => {
  await withDb({ users: [owner()] }, async (fake) => {
    const { code } = await ec.issueChallenge(owner(), NOW);
    const wrong = code === '000000' ? '111111' : '000000';

    const res = await ec.confirmByCode('ann@example.com', wrong, NOW + MIN);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(fake.db.email_challenges[0].attempts, 1, 'a wrong guess must cost a slot');
    assert.strictEqual(fake.db.users[0].email_verified_at, null, 'and must not verify anything');
  });
});

test('confirmByCode: the per-challenge budget is final — a CORRECT code is refused once spent', async () => {
  await withDb({ users: [owner()] }, async (fake) => {
    const { code } = await ec.issueChallenge(owner(), NOW);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < ec.MAX_ATTEMPTS; i += 1) {
      const r = await ec.confirmByCode('ann@example.com', wrong, NOW + MIN);
      assert.strictEqual(r.ok, false);
    }
    assert.strictEqual(fake.db.email_challenges[0].attempts, ec.MAX_ATTEMPTS);

    // This is the property that a rate limiter alone cannot provide: the limiter's window
    // resets, this budget does not.
    const withRightCode = await ec.confirmByCode('ann@example.com', code, NOW + 10 * MIN);
    assert.strictEqual(withRightCode.ok, false, 'budget exhausted must beat a correct code');
    assert.strictEqual(fake.db.users[0].email_verified_at, null);
  });
});

test('confirmByCode: an expired challenge is refused even with the right code', async () => {
  await withDb({ users: [owner()] }, async (fake) => {
    const { code } = await ec.issueChallenge(owner(), NOW);
    const res = await ec.confirmByCode('ann@example.com', code, NOW + ec.VERIFY_TTL_MS + 1);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(fake.db.users[0].email_verified_at, null);
  });
});

test('confirmByCode: expiry is exclusive at the boundary (still valid one ms before)', async () => {
  await withDb({ users: [owner()] }, async () => {
    const { code } = await ec.issueChallenge(owner(), NOW);
    const res = await ec.confirmByCode('ann@example.com', code, NOW + ec.VERIFY_TTL_MS - 1);
    assert.strictEqual(res.ok, true);
  });
});

test('confirmByCode: malformed input is rejected without touching the database', async () => {
  await withDb({ users: [owner()] }, async (fake) => {
    await ec.issueChallenge(owner(), NOW);
    const before = fake.requests.length;
    for (const bad of [null, undefined, '', '12345', '1234567', 'abcdef', '12 345', '  ', { }, ['123456']]) {
      const r = await ec.confirmByCode('ann@example.com', bad, NOW + MIN);
      assert.strictEqual(r.ok, false, 'rejected: ' + JSON.stringify(bad));
      assert.strictEqual(r.error, ec.GENERIC_FAIL);
    }
    assert.strictEqual(fake.requests.length, before, 'malformed codes must not cost a DB round-trip');
    assert.strictEqual(fake.db.email_challenges[0].attempts, 0, 'nor an attempt slot');
  });
});

test('confirmByCode: a challenge issued to a DIFFERENT address cannot verify the current one', async () => {
  await withDb({ users: [owner()] }, async (fake) => {
    const { code } = await ec.issueChallenge(owner(), NOW);
    // Simulate an email change after the challenge was issued.
    fake.db.users[0].username = 'ann.new@example.com';
    fake.db.email_challenges[0].user_id = 'u-owner';

    const res = await ec.confirmByCode('ann.new@example.com', code, NOW + MIN);
    assert.strictEqual(res.ok, false, 'the snapshot on the row must not match the new address');
    assert.strictEqual(fake.db.users[0].email_verified_at, null);
  });
});

test('confirmByCode: an already-verified account is NOT an oracle (no early success)', async () => {
  // The regression this locks down: an early `if (user.email_verified_at) return ok` would
  // let anyone submit a junk code and learn from the response that the address exists and is
  // verified. The answer must be indistinguishable from any other failure.
  await withDb({ users: [owner({ email_verified_at: '2026-08-01T00:00:00.000Z' })] }, async () => {
    const res = await ec.confirmByCode('ann@example.com', '123456', NOW);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, ec.GENERIC_FAIL);
  });
});

test('confirmByCode: every failure mode returns the identical message (no enumeration)', async () => {
  const messages = new Set();
  await withDb({ users: [owner()] }, async (fake) => {
    // unknown address
    messages.add((await ec.confirmByCode('nobody@example.com', '123456', NOW)).error);
    // known address, no challenge at all
    messages.add((await ec.confirmByCode('ann@example.com', '123456', NOW)).error);
    // known address, wrong code
    const { code } = await ec.issueChallenge(owner(), NOW);
    const wrong = code === '000000' ? '111111' : '000000';
    messages.add((await ec.confirmByCode('ann@example.com', wrong, NOW + MIN)).error);
    // expired
    messages.add((await ec.confirmByCode('ann@example.com', code, NOW + ec.VERIFY_TTL_MS + 1)).error);
    // malformed
    messages.add((await ec.confirmByCode('ann@example.com', 'nope', NOW)).error);
    assert.ok(fake.db.users[0].email_verified_at === null);
  });
  assert.strictEqual(messages.size, 1, 'all failures must be indistinguishable, got: ' + [...messages].join(' | '));
});

test('confirmByCode: two concurrent confirms of one challenge — exactly one wins', async () => {
  await withDb({ users: [owner()] }, async (fake) => {
    const { code } = await ec.issueChallenge(owner(), NOW);
    const results = await Promise.all([
      ec.confirmByCode('ann@example.com', code, NOW + MIN),
      ec.confirmByCode('ann@example.com', code, NOW + MIN),
    ]);
    const wins = results.filter((r) => r.ok).length;
    assert.strictEqual(wins, 1, 'exactly one concurrent confirm may succeed, got ' + wins);
    assert.ok(fake.db.email_challenges[0].consumed_at);
  });
});

// The two tests below exist because mutation-testing this suite showed the ones above did
// NOT actually pin the two compare-and-swap guards: the code path has two independent
// defences (the attempts CAS and the single-use claim) covering the same concurrency window,
// so deleting EITHER one left every assertion still green. Each test below isolates one
// guard so that removing it fails here.

test('confirmByToken: concurrent link taps — isolates the SINGLE-USE claim', async () => {
  // The token path has no attempt budget at all, so the atomic `consumed_at=is.null` claim is
  // the ONLY thing that can stop a double verification. Delete that filter and this fails.
  await withDb({ users: [owner()] }, async (fake) => {
    const { token } = await ec.issueChallenge(owner(), NOW);
    const results = await Promise.all([
      ec.confirmByToken(token, NOW + MIN),
      ec.confirmByToken(token, NOW + MIN),
      ec.confirmByToken(token, NOW + MIN),
    ]);
    const fresh = results.filter((r) => r.ok && !r.already).length;
    assert.strictEqual(fresh, 1,
      'exactly one concurrent tap may perform the verification, got ' + fresh);
    assert.ok(fake.db.email_challenges[0].consumed_at);
  });
});

test('the attempt bump is a CONDITIONAL update — isolates the attempts CAS', async () => {
  // A structural assertion, deliberately. The behavioural effect of this guard is masked by
  // the single-use claim (see the note above), so the property worth pinning is the mechanism
  // itself: the attempts bump must constrain the value it observed, or a batch of concurrent
  // guesses all read the same count and cost the attacker one slot instead of N.
  await withDb({ users: [owner()] }, async (fake) => {
    const { code } = await ec.issueChallenge(owner(), NOW);
    const wrong = code === '000000' ? '111111' : '000000';
    await ec.confirmByCode('ann@example.com', wrong, NOW + MIN);

    const bump = fake.requests.find((r) => r.table === 'email_challenges' && r.method === 'PATCH');
    assert.ok(bump, 'a wrong guess must PATCH the challenge row');
    const guarded = bump.filters.some(([col, expr]) => col === 'attempts' && expr.startsWith('eq.'));
    assert.ok(guarded,
      'the attempts bump must carry an `attempts=eq.<observed>` predicate (compare-and-swap), '
      + 'got filters: ' + JSON.stringify(bump.filters));
  });
});

// ---- confirming by magic link ----------------------------------------------

test('confirmByToken: the happy path verifies and consumes', async () => {
  await withDb({ users: [owner()] }, async (fake) => {
    const { token } = await ec.issueChallenge(owner(), NOW);
    const res = await ec.confirmByToken(token, NOW + MIN);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(Date.parse(fake.db.users[0].email_verified_at), NOW + MIN);
    assert.ok(fake.db.email_challenges[0].consumed_at);
  });
});

test('confirmByToken: re-tapping the SAME link is idempotent, not an error', async () => {
  // Mail clients prefetch links and people tap twice. Holding the raw 256-bit token is
  // itself proof of ownership, so answering honestly here is not an oracle.
  await withDb({ users: [owner()] }, async (fake) => {
    const { token } = await ec.issueChallenge(owner(), NOW);
    const first = await ec.confirmByToken(token, NOW + MIN);
    const stamp = fake.db.users[0].email_verified_at;

    const second = await ec.confirmByToken(token, NOW + 5 * MIN);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, true, 'a second tap of a valid link must not show an error');
    assert.strictEqual(second.already, true);
    assert.strictEqual(fake.db.users[0].email_verified_at, stamp,
      'and must NOT rewrite the original verification timestamp');
  });
});

test('confirmByToken: an unknown or empty token fails generically', async () => {
  await withDb({ users: [owner()] }, async () => {
    await ec.issueChallenge(owner(), NOW);
    for (const bad of ['', null, undefined, 'not-a-real-token', crypto.randomBytes(32).toString('base64url')]) {
      const r = await ec.confirmByToken(bad, NOW + MIN);
      assert.strictEqual(r.ok, false, 'rejected: ' + String(bad));
      assert.strictEqual(r.error, ec.GENERIC_FAIL);
    }
  });
});

test('confirmByToken: an expired link is refused', async () => {
  await withDb({ users: [owner()] }, async (fake) => {
    const { token } = await ec.issueChallenge(owner(), NOW);
    const res = await ec.confirmByToken(token, NOW + ec.VERIFY_TTL_MS + 1);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(fake.db.users[0].email_verified_at, null);
  });
});

test('confirmByToken: the code and the link are ONE challenge — using either kills the other', async () => {
  await withDb({ users: [owner()] }, async () => {
    const { code, token } = await ec.issueChallenge(owner(), NOW);
    assert.strictEqual((await ec.confirmByToken(token, NOW + MIN)).ok, true);
    const viaCode = await ec.confirmByCode('ann@example.com', code, NOW + 2 * MIN);
    assert.strictEqual(viaCode.ok, false, 'the code must be dead once the link was used');
  });
});

test('confirmByCode then the link: same property in the other direction', async () => {
  await withDb({ users: [owner()] }, async () => {
    const { code, token } = await ec.issueChallenge(owner(), NOW);
    assert.strictEqual((await ec.confirmByCode('ann@example.com', code, NOW + MIN)).ok, true);
    // The link now resolves to a consumed row for a verified user -> idempotent success,
    // NOT a second verification event.
    const viaLink = await ec.confirmByToken(token, NOW + 2 * MIN);
    assert.strictEqual(viaLink.already, true);
  });
});

test('only the NEWEST challenge is live — an older code stops working after a resend', async () => {
  await withDb({ users: [owner()] }, async (fake) => {
    const first = await ec.issueChallenge(owner(), NOW);
    // Force a distinguishable created_at so ordering is unambiguous.
    fake.db.email_challenges[0].created_at = new Date(NOW).toISOString();
    const second = await ec.issueChallenge(owner(), NOW + 2 * MIN);
    fake.db.email_challenges[1].created_at = new Date(NOW + 2 * MIN).toISOString();

    const old = await ec.confirmByCode('ann@example.com', first.code, NOW + 3 * MIN);
    assert.strictEqual(old.ok, false, 'a superseded code must not verify');

    const fresh = await ec.confirmByCode('ann@example.com', second.code, NOW + 3 * MIN);
    assert.strictEqual(fresh.ok, true, 'the newest code must still work');
  });
});

// ---- reporting -------------------------------------------------------------

test('verificationState: reports the shape both clients render from', () => {
  assert.deepStrictEqual(ec.verificationState(owner()),
    { email: 'ann@example.com', verified: false, verified_at: null });
  assert.deepStrictEqual(ec.verificationState(owner({ email_verified_at: '2026-08-01T00:00:00.000Z' })),
    { email: 'ann@example.com', verified: true, verified_at: '2026-08-01T00:00:00.000Z' });
  assert.deepStrictEqual(ec.verificationState(null),
    { email: null, verified: false, verified_at: null });
});

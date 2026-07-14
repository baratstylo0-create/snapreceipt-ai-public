'use strict';
process.env.ALLOWED_CHAT_IDS = ''; // hermetic: never inherit a real .env allowlist in tests
// C5 follow-up (Jeevan-assigned, finishes the submit-signal's deferred bot hook): when a
// clerk submits a branch-month as ready, ping any bound admin on Telegram. Bonus for admins
// who've bound the bot — the in-app "Ready to close" badge is the primary signal and is
// already live; this never blocks or fails the actual submission response either way.
const { test } = require('node:test');
const assert = require('node:assert');
const { notifySubmissionReady } = require('../lib/bot');

function baseDeps(over = {}) {
  const sent = [];
  return {
    deps: {
      tgSend: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true }; },
      sbSelect: async () => [],
      ...over,
    },
    sent,
  };
}

test('notifySubmissionReady: resolves the branch name + bound admin chat, sends the exact ping text', async () => {
  const { deps, sent } = baseDeps({
    sbSelect: async (table, opts) => {
      if (table === 'branches') return [{ id: 'br-A', office: 'KL Branch', company_id: null }];
      if (table === 'bot_bindings') return [{ id: 'bnd1', role: 'admin', chat_id: '555', active: true }];
      return [];
    },
  });
  await notifySubmissionReady('br-A', '2026-07', deps);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].chatId, '555');
  assert.strictEqual(sent[0].text, '📋 KL Branch submitted 2026-07 — ready to close.');
});

test('notifySubmissionReady: multiple bound admins all get pinged', async () => {
  const { deps, sent } = baseDeps({
    sbSelect: async (table) => {
      if (table === 'branches') return [{ id: 'br-A', office: 'KL Branch' }];
      if (table === 'bot_bindings') return [
        { id: 'a1', role: 'admin', chat_id: '111', active: true },
        { id: 'a2', role: 'admin', chat_id: '222', active: true },
      ];
      return [];
    },
  });
  await notifySubmissionReady('br-A', '2026-07', deps);
  assert.deepStrictEqual(sent.map((s) => s.chatId).sort(), ['111', '222']);
});

test('notifySubmissionReady: no bound admin -> no send, resolves cleanly', async () => {
  const { deps, sent } = baseDeps({
    sbSelect: async (table) => (table === 'branches' ? [{ id: 'br-A', office: 'KL Branch' }] : []),
  });
  await assert.doesNotReject(() => notifySubmissionReady('br-A', '2026-07', deps));
  assert.strictEqual(sent.length, 0);
});

test('notifySubmissionReady: bot_bindings lookup querying only role admin + a bound chat_id', async () => {
  const seenOpts = [];
  const { deps } = baseDeps({
    sbSelect: async (table, opts) => {
      if (table === 'bot_bindings') seenOpts.push(opts);
      return table === 'branches' ? [{ id: 'br-A', office: 'KL Branch' }] : [];
    },
  });
  await notifySubmissionReady('br-A', '2026-07', deps);
  assert.strictEqual(seenOpts[0].eq.role, 'admin');
  assert.strictEqual(seenOpts[0].eq.active, true);
  assert.match(seenOpts[0].extra || '', /chat_id=not\.is\.null/);
});

test('notifySubmissionReady: scopes admin lookup to the branch\'s company_id when it has one', async () => {
  const seenOpts = [];
  const { deps } = baseDeps({
    sbSelect: async (table, opts) => {
      if (table === 'branches') return [{ id: 'br-A', office: 'KL Branch', company_id: 'co-1' }];
      if (table === 'bot_bindings') { seenOpts.push(opts); return []; }
      return [];
    },
  });
  await notifySubmissionReady('br-A', '2026-07', deps);
  assert.strictEqual(seenOpts[0].eq.company_id, 'co-1');
});

test('notifySubmissionReady: no company_id on the branch -> admin lookup is unscoped by company', async () => {
  const seenOpts = [];
  const { deps } = baseDeps({
    sbSelect: async (table, opts) => {
      if (table === 'branches') return [{ id: 'br-A', office: 'KL Branch' }];
      if (table === 'bot_bindings') { seenOpts.push(opts); return []; }
      return [];
    },
  });
  await notifySubmissionReady('br-A', '2026-07', deps);
  assert.strictEqual('company_id' in seenOpts[0].eq, false);
});

test('notifySubmissionReady: branch lookup returning nothing still pings admins with a safe fallback label', async () => {
  const { deps, sent } = baseDeps({
    sbSelect: async (table) => {
      if (table === 'branches') return [];
      if (table === 'bot_bindings') return [{ id: 'a1', role: 'admin', chat_id: '555', active: true }];
      return [];
    },
  });
  await notifySubmissionReady('br-missing', '2026-07', deps);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /submitted 2026-07 — ready to close\.$/);
});

test('notifySubmissionReady: a throwing sbSelect (db down) never throws and sends nothing', async () => {
  const { deps, sent } = baseDeps({
    sbSelect: async () => { throw new Error('ECONNREFUSED db down'); },
  });
  await assert.doesNotReject(() => notifySubmissionReady('br-A', '2026-07', deps));
  assert.strictEqual(sent.length, 0);
});

test('notifySubmissionReady: a throwing tgSend never throws, and other bound admins still get pinged', async () => {
  const { deps, sent } = baseDeps({
    sbSelect: async (table) => {
      if (table === 'branches') return [{ id: 'br-A', office: 'KL Branch' }];
      if (table === 'bot_bindings') return [
        { id: 'a1', role: 'admin', chat_id: '111', active: true },
        { id: 'a2', role: 'admin', chat_id: '222', active: true },
      ];
      return [];
    },
    tgSend: async (chatId, text) => {
      if (chatId === '111') throw new Error('Telegram down');
      sent.push({ chatId, text });
      return { ok: true };
    },
  });
  await assert.doesNotReject(() => notifySubmissionReady('br-A', '2026-07', deps));
  assert.deepStrictEqual(sent.map((s) => s.chatId), ['222']);
});

test('notifySubmissionReady: bindings with no chat_id (never bound) are never sent to', async () => {
  const { deps, sent } = baseDeps({
    sbSelect: async (table) => {
      if (table === 'branches') return [{ id: 'br-A', office: 'KL Branch' }];
      // A hostile/misbehaving stub ignoring the chat_id=not.is.null filter — the helper
      // itself must still guard, not just rely on the query.
      if (table === 'bot_bindings') return [{ id: 'a1', role: 'admin', chat_id: null, active: true }];
      return [];
    },
  });
  await notifySubmissionReady('br-A', '2026-07', deps);
  assert.strictEqual(sent.length, 0);
});

test('notifySubmissionReady: garbage/missing branchId or period never throws', async () => {
  const { deps, sent } = baseDeps();
  await assert.doesNotReject(() => notifySubmissionReady(null, null, deps));
  await assert.doesNotReject(() => notifySubmissionReady(undefined, undefined, deps));
  assert.strictEqual(sent.length, 0);
});

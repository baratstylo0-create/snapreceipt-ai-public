'use strict';
// In-bot signup/reconnect state machine (2026-08-08): lets an unbound personal chat sign up
// OR reconnect an existing account entirely from Telegram, no dashboard required. Every DB/
// side-effect call is injected via `deps` (same convention as tests/bot.business.binding.test.js).
// pendingSignup is a module-level Map keyed by chatId — each test uses its own unique chatId so
// state never bleeds across tests, and clears it in a `finally` so a stray 15-min timer never
// lingers (the timer is .unref()'d in source too, belt-and-braces).
process.env.ALLOWED_CHAT_IDS = '';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  handleUpdate, showSignupPrompt, handleSignupCallback, handleSignupStep, clearPendingSignup,
  PERSONAL_WELCOME, MAIN_MENU_KEYBOARD,
} = require('../lib/bot');

function baseDeps(over = {}) {
  const sent = [];
  const answered = [];
  const deleted = [];
  // sbSelectGlobal (2026-08-22): handleSignupStep's email-exists and reconnect-email checks
  // now go through sbSelectGlobal, not sbSelect (see lib/supabase.js's doc comment — a
  // duplicate-email check must be tenant-independent). Defaulting it to mirror whatever
  // `sbSelect` override a test already passes keeps every existing "existing user found"/
  // "no existing user" test scenario working without touching each one individually; a test
  // that needs the two to diverge can still pass its own `sbSelectGlobal` override.
  const resolvedOver = { ...over };
  if (resolvedOver.sbSelectGlobal === undefined) resolvedOver.sbSelectGlobal = resolvedOver.sbSelect;
  return {
    deps: {
      tgSend: async (chatId, text, replyMarkup) => { sent.push({ chatId, text, replyMarkup }); },
      tgAnswerCallback: async (id) => { answered.push(id); },
      tgDeleteMessage: async (chatId, messageId) => { deleted.push({ chatId, messageId }); },
      sbSelect: async () => [],
      sbSelectGlobal: async () => [],
      sbUpdate: async () => [],
      signupOwnerDirect: async () => ({ user: { id: 'u1', username: 'x@y.com', role: 'owner' }, bindToken: 'tok' }),
      reconnectBinding: async () => true,
      sendVerificationCode: async () => {},
      ...resolvedOver,
    },
    sent, answered, deleted,
  };
}

test('showSignupPrompt: sends the welcome message with Create/Reconnect buttons', async () => {
  const chatId = 5001;
  const { deps, sent } = baseDeps();
  try {
    await showSignupPrompt(chatId, deps);
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].text, /Welcome to SnapReceipt AI/);
    assert.strictEqual(sent[0].replyMarkup.inline_keyboard.length, 2);
  } finally { clearPendingSignup(chatId); }
});

test('handleSignupCallback signup:create -> prompts for email', async () => {
  const chatId = 5002;
  const { deps, sent, answered } = baseDeps();
  try {
    await handleSignupCallback({ id: 'cq1', data: 'signup:create' }, chatId, deps);
    assert.deepStrictEqual(answered, ['cq1']);
    assert.match(sent[0].text, /email address/i);
  } finally { clearPendingSignup(chatId); }
});

test('handleSignupStep email step: valid new email advances to password step', async () => {
  const chatId = 5003;
  const { deps, sent } = baseDeps({ sbSelect: async () => [] }); // no existing user
  try {
    await handleSignupCallback({ id: 'cq', data: 'signup:create' }, chatId, deps);
    await handleSignupStep({ text: 'new@example.com' }, chatId, deps);
    assert.match(sent[sent.length - 1].text, /choose a password/i);
  } finally { clearPendingSignup(chatId); }
});

test('handleSignupStep email step: duplicate email offers reconnect instead of proceeding', async () => {
  const chatId = 5004;
  const { deps, sent } = baseDeps({ sbSelect: async () => [{ id: 'existing' }] });
  try {
    await handleSignupCallback({ id: 'cq', data: 'signup:create' }, chatId, deps);
    await handleSignupStep({ text: 'dupe@example.com' }, chatId, deps);
    const last = sent[sent.length - 1];
    assert.match(last.text, /already has an account/i);
    assert.strictEqual(last.replyMarkup.inline_keyboard[0][0].callback_data, 'signup:reconnect');
  } finally { clearPendingSignup(chatId); }
});

test('handleSignupStep password step: weak password is rejected and re-prompted, password message still deleted', async () => {
  const chatId = 5005;
  const { deps, sent, deleted } = baseDeps({ sbSelect: async () => [] });
  try {
    await handleSignupCallback({ id: 'cq', data: 'signup:create' }, chatId, deps);
    await handleSignupStep({ text: 'weak@example.com' }, chatId, deps);
    await handleSignupStep({ text: '123', message_id: 777 }, chatId, deps);
    assert.match(sent[sent.length - 1].text, /⚠️/);
    assert.deepStrictEqual(deleted, [{ chatId, messageId: 777 }]);
  } finally { clearPendingSignup(chatId); }
});

test('handleSignupStep password step: strong password creates + auto-binds the account, deletes the password message, sends the real welcome', async () => {
  const chatId = 5006;
  const calls = [];
  const { deps, sent, deleted } = baseDeps({
    sbSelect: async () => [],
    signupOwnerDirect: async (args) => { calls.push(args); return { user: { id: 'u9', username: args.email, role: 'owner' }, bindToken: 'tok9' }; },
  });
  try {
    await handleSignupCallback({ id: 'cq', data: 'signup:create' }, chatId, deps);
    await handleSignupStep({ text: 'strong@example.com' }, chatId, deps);
    await handleSignupStep({ text: 'correcthorsebattery1', message_id: 888 }, chatId, deps);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].email, 'strong@example.com');
    assert.strictEqual(calls[0].chatId, chatId);
    assert.deepStrictEqual(deleted, [{ chatId, messageId: 888 }]);
    const last = sent[sent.length - 1];
    assert.strictEqual(last.text, PERSONAL_WELCOME);
    assert.deepStrictEqual(last.replyMarkup, MAIN_MENU_KEYBOARD);
  } finally { clearPendingSignup(chatId); }
});

test('handleSignupStep password step: signupOwnerDirect throwing (e.g. race-condition duplicate) is surfaced, not swallowed', async () => {
  const chatId = 5007;
  const { deps, sent } = baseDeps({
    sbSelect: async () => [],
    signupOwnerDirect: async () => { throw new Error('an account with that email already exists'); },
  });
  try {
    await handleSignupCallback({ id: 'cq', data: 'signup:create' }, chatId, deps);
    await handleSignupStep({ text: 'race@example.com' }, chatId, deps);
    await handleSignupStep({ text: 'correcthorsebattery1' }, chatId, deps);
    assert.match(sent[sent.length - 1].text, /already exists/i);
  } finally { clearPendingSignup(chatId); }
});

test('handleSignupStep reconnect flow: unknown email offers Create Account instead of a dead end', async () => {
  const chatId = 5008;
  const { deps, sent } = baseDeps({ sbSelect: async () => [] });
  try {
    await handleSignupCallback({ id: 'cq', data: 'signup:reconnect' }, chatId, deps);
    await handleSignupStep({ text: 'ghost@example.com' }, chatId, deps);
    const last = sent[sent.length - 1];
    assert.match(last.text, /don't see an account/i);
    assert.strictEqual(last.replyMarkup.inline_keyboard[0][0].callback_data, 'signup:create');
  } finally { clearPendingSignup(chatId); }
});

test('handleSignupStep reconnect flow: known email sends a verification code, then correct code rebinds', async () => {
  const chatId = 5009;
  const codeCalls = [];
  const reconnectCalls = [];
  const { deps, sent } = baseDeps({
    sbSelect: async () => [{ id: 'u10', username: 'known@example.com', role: 'owner' }],
    sendVerificationCode: async (email, code) => { codeCalls.push({ email, code }); },
    reconnectBinding: async (userId, cid) => { reconnectCalls.push({ userId, cid }); return true; },
  });
  try {
    await handleSignupCallback({ id: 'cq', data: 'signup:reconnect' }, chatId, deps);
    await handleSignupStep({ text: 'known@example.com' }, chatId, deps);
    assert.strictEqual(codeCalls.length, 1);
    assert.strictEqual(codeCalls[0].email, 'known@example.com');
    assert.match(codeCalls[0].code, /^\d{6}$/);

    await handleSignupStep({ text: codeCalls[0].code }, chatId, deps);
    assert.strictEqual(reconnectCalls.length, 1);
    assert.strictEqual(reconnectCalls[0].userId, 'u10');
    assert.strictEqual(reconnectCalls[0].cid, chatId);
    const last = sent[sent.length - 1];
    assert.strictEqual(last.text, PERSONAL_WELCOME);
  } finally { clearPendingSignup(chatId); }
});

test('handleSignupStep reconnect flow: wrong code is rejected without rebinding; 3rd wrong attempt locks and offers resend', async () => {
  const chatId = 5010;
  const reconnectCalls = [];
  const { deps, sent } = baseDeps({
    sbSelect: async () => [{ id: 'u11', username: 'known2@example.com', role: 'owner' }],
    reconnectBinding: async (userId, cid) => { reconnectCalls.push({ userId, cid }); return true; },
  });
  try {
    await handleSignupCallback({ id: 'cq', data: 'signup:reconnect' }, chatId, deps);
    await handleSignupStep({ text: 'known2@example.com' }, chatId, deps);
    await handleSignupStep({ text: '000000' }, chatId, deps); // attempt 1 (wrong)
    await handleSignupStep({ text: '000000' }, chatId, deps); // attempt 2 (wrong)
    await handleSignupStep({ text: '000000' }, chatId, deps); // attempt 3 (wrong) -> locked
    assert.strictEqual(reconnectCalls.length, 0, 'must never rebind on a wrong code');
    const last = sent[sent.length - 1];
    assert.match(last.text, /too many wrong attempts/i);
    assert.strictEqual(last.replyMarkup.inline_keyboard[0][0].callback_data, 'signup:resend');
  } finally { clearPendingSignup(chatId); }
});

test('handleUpdate: an unbound chat in personal (personalAuth, non-multiUser) mode gets the signup prompt, not the old dead-end message', async () => {
  const chatId = 5011;
  const { deps, sent } = baseDeps({
    sbSelect: async () => [], // resolveBinding -> not bound
    getCapabilities: () => ({ personalAuth: true, multiUser: false }),
  });
  try {
    await handleUpdate({ message: { chat: { id: chatId }, from: { first_name: 'A' }, text: 'hello' } }, deps);
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].text, /Welcome to SnapReceipt AI/);
  } finally { clearPendingSignup(chatId); }
});

test('handleUpdate: business mode (multiUser) unbound chat is COMPLETELY unaffected — still gets BUSINESS_UNBOUND_MESSAGE, never the signup prompt', async () => {
  const chatId = 5012;
  const { deps, sent } = baseDeps({
    sbSelect: async () => [],
    getCapabilities: () => ({ multiUser: true, personalAuth: false }),
  });
  try {
    await handleUpdate({ message: { chat: { id: chatId }, from: { first_name: 'A' }, text: 'hello' } }, deps);
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].text, /one-time access link/i);
    assert.doesNotMatch(sent[0].text, /Welcome to SnapReceipt AI/);
  } finally { clearPendingSignup(chatId); }
});

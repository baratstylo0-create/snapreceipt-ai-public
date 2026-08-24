'use strict';
const crypto = require('node:crypto');
const { cfg } = require('./config');
const { sbSelect, sbSelectGlobal, sbUpdate, sbSoftDelete } = require('./supabase');
const { tgSend, tgSendPhoto, tgEditMessage, tgFileUrl, tgAnswerCallback, tgDeleteMessage } = require('./telegram');
const { hreq } = require('./http');
const { fmtMoney, parseDateLoose } = require('./money');
const { expenseFromPhoto, extractReceipts, assembleExpense, categoryPromptText, buildCategoryKeyboard, specCategories, PENDING_CATEGORY, duplicateRejectedText, buildDuplicateKeyboard, skipMessage, downloadAndStoreReceiptImage, GUEST_CAP_REACHED_MESSAGE, GUEST_RECEIPT_CAP, countGuestExpenses, captureCardText, captureCardKeyboard, editFieldMenuKeyboard } = require('./ocr');
const { uploadReceiptImage } = require('./storage');
const { getFieldSpec } = require('./templates');
const { runBatch } = require('./massupload');
const { rasterizePdf } = require('./pdf');
const { getCapabilities } = require('./account');
const { listStaff, passwordPolicy } = require('./branches');
const { guestVisibilityExtra, mergeExtra } = require('./auth');
const { signupOwnerDirect, reconnectBinding, normaliseEmail } = require('./personalAuth');
const { sendVerificationCode } = require('./mailer');

const WELCOME = '👋 *SnapReceipt AI*\n\nSend me a *photo of any receipt or invoice* and I\'ll read it, extract the merchant, amount, tax and line items, and log it automatically.\n\n• 📸 Snap a receipt → auto-logged\n• 🧾 Send *several photos at once* → all logged in one go\n• 💬 Type *"show expenses"* for a summary\n\nTry it now — send a receipt photo!\n\n_Use the buttons below any time._';

// Owner request 2026-07-04: a persistent, always-visible menu bar (a Telegram
// ReplyKeyboardMarkup — distinct from the inline "buttons attached to one message" kind
// used everywhere else in this file). Sent once on /start; Telegram keeps it visible for
// every message after that until explicitly replaced/removed, so it is NOT resent per-reply.
//
// Issue #162 D12 (live QA): the menu only showed up on mobile, not Telegram Desktop/Web.
// Root cause: without `is_persistent: true`, non-mobile clients collapse a
// ReplyKeyboardMarkup behind a small icon the user has to tap to reveal, while mobile
// apps show it automatically — same keyboard, different default per-client behaviour.
// `is_persistent: true` requests it stay visible on every client, closing that gap.
const MAIN_MENU_KEYBOARD = {
  keyboard: [
    ['📋 Today Bills', '💰 Today Expenses'],
    ['📅 Weekly Record', '🧭 Bot Guide'],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const BOT_GUIDE_TEXT = '🧭 *Bot Guide*\n\n'
  + '📸 *Send a photo* of any receipt or invoice — I\'ll read the merchant, date, total and category automatically.\n\n'
  + '🧾 *Send several photos at once* (as one album) — I\'ll process them all and give you one summary.\n\n'
  + '📄 *Send a PDF* — read the same way as a photo.\n\n'
  + '🤔 If I\'m not sure of a category, I\'ll ask you to pick one — tap a button, or "Others" and type a short note.\n\n'
  + '✏️ *Edit category* — tap the button under any saved receipt to change its category.\n\n'
  + '🗑️ *Delete* — type "delete" for your own most recent receipt, or use the ❌ button in *Today Bills*.\n\n'
  + '📋 *Today Bills* — every receipt captured today, with a delete option for your own.\n'
  + '💰 *Today Expenses* — just today\'s total.\n'
  + '📅 *Weekly Record* — this week\'s total (Monday to today).\n\n'
  + '_All dates use Malaysia time (UTC+8)._';

// Today's date, and this week's Monday, in Malaysia time (UTC+8) — regardless of the
// server's own timezone. Shifting the current instant by +8h and reading its UTC calendar
// fields gives the correct Malaysia-local calendar date without depending on host tz.
function todayISO_MYT(now = Date.now()) {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function weekStartISO_MYT(now = Date.now()) {
  const shifted = new Date(now + 8 * 3600 * 1000);
  const dow = shifted.getUTCDay(); // 0=Sun..6=Sat
  shifted.setUTCDate(shifted.getUTCDate() - (dow === 0 ? 6 : dow - 1)); // back to Monday
  return shifted.toISOString().slice(0, 10);
}

// BUG FIX 2026-07-04 (live QA): "Today Bills"/"Today Expenses"/"Weekly Record" originally
// filtered by `expense_date` — the date PRINTED ON the receipt (from OCR), not when it was
// actually uploaded. A receipt photographed today but dated weeks/months earlier (a common,
// real case — Barat uploaded 4 such receipts) was invisible in "Today Bills" even though it
// WAS captured today. These three features are about "what did I capture", so they must
// filter by `created_at` (the actual insert timestamp) instead. Returns UTC instant bounds
// for the MYT calendar day/week, for a `created_at` gte/lt PostgREST filter.
function mytDayBoundsUTC(now = Date.now()) {
  const shifted = new Date(now + 8 * 3600 * 1000);
  const y = shifted.getUTCFullYear(), m = shifted.getUTCMonth(), d = shifted.getUTCDate();
  const startUTC = new Date(Date.UTC(y, m, d) - 8 * 3600 * 1000); // MYT midnight, expressed in UTC
  const endUTC = new Date(startUTC.getTime() + 24 * 3600 * 1000);
  return { startUTC: startUTC.toISOString(), endUTC: endUTC.toISOString() };
}
function mytWeekStartBoundUTC(now = Date.now()) {
  const shifted = new Date(now + 8 * 3600 * 1000);
  const dow = shifted.getUTCDay();
  shifted.setUTCDate(shifted.getUTCDate() - (dow === 0 ? 6 : dow - 1)); // back to Monday (MYT)
  const y = shifted.getUTCFullYear(), m = shifted.getUTCMonth(), d = shifted.getUTCDate();
  return new Date(Date.UTC(y, m, d) - 8 * 3600 * 1000).toISOString();
}

// Business "Weekly Record" uses a SUNDAY-start week (per the business-account design doc
// and epic plan, "weekly = Sun-Sat") — deliberately DIFFERENT from the personal bot's
// Monday-start week above, which stays untouched. Only used when a chat is bound
// (business mode); personal callers never hit this path.
function mytWeekStartSundayBoundUTC(now = Date.now()) {
  const shifted = new Date(now + 8 * 3600 * 1000);
  const dow = shifted.getUTCDay(); // 0=Sun..6=Sat
  shifted.setUTCDate(shifted.getUTCDate() - dow); // back to Sunday (MYT)
  const y = shifted.getUTCFullYear(), m = shifted.getUTCMonth(), d = shifted.getUTCDate();
  return new Date(Date.UTC(y, m, d) - 8 * 3600 * 1000).toISOString();
}
function weekStartSundayISO_MYT(now = Date.now()) {
  const shifted = new Date(now + 8 * 3600 * 1000);
  const dow = shifted.getUTCDay();
  shifted.setUTCDate(shifted.getUTCDate() - dow);
  return shifted.toISOString().slice(0, 10);
}

// ---- Business-mode identity (ADR-021 Phase 5, issue #107) -------------------
// A business bot is a "clerk tool": both a clerk and the HQ admin bind their Telegram
// chat to a `bot_bindings` row via a one-time `/start <token>` deep link (the token +
// row are created by lib/branches.js's createBranch, Phase 2); staff never bind (they're
// a name-only directory, tagged per-receipt instead — see the staff-picker piece).
// Locked once bound: the SAME token tapped again by the SAME chat is a harmless no-op
// (idempotent — Telegram can redeliver a tap), but a token already bound to a DIFFERENT
// chat is refused, and an already-used-up token can't mint a second identity.
// Entirely inert when capabilities.multiUser is off — the personal bot never calls this.

// 30-day inactivity window (2026-08-08): a personal OWNER binding is otherwise PERMANENT — see
// the schema.sql migration note above bot_bindings.last_active_at. This is not a "your link
// expired" dead end; resolveBinding below treats a stale binding as unbound, which routes the
// chat straight into the in-bot "I already have one" re-verify flow (a 6-digit email code),
// not back to square one.
//
// SCOPED TO role==='owner' ONLY (bug caught in QA, 2026-08-08): this file is SHARED between
// the personal deployment and the live business (multiUser) Premala deployment. An earlier
// version of this check applied to every binding role, which would have started silently
// auto-unbinding business admin/clerk chats after 30 days of inactivity (e.g. staff on leave)
// — a real production regression nobody asked for, since business bindings never expired or
// auto-unbound before today. Business/guest bindings must stay byte-for-byte unchanged.
const INACTIVITY_UNBIND_MS = Number(process.env.BIND_INACTIVITY_MS) || 30 * 24 * 60 * 60 * 1000;

// resolveBinding(chatId) -> the active bot_bindings row for this chat, or null if unbound
// (either never bound, or an 'owner' binding gone stale — see INACTIVITY_UNBIND_MS above).
async function resolveBinding(chatId, deps = {}) {
  // sbSelectGlobal (2026-08-22): this runs on EVERY incoming Telegram message — same root
  // cause as every other identity-lookup fix this session (see lib/supabase.js's doc
  // comment). chat_id is Telegram's own globally-unique id, so no account_id filter was ever
  // needed for correctness — but the old scoped lookup silently broke the bot for every
  // ALREADY-CONNECTED owner the moment their bot_bindings row moved to its own unique
  // account_id (2026-08-14 signup fix, and the 2026-08-22 backfill for pre-existing owners).
  // CAUGHT LIVE: confirmed the real production account (baratstylo0, chat_id 1376793145,
  // migrated earlier today) resolved to ZERO rows here — the bot was silently treating an
  // already-bound, actively-used owner as unbound on every single message.
  const selectGlobal = deps.sbSelectGlobal || sbSelectGlobal;
  const update = deps.sbUpdate || sbUpdate;
  try {
    // order: bound_at.desc (2026-08-22) — see sbSelectGlobal's doc comment. If the same
    // Telegram chat somehow ended up bound to two different rows (a stale test bind never
    // cleared before the real one), the most-recently-connected one is correct, not whichever
    // is older.
    const rows = await selectGlobal('bot_bindings', { eq: { chat_id: String(chatId), active: true }, limit: 1, order: 'bound_at.desc' });
    const row = rows[0];
    if (!row) return null;
    if (row.role === 'owner' && row.last_active_at) {
      const staleFor = Date.now() - new Date(row.last_active_at).getTime();
      if (staleFor > INACTIVITY_UNBIND_MS) {
        // scope required on the write too — same reasoning as bindWithToken's own sbUpdate fix.
        try { await update('bot_bindings', { id: row.id, scope: { account_id: row.account_id } }, { chat_id: null }); }
        catch (e) { console.error('[binding inactivity unbind]', e.message); }
        return null;
      }
    }
    return row;
  } catch (e) {
    console.error('[binding lookup]', e.message);
    return null; // fail closed — an error here reads as "unbound", never as "let them through"
  }
}

// updateLastActive(bindingId, deps) — called once per incoming message on a bound OWNER chat
// (the caller gates on role==='owner', see handleUpdate below), so resolveBinding's 30-day
// inactivity check above only ever fires for owner chats that have gone genuinely quiet, never
// for someone actively using the bot, and never touches business/guest rows at all. Best-effort/
// never throws (a failed heartbeat write must never block the message it's attached to).
async function updateLastActive(bindingId, deps = {}) {
  const update = deps.sbUpdate || sbUpdate;
  try { await update('bot_bindings', { id: bindingId }, { last_active_at: new Date().toISOString() }); }
  catch (e) { console.error('[binding heartbeat]', e.message); }
}

// bindWithToken(token, chatId) -> { ok, message } — validates + locks a one-time bind_token
// to this chat. Never throws; every failure path returns a friendly, non-technical message.
async function bindWithToken(token, chatId, deps = {}) {
  // sbSelectGlobal (2026-08-22): a bind_token lookup happens BEFORE any account_id is known
  // (that's the whole point — the token tells us which account) — same root cause as every
  // other identity-lookup fix this session (see lib/supabase.js's doc comment). bind_token is
  // already a crypto-random, globally-unique value (genBindingToken, 24 random bytes), so the
  // account_id filter added nothing except silently breaking every NEW signup's own connect
  // link: their bot_bindings row carries their own unique account_id (assigned at signup since
  // 2026-08-14), never cfg.ACCOUNT_ID, so the old scoped lookup here could never find it —
  // "That link isn't valid" for a link that was, in fact, completely valid.
  const selectGlobal = deps.sbSelectGlobal || sbSelectGlobal;
  const update = deps.sbUpdate || sbUpdate;
  const t = String(token || '').trim();
  if (!t) return { ok: false, message: '🔒 That link looks incomplete. Please ask your admin for your binding link again.' };
  try {
    const rows = await selectGlobal('bot_bindings', { eq: { bind_token: t, active: true }, limit: 1 });
    const row = rows[0];
    if (!row) return { ok: false, message: '🔒 That link isn\'t valid. Please ask your admin for a fresh binding link.' };
    // 2026-08-08: personal OWNER connect links no longer expire (see the schema.sql migration
    // note above bot_bindings.last_active_at) — but business (admin/clerk) and guest tokens
    // keep their original 7-day expiry check exactly as before. This file is shared with the
    // live business deployment; only the role the fix was actually asked for changes behavior.
    if (row.role !== 'owner' && row.token_expires_at && new Date(row.token_expires_at).getTime() <= Date.now()) {
      return { ok: false, message: '🔒 That link has expired. Please ask your admin for a fresh binding link.' };
    }
    // Already bound: a re-tap by the SAME chat is a harmless no-op (Telegram can redeliver
    // a /start tap); bound to a DIFFERENT chat means this token is used up.
    if (row.chat_id) {
      if (String(row.chat_id) === String(chatId)) {
        return { ok: true, role: row.role, alreadyBound: true };
      }
      return { ok: false, message: '🔒 That link has already been used. Please ask your admin for a fresh binding link.' };
    }
    const now = new Date().toISOString();
    const patch = row.role === 'owner'
      ? { chat_id: String(chatId), bound_at: now, last_active_at: now }
      : { chat_id: String(chatId), bound_at: now };
    // scope: { account_id: row.account_id } — same reasoning as the selectGlobal fix above:
    // an unscoped sbUpdate defaults to account_id=cfg.ACCOUNT_ID and would silently match zero
    // rows for a new personal signup's own binding, leaving chat_id unset even though the
    // lookup above just found the row (a write, not just a read, needs its own scope).
    await update('bot_bindings', { id: row.id, scope: { account_id: row.account_id } }, patch);
    // 2026-08-22: enforce "at most one bot_bindings row owns a given chat_id at a time" —
    // the actual root cause of the bug above. A personal owner can freely re-bind the same
    // physical Telegram chat to a DIFFERENT account (e.g. testing a demo signup, then binding
    // their real one) — nothing here should stop that — but the OLD row must give up chat_id
    // when a new one claims it, or the two permanently collide on every future resolveBinding
    // lookup (confirmed live: exactly this left an old test account, demo.video@…, silently
    // stealing messages meant for baratstylo0's real production account). Owner-only — a
    // business (admin/clerk) rebind must stay byte-for-byte unchanged, same boundary every
    // other owner-specific branch in this function already draws. Best-effort: never let a
    // cleanup failure undo the bind that DID just succeed.
    if (row.role === 'owner') {
      try {
        const stale = await selectGlobal('bot_bindings', { eq: { chat_id: String(chatId), active: true } });
        for (const s of stale) {
          if (s.id === row.id) continue;
          await update('bot_bindings', { id: s.id, scope: { account_id: s.account_id } }, { chat_id: null });
        }
      } catch (e) { console.error('[bind token] stale chat_id cleanup failed:', e.message); }
    }
    return { ok: true, role: row.role };
  } catch (e) {
    console.error('[bind token]', e.message);
    return { ok: false, message: '⚠️ Couldn\'t complete that right now. Please try your link again shortly.' };
  }
}

// notifySubmissionReady(branchId, period, deps) — C5 follow-up (Jeevan-assigned): when a
// clerk submits a branch-month as ready (routes/submissions.js POST), ping any bound admin
// on Telegram. The in-app "Ready to close" badge is the primary signal and is already live;
// this is a bonus for admins who've bound the bot, so it must NEVER throw and NEVER block —
// the caller fires this without awaiting in any way that could delay/fail its own response.
// Scoped to the branch's company_id when it has one (multi-company correctness — an admin in
// a different company must never get another company's submission ping); falls back to an
// account-wide admin lookup when the branch has no company_id (single-company deployments).
async function notifySubmissionReady(branchId, period, deps = {}) {
  const select = deps.sbSelect || sbSelect;
  const send = deps.tgSend || tgSend;
  try {
    if (!branchId || !period) return;
    let branchName = 'A branch';
    let companyId = null;
    try {
      const branches = await select('branches', { eq: { id: branchId }, limit: 1 });
      const branch = branches && branches[0];
      if (branch) {
        if (branch.office) branchName = branch.office;
        if (branch.company_id) companyId = branch.company_id;
      }
    } catch (e) { console.error('[submission ping] branch lookup', e && e.message); } // fall back to the generic label
    const eq = { role: 'admin', active: true };
    if (companyId) eq.company_id = companyId;
    const admins = await select('bot_bindings', { eq, extra: 'chat_id=not.is.null' });
    const text = '📋 ' + branchName + ' submitted ' + period + ' — ready to close.';
    for (const a of (Array.isArray(admins) ? admins : [])) {
      if (!a || !a.chat_id) continue; // defensive — never send to an unbound row even if a stub ignores the query filter
      try { await send(String(a.chat_id), text); } catch (e) { console.error('[submission ping] send', e && e.message); }
    }
  } catch (e) {
    console.error('[submission ping]', e && e.message);
  }
}

const BUSINESS_WELCOME_ADMIN = '👋 *Welcome!*\n\nYou\'re bound as the *admin*. Send a receipt photo any time to log it — I\'ll ask which staff member it\'s for.';
const BUSINESS_WELCOME_CLERK = '👋 *Welcome!*\n\nYou\'re bound as a *branch clerk*. Send a receipt photo any time to log it — I\'ll ask which staff member it\'s for.';
const BUSINESS_UNBOUND_MESSAGE = '🔒 This bot needs a one-time access link before it can be used. Please ask your admin for your binding link.';
// Personal-mode signup (2026-07-25) — same bind-gate mechanism as business, different copy
// (no staff/branch language) and no "ask an admin" framing, since there is no admin.
const PERSONAL_WELCOME = '👋 *You\'re connected!*\n\nSend a receipt photo any time to log it — it\'ll show up on your dashboard automatically.';
const PERSONAL_UNBOUND_MESSAGE = '🔒 This bot is tied to a SnapReceipt AI account. Please finish creating your account on the dashboard first, then tap your personal connect link.';
// Guest Mode (2026-07-28) — a guest binding is functionally like 'owner' (no staff/branch
// language, MAIN_MENU_KEYBOARD) but the welcome copy sets expectations about the 4-receipt
// trial cap up front, and guests never see PERSONAL_UNBOUND_MESSAGE's "your account" framing
// since a guest never created one — they'd see this only if they somehow message before
// /api/guest/start ran, which the dashboard flow never allows.
const GUEST_WELCOME = '👋 *You\'re connected — trial mode!*\n\nSend up to *4 receipt photos* to see them land on your dashboard automatically. Sign up any time to keep going with unlimited receipts.';

// isPersonalBinding(role) -> true for the two single-user, non-business binding roles
// ('owner' and 'guest', 2026-07-28) — both get the plain personal menu/copy (MAIN_MENU_KEYBOARD,
// no Staff Lock row, no staff-attribution prompt), unlike 'admin'/'clerk' which are business.
function isPersonalBinding(role) {
  return role === 'owner' || role === 'guest';
}

// ---- In-bot signup / reconnect (2026-08-08) ---------------------------------
// Most personal users only ever touch the app from their phone via Telegram — the old
// dashboard-only signup left anyone who skipped/lost their connect link permanently stuck
// (PERSONAL_UNBOUND_MESSAGE was a dead end, no way back short of a developer hand-fixing the
// DB row). This lets a chat sign up OR reconnect an existing account entirely from inside
// Telegram. Same in-memory v1 Map pattern/restart caveat as pendingStaffPicks etc. above —
// an abandoned flow just means the next message starts fresh (see SIGNUP_TIMEOUT_MS below).
const pendingSignup = new Map(); // chatId -> { step, email?, code?, codeExpiry?, attempts?, userId?, timer? }
const SIGNUP_TIMEOUT_MS = 15 * 60 * 1000;
const VERIFY_CODE_TTL_MS = 10 * 60 * 1000;
const VERIFY_CODE_MAX_ATTEMPTS = 3;

function clearPendingSignup(chatId) {
  const s = pendingSignup.get(chatId);
  if (s && s.timer) clearTimeout(s.timer);
  pendingSignup.delete(chatId);
}

function setPendingSignup(chatId, patch) {
  const existing = pendingSignup.get(chatId) || {};
  if (existing.timer) clearTimeout(existing.timer);
  const state = { ...existing, ...patch };
  state.timer = setTimeout(() => pendingSignup.delete(chatId), SIGNUP_TIMEOUT_MS);
  state.timer.unref(); // QA fix (2026-08-08): must never hold the Node process (or a test run) open
  pendingSignup.set(chatId, state);
  return state;
}

const SIGNUP_PROMPT_TEXT = '👋 *Welcome to SnapReceipt AI!*\n\nTo get started, you need an account.\nIt takes 30 seconds — right here, no app to download.';
const SIGNUP_KEYBOARD = { inline_keyboard: [
  [{ text: '🆕 Create Account', callback_data: 'signup:create' }],
  [{ text: '🔗 I already have one', callback_data: 'signup:reconnect' }],
] };

async function showSignupPrompt(chatId, deps = {}) {
  const send = deps.tgSend || tgSend;
  clearPendingSignup(chatId);
  await send(chatId, SIGNUP_PROMPT_TEXT, SIGNUP_KEYBOARD);
}

async function handleSignupCallback(cq, chatId, deps = {}) {
  const send = deps.tgSend || tgSend;
  const answer = deps.tgAnswerCallback || tgAnswerCallback;
  const data = String((cq && cq.data) || '');
  await answer(cq.id);
  if (data === 'signup:create') {
    setPendingSignup(chatId, { step: 'email', mode: 'create' });
    await send(chatId, '📧 What\'s your email address?\n_(This will be your login for the dashboard too.)_');
    return;
  }
  if (data === 'signup:reconnect') {
    setPendingSignup(chatId, { step: 'reconnect_email' });
    await send(chatId, '📧 What\'s the email address you signed up with?');
    return;
  }
  if (data === 'signup:resend') {
    const s = pendingSignup.get(chatId);
    if (!s || !s.userId) { await showSignupPrompt(chatId, deps); return; }
    await sendFreshCode(chatId, s.userId, deps);
    return;
  }
  if (data === 'signup:cancel') {
    clearPendingSignup(chatId);
    await showSignupPrompt(chatId, deps);
    return;
  }
  // Unknown/stale button — just re-show the entry point.
  await showSignupPrompt(chatId, deps);
}

async function sendFreshCode(chatId, userId, deps = {}) {
  const send = deps.tgSend || tgSend;
  const email = pendingSignup.get(chatId) && pendingSignup.get(chatId).email;
  const code = String(crypto.randomInt(100000, 1000000));
  setPendingSignup(chatId, { step: 'verify_code', userId, code, codeExpiry: Date.now() + VERIFY_CODE_TTL_MS, attempts: 0 });
  (deps.sendVerificationCode || sendVerificationCode)(email, code);
  await send(chatId, '📨 I\'ve sent a 6-digit code to *' + email + '*.\nType it here to connect this Telegram to your account.');
}

async function handleSignupStep(msg, chatId, deps = {}) {
  const send = deps.tgSend || tgSend;
  const select = deps.sbSelect || sbSelect;
  // 2026-08-22: username lookups below use sbSelectGlobal, not sbSelect — see its doc
  // comment in lib/supabase.js. Same root cause as personalAuth.js/googleAuth.js/auth.js:
  // an email-exists check run before an account_id is known must be tenant-independent, or
  // it goes blind to any already-migrated owner. Caught here too: the bot's own /signup
  // "that email already has an account" check, and the "reconnect" flow below, would both
  // silently misbehave for a real migrated user (dup-create / "no account found").
  const selectGlobal = deps.sbSelectGlobal || sbSelectGlobal;
  const del = deps.tgDeleteMessage || tgDeleteMessage;
  const s = pendingSignup.get(chatId);
  if (!s) { await showSignupPrompt(chatId, deps); return; }
  const text = String((msg && msg.text) || '').trim();

  if (s.step === 'email') {
    const email = (deps.normaliseEmail || normaliseEmail)(text);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      await send(chatId, '⚠️ That doesn\'t look like a valid email. Please try again.');
      return;
    }
    const existing = await selectGlobal('users', { eq: { username: email }, limit: 1 });
    if (existing.length) {
      await send(chatId, 'That email already has an account.', { inline_keyboard: [
        [{ text: '🔗 I already have one', callback_data: 'signup:reconnect' }],
      ] });
      return;
    }
    setPendingSignup(chatId, { step: 'password', email });
    await send(chatId, '🔑 Now choose a password.\nMust be at least 10 characters with letters and digits.');
    return;
  }

  if (s.step === 'password') {
    const pol = (deps.passwordPolicy || passwordPolicy)(text);
    if (msg && msg.message_id) del(chatId, msg.message_id); // best-effort — never leave the typed password in chat history
    if (!pol.ok) {
      await send(chatId, '⚠️ ' + pol.error + ' Please try again.');
      return;
    }
    try {
      await (deps.signupOwnerDirect || signupOwnerDirect)({ email: s.email, password: text, chatId });
    } catch (e) {
      clearPendingSignup(chatId);
      await send(chatId, '⚠️ ' + (e.message || 'Signup failed') + '. Tap below to try again.', SIGNUP_KEYBOARD);
      return;
    }
    clearPendingSignup(chatId);
    await send(chatId, PERSONAL_WELCOME, MAIN_MENU_KEYBOARD);
    return;
  }

  if (s.step === 'reconnect_email') {
    const email = (deps.normaliseEmail || normaliseEmail)(text);
    const rows = await selectGlobal('users', { eq: { username: email, role: 'owner' }, limit: 1 });
    if (!rows.length) {
      await send(chatId, 'I don\'t see an account with that email.', { inline_keyboard: [
        [{ text: '🆕 Create Account', callback_data: 'signup:create' }],
      ] });
      return;
    }
    setPendingSignup(chatId, { email });
    await sendFreshCode(chatId, rows[0].id, deps);
    return;
  }

  if (s.step === 'verify_code') {
    if (Date.now() > s.codeExpiry) {
      await send(chatId, 'That code has expired.', { inline_keyboard: [
        [{ text: '📨 Send new code', callback_data: 'signup:resend' }],
      ] });
      return;
    }
    if (text !== s.code) {
      const attempts = (s.attempts || 0) + 1;
      if (attempts >= VERIFY_CODE_MAX_ATTEMPTS) {
        clearPendingSignup(chatId);
        await send(chatId, '⚠️ Too many wrong attempts.', { inline_keyboard: [
          [{ text: '📨 Send new code', callback_data: 'signup:resend' }],
        ] });
        return;
      }
      setPendingSignup(chatId, { attempts });
      await send(chatId, '⚠️ That code isn\'t right. Please try again.');
      return;
    }
    const ok = await (deps.reconnectBinding || reconnectBinding)(s.userId, chatId);
    clearPendingSignup(chatId);
    if (!ok) { await send(chatId, '⚠️ Something went wrong. Please try again.', SIGNUP_KEYBOARD); return; }
    await send(chatId, PERSONAL_WELCOME, MAIN_MENU_KEYBOARD);
    return;
  }

  await showSignupPrompt(chatId, deps);
}

// ---- Business "which staff?" picker (ADR-021 Phase 5, issue #107) -----------
// After a bound chat's receipt is saved, ask which STAFF MEMBER handed it over
// (staff are a name-only directory — lib/branches.js addStaff/listStaff — with no
// login/binding of their own; this tag is how their receipts get attributed).
// Same in-memory v1 pattern as `groups`/`pendingRemarkMessages` above (documented
// restart caveat): the picker's staff list is pinned per expense at send time, so a
// button tap can never mis-tag if the directory changes in between — a stale tap
// after a restart degrades to a harmless "picker expired" note, never a wrong tag.
// Telegram caps callback_data at 64 bytes, so buttons carry an INDEX into the pinned
// list ('sp:<expenseId>:<idx>'), exactly like the category picker's catpick pattern.
const pendingStaffPicks = new Map(); // expenseId -> { staff: [{id, name}], chatId }
// "Remember-last default": the staff member this chat last tagged is listed FIRST
// (with a ⭐) next time, since one clerk usually logs many receipts for the same person.
const lastStaffByChat = new Map(); // chatId -> staff_user_id

// Staff Lock Mode: lets a clerk lock all subsequent uploads to one staff member,
// skipping the per-receipt "Who is this for?" picker entirely. Same in-memory v1
// pattern/restart caveat as every other Map in this file (lock clears on restart;
// the clerk just re-taps "Staff Lock" — acceptable for v1).
const staffLockByChat = new Map(); // chatId -> { staffId, staffName, branchId }
const pendingStaffLockPicks = new Map(); // chatId -> { staff: [{id, name}], branchId }

// Business-mode reply keyboard: same persistent layout as MAIN_MENU_KEYBOARD plus a
// third row for Staff Lock. When `lock` is truthy the row shows the locked name + Done;
// when null/undefined it shows the "Staff Lock" entry point. Personal mode never calls
// this — it uses MAIN_MENU_KEYBOARD directly (byte-for-byte unchanged).
function businessMenuKeyboard(lock) {
  const rows = [
    ['📋 Today Bills', '💰 Today Expenses'],
    ['📅 Weekly Record', '🧭 Bot Guide'],
  ];
  if (lock) rows.push(['🔓 Locked: ' + lock.staffName, '✅ Done']);
  else rows.push(['👤 Staff Lock']);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

// Business "Today's Bills → Delete a bill → type the number" flow (M2 #107, business
// mode only). When a bound chat opens its Today's Bills list, the ordered expense ids
// are pinned here (in display order) so a later typed number maps to the right bill —
// exactly like the staff/category pickers pin their list at send time (Telegram's 64-byte
// callback_data can't carry the whole list). `armed` flips true only after the single
// "🗑️ Delete a bill" button is tapped, so a stray number never deletes anything. Same
// in-memory v1 caveat as the maps above: a bot restart drops the pin; the user just
// re-opens the list. Personal mode never populates this (keeps its per-bill ❌ buttons).
const pendingBillDelete = new Map(); // chatId -> { ids: [expenseId...], armed: boolean }

async function sendStaffPicker(chatId, expense, branchId, deps = {}) {
  const send = deps.tgSend || tgSend;
  const update = deps.sbUpdate || sbUpdate;
  const fetchStaff = deps.listStaff || listStaff;
  try {
    if (!expense || !expense.id || !branchId) return;
    const rows = await fetchStaff(branchId);
    if (!Array.isArray(rows) || !rows.length) return; // no staff directory yet — nothing to tag
    let staff = rows.map(s => ({ id: s.id, name: s.display_name || 'Staff' }));
    const lastId = lastStaffByChat.get(chatId);
    if (lastId) {
      const i = staff.findIndex(s => s.id === lastId);
      if (i > 0) staff = [staff[i], ...staff.slice(0, i), ...staff.slice(i + 1)];
    }
    // Issue #162 D11 (Owner directive: "always ask for staff name"): mark this receipt
    // as genuinely pending staff attribution, not just a fire-and-forget advisory message
    // — remembers the PRIOR status (e.g. 'needs_review' from an anomaly) so resolving the
    // pick restores it rather than clobbering it (see the `sp:` callback branch below).
    // Mirrors the awaiting_date / awaiting_category pattern already used in this file.
    pendingStaffPicks.set(expense.id, { staff, chatId, priorStatus: expense.status });
    try { await update('expenses', { id: expense.id }, { status: 'awaiting_staff' }); }
    catch (e) { console.error('[staff picker status]', e && e.message); }
    const kbRows = [];
    for (let i = 0; i < staff.length; i += 2) {
      kbRows.push(staff.slice(i, i + 2).map((s, j) => ({
        text: (s.id === lastId ? '⭐ ' : '') + s.name,
        callback_data: 'sp:' + expense.id + ':' + (i + j),
      })));
    }
    await send(chatId, '👤 *Who is this receipt for?*\n\n🏪 ' + (expense.merchant || 'Unknown')
      + ' — ' + fmtMoney(expense.amount, expense.currency), { inline_keyboard: kbRows });
  } catch (e) {
    console.error('[staff picker]', e && e.message);
    // Never blocks the save — the receipt is already logged; the tag is best-effort.
  }
}

// ---- Issue #152 part 1: batch/album staff attribution wizard ----------------------------
// One clerk logging receipts for the whole team means a single album can legitimately span
// several people (e.g. 10 photos = 4 Ali, 4 Siti, 2 Abu) — this walks each saved receipt
// ONE AT A TIME via a SINGLE self-editing message (not N separate sendStaffPicker prompts),
// with the last-picked person floating to the top (reuses the same star/remember-last
// behaviour as the single-photo picker) so a contiguous run is tap-top ×N. Same in-memory
// v1 pattern/restart caveat as the other pending* Maps in this file. Keyed by chatId (one
// clerk works one batch at a time — a second album mid-wizard replaces the pending one,
// same acceptable v1 simplification as pendingBillDelete).
const pendingBatchWizard = new Map(); // chatId -> { chatId, messageId, items:[{id,merchant,amount,currency,priorStatus}], idx, staff:[{id,name}], lastId }

function wizardStepView(wizard) {
  // Re-float the last-picked person to the top for EACH step (lastId changes mid-wizard
  // as picks happen) — same reorder sendStaffPicker does once at send-time, just re-applied
  // per step here. Mutates wizard.staff in place so callback_data indices (bwpick:<idx>)
  // stay consistent with whatever order THIS render used.
  if (wizard.lastId) {
    const li = wizard.staff.findIndex(s => s.id === wizard.lastId);
    if (li > 0) wizard.staff = [wizard.staff[li], ...wizard.staff.slice(0, li), ...wizard.staff.slice(li + 1)];
  }
  const it = wizard.items[wizard.idx];
  const kbRows = [];
  for (let i = 0; i < wizard.staff.length; i += 2) {
    kbRows.push(wizard.staff.slice(i, i + 2).map((s, j) => ({
      text: (s.id === wizard.lastId ? '⭐ ' : '') + s.name,
      callback_data: 'bwpick:' + (i + j),
    })));
  }
  kbRows.push([{ text: '👥 Same for all remaining', callback_data: 'bwall' }]);
  kbRows.push([{ text: '⏭ Skip — assign on dashboard', callback_data: 'bwskip' }]);
  const text = 'Receipt ' + (wizard.idx + 1) + ' of ' + wizard.items.length + ' · 🏪 '
    + (it.merchant || 'Unknown') + ' — ' + fmtMoney(it.amount, it.currency) + '\n\n👤 *Who is this for?*';
  return { text, keyboard: { inline_keyboard: kbRows } };
}

// Renders the CURRENT step, or — once idx has run off the end (every item picked/skipped)
// — edits the same message into a final "done" note and clears the wizard. Callers set
// wizard.idx themselves BEFORE calling this (pick/skip: +1; "same for all": jumps to the
// end) — this function only decides render-vs-finish, never advances on its own.
async function wizardRenderOrFinish(wizard, deps = {}) {
  const send = deps.tgSend || tgSend;
  const edit = deps.tgEditMessage || tgEditMessage;
  if (wizard.idx >= wizard.items.length) {
    pendingBatchWizard.delete(wizard.chatId);
    const doneText = '✅ *Staff assigned* for this batch.';
    if (wizard.messageId) await edit(wizard.chatId, wizard.messageId, doneText);
    else await send(wizard.chatId, doneText);
    return;
  }
  const { text, keyboard } = wizardStepView(wizard);
  if (wizard.messageId) await edit(wizard.chatId, wizard.messageId, text, keyboard);
  else await send(wizard.chatId, text, keyboard);
}

// startBatchStaffWizard(chatId, savedList, branchId, deps): savedList = flushGroup's own
// `saved` breakdown (each carrying the row's real id + priorStatus). No-ops (silently, same
// graceful-degrade contract as sendStaffPicker) when there's nothing to tag or the branch
// has no staff directory. Marks every item `awaiting_staff` UP FRONT (bulk) — issue #162
// D11's same "trackable pending state, not fire-and-forget" principle, applied to a batch.
async function startBatchStaffWizard(chatId, savedList, branchId, deps = {}) {
  const send = deps.tgSend || tgSend;
  const update = deps.sbUpdate || sbUpdate;
  const fetchStaff = deps.listStaff || listStaff;
  try {
    const items = (Array.isArray(savedList) ? savedList : []).filter(s => s && s.id);
    if (!items.length || !branchId) return;
    const rows = await fetchStaff(branchId);
    if (!Array.isArray(rows) || !rows.length) return; // no staff directory yet — nothing to ask
    let staff = rows.map(s => ({ id: s.id, name: s.display_name || 'Staff' }));
    const lastId = lastStaffByChat.get(chatId);
    if (lastId) {
      const i = staff.findIndex(s => s.id === lastId);
      if (i > 0) staff = [staff[i], ...staff.slice(0, i), ...staff.slice(i + 1)];
    }
    for (const it of items) {
      try { await update('expenses', { id: it.id }, { status: 'awaiting_staff' }); }
      catch (e) { console.error('[batch wizard status]', e && e.message); }
    }
    const wizard = { chatId, messageId: null, items: items.map(it => ({ ...it, priorStatus: it.status })), idx: 0, staff, lastId };
    pendingBatchWizard.set(chatId, wizard);
    const { text, keyboard } = wizardStepView(wizard);
    const r = await send(chatId, text, keyboard);
    if (r && r.result && r.result.message_id) wizard.messageId = r.result.message_id;
  } catch (e) {
    console.error('[batch wizard]', e && e.message);
    // Never blocks the batch — every receipt is already saved; attribution is best-effort.
  }
}

// #7 Telegram multi-photo: a media group arrives as N SEPARATE webhook updates that
// share a media_group_id, milliseconds apart. We buffer them (keyed by group id),
// debounce, then run the whole group through the shared runBatch() ONCE and reply with
// a single summary. Single-photo flow is unchanged. In-memory buffer = single-process
// v1 (documented in the spec); a group mid-arrival during a restart is best-effort.
const GROUP_DEBOUNCE_MS = Number(process.env.MASS_GROUP_DEBOUNCE_MS || '2000') || 2000;
// 2026-07-21 (post-qwen model switch, PR #296): the 2026-07-20 lowering to a hardcoded 2
// was a qwen-only workaround — qwen's per-key rate-limit ceiling meant even 3+ receipts in
// one batch risked a "too many at once" failure. Now that vision OCR runs on OpenRouter/Scout
// (not qwen/Groq), that ceiling no longer applies to this path, so the cap reverts to its
// original pre-qwen behavior: configurable via MASS_MAX_IMAGES, default 10. Going OVER this
// cap still rejects the whole batch unread (see g.overCap in flushGroup) rather than silently
// dropping extras. deps.maxGroupImages (test-only dependency injection) still overrides it.
const MAX_GROUP_IMAGES = Number(process.env.MASS_MAX_IMAGES || '10') || 10;
// 2026-07-20 incident: OCR_MAX_TOKENS (lib/ocr.js) was raised 2500->6000 to fix a real
// ~33% empty-output rate (docs/WORKLOG.md 2026-07-19) — correct, but it shrinks how many
// receipts fit in one Groq key's confirmed-live 8000-tokens/min budget, so an unpaced batch
// can now trip a rate limit mid-album. This paces runBatch's image reads (massupload.js's
// `pacingMs`) instead of touching the token budget/reasoning settings, which were Jeevan's
// deliberate, tested call and are not this fix's business to undo. 0 disables pacing.
// Widened 3000->6000 the same day (real production batch: 6 photos, 3 delayed by the rate
// limit even WITH 3s pacing — half the batch still exceeded the per-minute budget). This is
// a same-day safety-net widening, not a full fix — the actual fix for larger batches is
// adding more keys to GROQ_KEYS (the per-minute budget is PER KEY; more keys = proportionally
// more total throughput with zero speed/accuracy trade-off, unlike widening this further).
const MASS_IMAGE_PACING_MS = Number(process.env.MASS_IMAGE_PACING_MS || '6000') || 6000;
const groups = new Map(); // media_group_id -> { chatId, repName, fileIds:[], timer }

// Owner request 2026-07-04: an "Others" pick's prompt message should turn into the final
// "Saved" note once the typed remark arrives, not stay stuck on "please type a note" or
// spawn a separate new message. That edit happens in a LATER, separate webhook update (the
// remark text), so the original message_id has to be remembered somewhere in between —
// best-effort, in-memory (same v1 caveat as `groups`: a bot restart between the "Others"
// tap and the remark text loses the mapping, and tryResolveRemark falls back to sending a
// fresh confirmation message instead of editing — a graceful cosmetic degrade, never a
// data-loss one, since the expense row itself is never touched by this Map).
const pendingRemarkMessages = new Map(); // expenseId -> { chatId, messageId }

// pendingCardEdit (2026-08-23, Barat: reference mockup — "✏️ Edit" -> pick a field ->
// type the new value -> the card re-renders in place, never a new message). Deliberately
// a SEPARATE, in-memory-only map from the DB-status-column-based awaiting_date/
// awaiting_category/awaiting_remark flows above (those stay byte-for-byte unchanged) —
// this is for editing a field on an ALREADY-RESOLVED, already-saved expense on demand,
// which must never change the row's own `status`. Keyed by chatId (one chat can only be
// mid-edit for one thing at a time, same v1 simplification as tryResolveDate/
// tryResolveRemark's own oldest-first single-pending state) -> { expenseId, field,
// messageId }. Same restart-loses-the-mapping caveat as pendingRemarkMessages — cosmetic
// degrade only, the expense row itself is never touched until a valid reply arrives.
const pendingCardEdit = new Map(); // chatId -> { expenseId, field, messageId }

// Optional access allowlist: comma-separated Telegram chat IDs allowed to use the bot.
// Empty/unset = OPEN to anyone (back-compat, unchanged behavior). When set, only listed
// chat IDs are served; everyone else gets a polite "private bot" reply and nothing runs.
// A private financial bot should not accept receipts from strangers.
const ALLOWED_CHAT_IDS = String(process.env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

function bestPhotoFileId(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length) return msg.photo[msg.photo.length - 1].file_id;
  if (msg.document && /^image\//i.test(msg.document.mime_type || '')) return msg.document.file_id;
  return null;
}

// Issue #152: Telegram's file_unique_id (unlike file_id) is stable across resends of the
// SAME photo — the correct key for "did the clerk literally send this exact image
// before?" (lib/ocr.js assembleExpense's exact-resend check). Mirrors bestPhotoFileId's
// photo-vs-image-document precedence exactly, so the two always agree on which item they
// describe.
function bestPhotoFileUniqueId(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length) return msg.photo[msg.photo.length - 1].file_unique_id;
  if (msg.document && /^image\//i.test(msg.document.mime_type || '')) return msg.document.file_unique_id;
  return null;
}

// #1 PDF: a Telegram document is a PDF if its MIME type says so, or (belt-and-braces
// for clients that omit MIME) its filename ends .pdf. The REAL check that decides
// whether it's readable is rasterizePdf's own %PDF- magic-byte sniff (never trust
// this filename/MIME hint for anything security-relevant).
function isPdfDocument(msg) {
  const d = msg.document;
  if (!d) return false;
  if (/^application\/pdf$/i.test(d.mime_type || '')) return true;
  return /\.pdf$/i.test(d.file_name || '');
}

// Footer note for skipped (non-saved) photos. `skippedReasons` (optional) is a plain
// array of 'blurry' | 'not_receipt' | 'unclear' | 'date_unreadable' — one entry per
// skipped receipt, in the order they were skipped — captured by flushGroup's
// captureAssemble wrapper. When it's available and fully accounted for, breaks the count
// down by WHY (mirrors the single-photo skipMessage() wording in lib/ocr.js); otherwise
// falls back to one safe generic line rather than guessing.
//
// 2026-07-21: 'date_unreadable' (the receipt LOOKED clear but its date was implausible —
// e.g. a misread year) gets its own bucket rather than falling into the generic "didn't
// look like a clear receipt" line, which would misdescribe a perfectly clear photo.
function skipFooter(summary, skippedReasons) {
  if (!summary.skipped) return '';
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const generic = '\n\n_' + plural(summary.skipped, 'photo') + " didn't look like a clear receipt, so "
    + (summary.skipped === 1 ? 'it was' : 'they were') + ' NOT saved — please re-upload '
    + (summary.skipped === 1 ? 'it' : 'them') + '._';
  if (!Array.isArray(skippedReasons) || skippedReasons.length !== summary.skipped) return generic;
  const blurryN = skippedReasons.filter(r => r === 'blurry').length;
  const notReceiptN = skippedReasons.filter(r => r === 'not_receipt').length;
  const dateN = skippedReasons.filter(r => r === 'date_unreadable').length;
  if (blurryN + notReceiptN + dateN !== summary.skipped) return generic; // some 'unclear' in the mix — stay safe/generic
  const bits = [];
  if (blurryN) bits.push(plural(blurryN, 'photo') + ' too blurry or unclear to read confidently');
  if (notReceiptN) bits.push(plural(notReceiptN, 'photo') + " that didn't look like a receipt at all");
  if (dateN) bits.push(plural(dateN, 'photo') + " whose date couldn't be read clearly");
  const joined = bits.length > 1 ? bits.slice(0, -1).join(', ') + ' and ' + bits[bits.length - 1] : bits[0];
  return '\n\n_' + joined + ' — NOT saved, please re-upload._';
}

// User-facing batch summary. `saved` (optional) is a list of the receipts that were
// actually logged — {merchant, amount, currency, category, flagged} — so we can show a
// per-receipt breakdown, not just counts. It's our OWN saved data (merchant/amount from
// the receipt), never the raw failed[].reason error text (that stays hidden — SOP §7.2).
// `skippedReasons` (optional) feeds skipFooter() above. `awaitingCount` (optional, Owner
// request 2026-07-03): how many of `summary.saved` are actually rows still waiting on a
// manual category pick — subtracted out of the headline "saved" count and shown as its
// own bucket instead, so the count line stays honest (an uncertain-category row IS saved
// to the DB, per runBatch, but showing it as plain "saved" here would be misleading —
// a SEPARATE per-receipt picker prompt follows this summary for each one instead).
function formatBatchSummary(summary, saved, skippedReasons, awaitingCount) {
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const pendingN = awaitingCount || 0;
  const shownSaved = Math.max(0, summary.saved - pendingN);
  const parts = [plural(summary.images, 'photo'), plural(summary.receipts, 'receipt'), shownSaved + ' saved'];
  if (pendingN) parts.push(plural(pendingN, 'receipt') + ' need a category picked');
  if (summary.flagged.length) parts.push(summary.flagged.length + ' need review');
  // A photo the model couldn't honestly read as a receipt (e.g. a temple photo or a
  // QR-code screenshot mixed into the same album) — never saved with forced/guessed
  // data, just counted here (mirrors the single-photo "Not a receipt — skipped" reply).
  if (summary.skipped) parts.push(plural(summary.skipped, 'photo') + ' not a clear receipt');
  // 2026-07-20 incident: a batch is the MOST likely place to exhaust the Groq key pool's
  // per-minute token budget (several images back to back within the same minute) — telling
  // the user those specific photos "couldn't read" would be false; the photo was fine, the
  // account was just temporarily rate-limited. Split failed[] on the sanitized rateLimited
  // flag (lib/massupload.js) so only genuine unreadable-image failures get that wording.
  const rateLimitedCount = summary.failed.filter((f) => f && f.rateLimited).length;
  const genuineFailedCount = summary.failed.length - rateLimitedCount;
  if (genuineFailedCount) parts.push(genuineFailedCount + ' couldn\'t read');
  if (rateLimitedCount) parts.push(plural(rateLimitedCount, 'receipt') + ' delayed by high demand');
  let text = '✅ *Batch processed*\n\n' + parts.join(' · ');
  // Owner directive 2026-07-11: when anything was NOT saved (skipped/unreadable/duplicate),
  // say so LOUDLY right under the header so it can't hide beneath the cheerful ✅ — each of
  // those photos gets its own follow-up (a re-send thumbnail or duplicate notice) below.
  const notSaved = (summary.skipped || 0) + (summary.failed.length || 0) + (summary.duplicates || 0);
  if (notSaved) {
    text += '\n\n⚠️ *' + plural(notSaved, 'receipt') + ' ' + (notSaved === 1 ? 'was' : 'were')
      + ' NOT saved — please re-send ' + (notSaved === 1 ? 'it' : 'them') + ' (details below).*';
  }
  if (rateLimitedCount) {
    text += '\n\n⏳ *' + plural(rateLimitedCount, 'receipt') + ' hit a temporary limit from sending too many at once — '
      + 'please wait about a minute, then resend just ' + (rateLimitedCount === 1 ? 'that one' : 'those') + '.*';
  }
  if (Array.isArray(saved) && saved.length) {
    const MAX = 15; // keep the message tidy / under Telegram's length cap
    text += '\n';
    saved.slice(0, MAX).forEach((s, i) => {
      // ADR-017: voucher_no is optional (only present once the DB migration is applied) —
      // shown when available, omitted otherwise, same rule as the single-photo reply.
      text += '\n' + (i + 1) + '. *' + (s.merchant || 'Unknown') + '* — ' + fmtMoney(s.amount, s.currency)
        + ' · ' + (s.category || 'Others') + (s.voucher_no ? ' · ' + s.voucher_no : '') + (s.flagged ? ' ⚠️' : '');
    });
    if (saved.length > MAX) text += '\n_…and ' + (saved.length - MAX) + ' more._';
  }
  text += skipFooter(summary, skippedReasons);
  if (summary.truncated_images.length) text += '\n\n_Some photos held more receipts than I could read at once._';
  return text + '\n\n_Open your dashboard to review._';
}

// Live QA (2026-07-13): an album's "reading them all now…" ack arrived, but the final
// summary never did — no error, no trace, just silence. Root cause: tgSend NEVER
// THROWS (lib/telegram.js swallows a Telegram/network failure internally and just
// console.errors), so flushGroup's own try/catch — which only guards against a THROW —
// cannot detect a swallowed send failure on the one message that actually tells the user
// what happened. From the user's side that's indistinguishable from "the bot got stuck".
// This checks tgSend's own return value for flushGroup's TERMINAL replies (the ones that
// are this album's last word — download-fail / the main summary / the catch-all error)
// and retries once after a short delay before giving up. Bounded to exactly one retry —
// this is a safety net for a transient blip, not a queue/backoff system.
async function sendFinal(send, chatId, text, keyboard, deps, label) {
  const wait = deps.setTimeout || setTimeout;
  const delay = deps.finalRetryDelayMs != null ? deps.finalRetryDelayMs : 800;
  const ok = (r) => !!r && r.ok !== false;
  let r = await send(chatId, text, keyboard);
  if (ok(r)) return r;
  console.error('[group] final send failed, retrying once', JSON.stringify({ label, chatId: String(chatId) }));
  await new Promise((resolve) => wait(resolve, delay));
  r = await send(chatId, text, keyboard);
  if (!ok(r)) console.error('[group] final send failed twice — user got NO reply for this batch', JSON.stringify({ label, chatId: String(chatId) }));
  return r;
}

// Extracted (2026-07-20, bulk-spam incident): several individually-sent photos each used to
// independently spam their own "Reading your receipt…" ack and fire at the AI service with
// zero pacing between them (no media_group_id to coalesce them under). Photos now ALWAYS
// buffer through the same groups Map as a real Telegram album (see handleUpdate below) —
// under a synthetic 'solo:<chatId>' key when Telegram gives no media_group_id — so several
// individual sends within one debounce window still coalesce into ONE batch. This function is
// what flushGroup calls when a group ends up with exactly one photo (a genuinely solo send,
// or a burst nobody else joined): it replays the EXACT single-receipt "Expense Captured"
// reply from before this change, never the batch-summary format. The "Reading your
// receipt…" ack itself is sent ONCE, at group-creation time in handleUpdate (same "first
// photo only" rule the album ack already followed) — NOT here, so this only processes.
async function processSinglePhoto(chatId, repName, photoFileId, fileUniqueId, branchId, companyId, deps = {}, ownerUserId = null, accountId = null) {
  const lock = staffLockByChat.get(chatId);
  const bm = { ...(branchId ? { branch_id: branchId } : {}), ...(companyId ? { company_id: companyId } : {}) };
  if (lock) bm.staff_user_id = lock.staffId;
  if (ownerUserId) bm.owner_user_id = ownerUserId; // Guest Mode (2026-07-28)
  if (accountId) bm.account_id = accountId; // 2026-08-14 security fix — see assembleExpense's doc comment
  // silent (2026-07-20): when locked, sendLockedReceipt below sends its OWN confirmation —
  // expenseFromPhoto's generic "Expense Captured" reply must stay quiet so the user only
  // ever sees ONE confirmation per receipt, not two.
  const meta = { ...bm, file_unique_id: fileUniqueId, silent: !!lock };
  const res = await (deps.expenseFromPhoto || expenseFromPhoto)(chatId, repName, photoFileId, meta);
  if (branchId && res && res.ok && res.expense) {
    if (lock) {
      await (deps.sendLockedReceipt || sendLockedReceipt)(chatId, res.expense, lock, deps);
    } else {
      await (deps.sendStaffPicker || sendStaffPicker)(chatId, res.expense, branchId, deps);
    }
  }
}

// Flush one buffered media group: resolve each file_id -> URL, runBatch once, one reply.
// Never throws (mirrors expenseFromPhoto's graceful degradation).
async function flushGroup(groupId, deps = {}) {
  const g = groups.get(groupId);
  if (!g) return;
  groups.delete(groupId);
  if (!g.fileIds.length) return;
  // 2026-07-20 (owner request): over-cap REJECTS THE WHOLE BATCH, unread — nothing is scanned
  // at all, not even the first `cap` photos. Checked before anything else runs (isSolo/
  // runBatch/etc.) so an over-limit send costs zero AI calls. deps.maxGroupImages mirrors the
  // same override handleUpdate already supports, so tests can inject a smaller cap here too.
  if (g.overCap) {
    const cap = deps.maxGroupImages || MAX_GROUP_IMAGES;
    await sendFinal(deps.tgSend || tgSend, g.chatId,
      '⚠️ *Max ' + cap + ' receipts per batch.*\nPlease send only ' + (cap === 1 ? '1 receipt' : ('1 to ' + cap + ' receipts')) + ' at a time.',
      undefined, deps, 'over-cap-reject');
    return;
  }
  // 2026-07-20: a SYNTHETIC (isSolo) group that only ever got one photo -> the single-receipt
  // reply, not a batch summary. A real Telegram media_group_id never has isSolo:true (see the
  // handleUpdate doc comment above), so a genuine album always takes the batch path below
  // regardless of how many images it ended up with. Own try/catch (not folded into the batch
  // try below) so this function keeps its "never throws" contract even though the real
  // expenseFromPhoto already never throws on its own — a test/hostile dep still must not
  // escape here uncaught.
  if (g.isSolo && g.fileIds.length === 1) {
    try {
      await (deps.processSinglePhoto || processSinglePhoto)(g.chatId, g.repName, g.fileIds[0], g.fileUniqueIds[0], g.branchId, g.companyId, deps, g.ownerUserId, g.accountId);
    } catch (e) {
      console.error('[group solo]', e && e.message);
      await sendFinal(deps.tgSend || tgSend, g.chatId, '⚠️ Couldn\'t process that receipt. Please resend the photo.', undefined, deps, 'solo-catch-all');
    }
    return;
  }
  // send is resolved first, outside the try — it's the one thing the catch block
  // itself depends on to report failure, so it must survive even if every other
  // dep below throws while being resolved (e.g. a hostile/misconfigured deps object).
  const send = deps.tgSend || tgSend;
  const sendPhoto = deps.tgSendPhoto || tgSendPhoto;
  // Diagnosability (2026-07-13): the in-memory `groups` Map has no persistence — a process
  // restart mid-flush silently strands an album with no trace at all. These two log lines
  // don't fix that, but they mean a future "bot got stuck" report can be checked against
  // the server logs: did flush:start ever fire for that groupId? Did it reach flush:done?
  const startedAt = Date.now();
  console.log('[group flush:start]', JSON.stringify({ groupId, chatId: String(g.chatId), images: g.fileIds.length }));
  try {
    const fileUrl = deps.tgFileUrl || tgFileUrl;
    const fetchSpec = deps.getFieldSpec || getFieldSpec;
    const batch = deps.runBatch || runBatch;
    const extract = deps.extractReceipts || extractReceipts;
    const assemble = deps.assembleExpense || assembleExpense;
    const fieldSpec = await fetchSpec();
    // Issue #152: index-ALIGNED with g.fileIds (a failed download is `null`, not dropped)
    // so image_index in runBatch's summary (failed/skippedDetails/duplicateDetails) always
    // maps back to the correct g.fileIds[i] — needed to resend the RIGHT photo's thumbnail
    // on a skip. A null entry surfaces in summary.failed via runBatch's own try/catch
    // (extractReceipts on a null image throws) — a genuine improvement: a partial download
    // failure used to be silently dropped and never reported at all.
    const images = [];
    for (const fid of g.fileIds) {
      try { const f = await fileUrl(fid); images.push(f && f.url ? f.url : null); } catch { images.push(null); }
    }
    if (images.every(u => u == null)) { await sendFinal(send, g.chatId, '📷 Couldn\'t download those photos. Please resend them.', undefined, deps, 'download-fail'); return; }
    // ADR-018 (2026-07-11 gap fix): store a DURABLE copy of each album photo in the private
    // `receipts` bucket and carry its object path per-image as receipt_url — WITHOUT this, an
    // album receipt saved fine (merchant/amount) but had receipt_url=null, so no thumbnail on
    // the dashboard and no photo in PDF exports (the single-photo + dashboard-upload paths
    // already did this; only flushGroup/handlePdfDocument were missing it). Index-aligned with
    // g.fileIds/images. downloadAndStoreReceiptImage never throws → null on failure → the row
    // still saves imageless, exactly like routes/upload.js. Injectable for hermetic tests.
    const storeImage = deps.downloadAndStoreReceiptImage || downloadAndStoreReceiptImage;
    const receiptUrls = await Promise.all(images.map((url) => (url ? storeImage(url) : Promise.resolve(null))));
    // Option (A), decided with J1 (issue #31 tracks per-image links): one meta for the
    // batch, fileId:null — consistent with the dashboard adapter; assembleExpense tolerates null.
    // branch_id/company_id (business only, M2 #107/#8): pinned on the group at creation —
    // the whole album is attributed to the capturing chat's branch + company. Absent in
    // personal mode. rejectDuplicates (issue #152): extends #162 D13's exact-reject
    // behaviour from the single-photo path to the batch path too — was previously only
    // flag-and-save here, the same gap #162 already closed for single photos.
    const batchLock = staffLockByChat.get(g.chatId);
    const meta = { chatId: g.chatId, repName: g.repName, fileId: null,
      ...(g.branchId ? { branch_id: g.branchId } : {}),
      ...(g.companyId ? { company_id: g.companyId } : {}),
      ...(batchLock ? { staff_user_id: batchLock.staffId } : {}),
      ...(g.ownerUserId ? { owner_user_id: g.ownerUserId } : {}), // Guest Mode (2026-07-28)
      ...(g.accountId ? { account_id: g.accountId } : {}), // 2026-08-14 security fix
      rejectDuplicates: true };
    // Per-image file_unique_id (issue #152) — the stable id used for exact-resend
    // detection, distinct from the fileId/URL used to read the image content.
    // Per-image fileId (2026-07-12, finally closing issue #31's per-image-link gap):
    // stored as receipt_file_id so an album row keeps a Telegram fallback — if the
    // Storage copy ever fails to serve, routes/receipt.js can still stream the photo
    // straight from Telegram (single-photo rows always had this; album rows had null).
    const metaForImage = (i) => ({ ...meta, fileId: g.fileIds[i] || null, receipt_file_unique_id: g.fileUniqueIds[i], receipt_url: receiptUrls[i] || null });
    // Capture each saved receipt's details WITHOUT touching runBatch (Jeevan's file):
    // wrap the injected assembleExpense so every successfully-assembled expense is
    // recorded here, then rendered as a per-receipt breakdown in the summary.
    const saved = [];
    const skippedReasons = []; // one 'blurry' | 'not_receipt' | 'unclear' per skipped receipt, feeds skipFooter()
    // Owner request 2026-07-03: a receipt whose category is uncertain is already saved
    // (assembleExpense inserted it) but kept OUT of the normal `saved` breakdown — it
    // gets its own separate category-picker message, sent AFTER the main summary below.
    const awaitingPicks = [];
    let guestCappedCount = 0; // Guest Mode (2026-07-28) — one cap-reached message after the summary, not one per image
    const captureAssemble = async (args) => {
      const res = await assemble(args);
      if (res && res.guestCapped) {
        guestCappedCount += 1;
      } else if (res && res.skipped) {
        skippedReasons.push(res.skipReason || 'unclear');
      } else if (res && res.duplicate) {
        // Issue #152: NOT saved (assembleExpense rejected it) — must NOT land in `saved`
        // below. Per-duplicate reply is sent after the summary, from summary.duplicateDetails.
      } else if (res && res.awaitingCategory) {
        awaitingPicks.push(res);
      } else if (res && res.expense) {
        const e = res.expense;
        saved.push({ id: e.id, merchant: e.merchant, amount: e.amount, currency: e.currency, category: e.category, voucher_no: e.voucher_no, flagged: !!res.flagged, status: e.status });
      }
      return res;
    };
    const summary = await batch(images, fieldSpec, { extractReceipts: extract, assembleExpense: captureAssemble, meta, metaForImage,
      pacingMs: deps.batchPacingMs != null ? deps.batchPacingMs : MASS_IMAGE_PACING_MS, sleep: deps.sleep });
    await sendFinal(send, g.chatId, formatBatchSummary(summary, saved, skippedReasons, awaitingPicks.length), undefined, deps, 'summary');
    // Guest Mode (2026-07-28): one cap-reached notice after the summary if any image in this
    // batch hit the 4-receipt limit — whatever DID fit under the cap is already reflected in
    // `saved` above, this is purely about the ones that got refused.
    if (guestCappedCount > 0) await send(g.chatId, GUEST_CAP_REACHED_MESSAGE);
    // One separate follow-up prompt+keyboard per uncertain receipt (matches the Owner's
    // own example: 5 photos, 3 confident -> one summary, 2 uncertain -> two more messages).
    for (const res of awaitingPicks) {
      await send(g.chatId, categoryPromptText(res.expense), buildCategoryKeyboard(res.expense.id, res.categoryOptions));
    }
    // Issue #152 D13 (batch): one reject reply per exact duplicate, pointing at the
    // EXISTING receipt — same View/Edit buttons as the single-photo path (reuse, not
    // rebuild). Never blocks the rest of the batch summary above.
    if (Array.isArray(summary.duplicateDetails)) {
      for (const d of summary.duplicateDetails) {
        if (!d || !d.duplicateOf) continue;
        await send(g.chatId, duplicateRejectedText(d.duplicateOf), buildDuplicateKeyboard(d.duplicateOf.id));
      }
    }
    // Issue #152 part 2 (per-photo failure feedback): resend the SPECIFIC offending
    // photo's own thumbnail with a reason-specific ask, instead of only a generic count
    // in the summary above (skipFooter still shows the aggregate breakdown too).
    if (Array.isArray(summary.skippedDetails)) {
      for (const s of summary.skippedDetails) {
        const fid = s && g.fileIds[s.image_index];
        if (fid) await sendPhoto(g.chatId, fid, skipMessage(s.reason));
      }
    }
    // Business staff attribution wizard (issue #152 part 1): one self-editing message
    // walks each saved receipt needing a staff tag. No-ops (silently) in personal mode,
    // when there's nothing saved, or when the branch has no staff directory — same
    // graceful-degrade contract as the single-photo sendStaffPicker.
    if (g.branchId && saved.length) {
      if (batchLock) {
        await (deps.sendLockedBatchSummary || sendLockedBatchSummary)(g.chatId, saved, batchLock, deps);
      } else {
        await (deps.startBatchStaffWizard || startBatchStaffWizard)(g.chatId, saved, g.branchId, deps);
      }
    }
    console.log('[group flush:done]', JSON.stringify({ groupId, chatId: String(g.chatId), saved: saved.length, skipped: skippedReasons.length, failed: summary.failed.length, elapsedMs: Date.now() - startedAt }));
  } catch (e) {
    console.error('[group]', e && e.message);
    await sendFinal(send, g.chatId, '⚠️ Couldn\'t process that batch. Please resend the photos.', undefined, deps, 'catch-all');
  }
}

// #1 PDF document -> rasterizePdf -> ONE runBatch -> ONE counts-only reply. Mirrors
// flushGroup's never-throws / no-internals-leaked style. rasterizePdf's pages are PNG
// Buffers (pure decode, no Groq knowledge); extractReceipts forwards its `image` param
// straight to Groq as image_url.url, so each page is base64-encoded to a data URI here
// before runBatch — the same shape the media-group adapter already sends (a string per
// image), just sourced from freshly rendered bytes instead of a Telegram-hosted URL.
// extraMeta (optional, business only): { branch_id?, company_id? } — merged into the batch
// meta so a bound chat's PDF receipts carry branch + company attribution. {} in personal
// mode (unchanged).
async function handlePdfDocument(chatId, repName, fileId, deps = {}, extraMeta = {}) {
  const send = deps.tgSend || tgSend;
  const fileUrl = deps.tgFileUrl || tgFileUrl;
  const download = deps.hreq || hreq;
  const raster = deps.rasterizePdf || rasterizePdf;
  const fetchSpec = deps.getFieldSpec || getFieldSpec;
  const batch = deps.runBatch || runBatch;
  const extract = deps.extractReceipts || extractReceipts;
  const assemble = deps.assembleExpense || assembleExpense;
  try {
    // Quiet mode: no "Reading…" ack — one summary reply only.
    const f = await fileUrl(fileId);
    if (!f || !f.url) { await send(chatId, '📄 Couldn\'t download that PDF. Please resend it.'); return; }
    const buf = await download({ url: f.url, encoding: 'arraybuffer' });
    const { pages, truncated: pagesTruncated } = await raster(buf);
    const fieldSpec = await fetchSpec();
    const images = pages.map(p => 'data:image/png;base64,' + p.toString('base64'));
    // ADR-018 (2026-07-11 gap fix): store a durable copy of each rendered PDF page in the
    // private `receipts` bucket and carry its object path per-page as receipt_url — same gap
    // flushGroup had. We already hold the page BYTES (raster output), so upload them directly
    // (no re-download). uploadReceiptImage never throws → null on failure → row saves imageless.
    // Injectable for hermetic tests. Index-aligned with pages/images.
    const storePage = deps.uploadReceiptImage || uploadReceiptImage;
    const receiptUrls = await Promise.all(pages.map((p) => storePage(p)));
    const pdfLock = staffLockByChat.get(chatId);
    const meta = { chatId, repName, fileId: null, // option A (issue #31): single meta, no per-page link
      ...(extraMeta && extraMeta.branch_id ? { branch_id: extraMeta.branch_id } : {}),
      ...(extraMeta && extraMeta.company_id ? { company_id: extraMeta.company_id } : {}),
      ...(extraMeta && extraMeta.owner_user_id ? { owner_user_id: extraMeta.owner_user_id } : {}), // Guest Mode (2026-07-28)
      ...(extraMeta && extraMeta.account_id ? { account_id: extraMeta.account_id } : {}), // 2026-08-14 security fix
      ...(pdfLock ? { staff_user_id: pdfLock.staffId } : {}) };
    const metaForImage = (i) => ({ ...meta, receipt_url: receiptUrls[i] || null });
    // Parity with flushGroup: capture per-receipt details + skip reasons so a PDF that
    // renders fine but yields nothing usable gets an honest explanation ("not a clear
    // receipt") instead of a bare, unexplained "0 saved" (fixed 2026-07-03).
    const saved = [];
    const skippedReasons = [];
    let guestCappedCount = 0; // Guest Mode (2026-07-28)
    const captureAssemble = async (args) => {
      const res = await assemble(args);
      if (res && res.guestCapped) {
        guestCappedCount += 1;
      } else if (res && res.skipped) {
        skippedReasons.push(res.skipReason || 'unclear');
      } else if (res && res.expense) {
        const e = res.expense;
        saved.push({ merchant: e.merchant, amount: e.amount, currency: e.currency, category: e.category, flagged: !!res.flagged });
      }
      return res;
    };
    const summary = await batch(images, fieldSpec, { extractReceipts: extract, assembleExpense: captureAssemble, meta, metaForImage,
      pacingMs: deps.batchPacingMs != null ? deps.batchPacingMs : MASS_IMAGE_PACING_MS, sleep: deps.sleep });
    let text = formatBatchSummary(summary, saved, skippedReasons);
    if (pagesTruncated) text += '\n\n_This PDF had more pages than I could read at once._';
    await send(chatId, text);
    if (guestCappedCount > 0) await send(chatId, GUEST_CAP_REACHED_MESSAGE);
  } catch (e) {
    console.error('[pdf]', e && e.message);
    await send(chatId, '📄 Couldn\'t read that PDF. Please resend a clearer scan.');
  }
}

// ---- Staff Lock Mode: activation + locked-receipt summary --------------------------
// handleStaffLockStart shows the same staff directory the picker uses, but as a
// one-time selection that LOCKS all subsequent uploads to that person — no per-receipt
// "Who is this for?" until the clerk taps Done. Reuses listStaff from lib/branches.js.
async function handleStaffLockStart(chatId, branchId, deps = {}) {
  const send = deps.tgSend || tgSend;
  const fetchStaff = deps.listStaff || listStaff;
  try {
    if (!branchId) { await send(chatId, '⚠️ No branch assigned — staff lock needs a branch.'); return; }
    const rows = await fetchStaff(branchId);
    if (!Array.isArray(rows) || !rows.length) {
      await send(chatId, '👤 No staff members found. Add staff to your branch first.');
      return;
    }
    const staff = rows.map(s => ({ id: s.id, name: s.display_name || 'Staff' }));
    pendingStaffLockPicks.set(chatId, { staff, branchId });
    const kbRows = [];
    for (let i = 0; i < staff.length; i += 2) {
      kbRows.push(staff.slice(i, i + 2).map((s, j) => ({
        text: s.name,
        callback_data: 'slock:' + (i + j),
      })));
    }
    await send(chatId, '👤 *Staff Lock Mode*\n\nPick a staff member. All receipts you upload will be auto-assigned to them until you tap *Done*.', { inline_keyboard: kbRows });
  } catch (e) {
    console.error('[staff lock start]', e && e.message);
    await send(chatId, '⚠️ Couldn\'t load the staff list right now. Please try again.');
  }
}

// After each receipt saved in locked mode: show the receipt summary with Edit + Done.
// Edit reuses the existing catedit: callback (zero changes to edit flow). Done ends
// the lock via the slockdone callback.
async function sendLockedReceipt(chatId, expense, lock, deps = {}) {
  const send = deps.tgSend || tgSend;
  if (!expense) return;
  const lines = ['✅ *Receipt saved* → *' + lock.staffName + '*'];
  if (expense.merchant) lines.push('🏪 ' + expense.merchant);
  if (expense.amount != null) lines.push('💰 ' + fmtMoney(expense.amount, expense.currency));
  if (expense.expense_date) lines.push('📅 ' + expense.expense_date);
  if (expense.category && expense.category !== PENDING_CATEGORY) lines.push('📂 ' + expense.category);
  if (expense.voucher_no) lines.push('🔖 ' + expense.voucher_no);
  const keyboard = { inline_keyboard: [
    [{ text: '✏️ Edit category', callback_data: 'catedit:' + expense.id }],
    [{ text: '✅ Done — unlock', callback_data: 'slockdone' }],
  ] };
  await send(chatId, lines.join('\n'), keyboard);
}

// After a batch saved in locked mode: summary + Done button.
async function sendLockedBatchSummary(chatId, saved, lock, deps = {}) {
  const send = deps.tgSend || tgSend;
  const lines = ['✅ *' + saved.length + ' receipt' + (saved.length === 1 ? '' : 's') + ' saved* → *' + lock.staffName + '*'];
  for (const s of saved) {
    lines.push('  🏪 ' + (s.merchant || 'Unknown') + ' — ' + fmtMoney(s.amount, s.currency));
  }
  const keyboard = { inline_keyboard: [
    [{ text: '✅ Done — unlock', callback_data: 'slockdone' }],
  ] };
  await send(chatId, lines.join('\n'), keyboard);
}

// In-chat delete (issue: "Delete receipt" typed by a user got an unrelated generic
// reply). Scoped to THIS chat's own most-recent receipt (rep_chat_id) — a chat can only
// ever be offered its own rows to delete, never another rep's. Requires an explicit
// button tap (never deletes on the word alone) so a stray "delete" in conversation
// can't wipe data.
async function handleDeleteIntent(chatId, deps = {}) {
  const send = deps.tgSend || tgSend;
  const select = deps.sbSelect || sbSelect;
  try {
    const rows = await select('expenses', { eq: { rep_chat_id: String(chatId) }, extra: 'deleted_at=is.null', order: 'created_at.desc', limit: 1 });
    if (!rows.length) { await send(chatId, '🗑️ You don\'t have any receipts to delete yet.'); return; }
    const r = rows[0];
    const keyboard = { inline_keyboard: [[
      { text: '✅ Yes, delete it', callback_data: 'del:' + r.id },
      { text: '✋ Cancel', callback_data: 'del:cancel' }
    ]] };
    await send(chatId,
      '🗑️ Delete your most recent receipt?\n\n🏪 *' + (r.merchant || 'Unknown') + '*\n💰 ' + fmtMoney(r.amount, r.currency) + '\n📅 ' + r.expense_date,
      keyboard);
  } catch (e) {
    console.error('[delete intent]', e.message);
    await send(chatId, '⚠️ Could not look up your receipts right now.');
  }
}

// Handles the Yes/Cancel tap from handleDeleteIntent's keyboard. Re-checks ownership
// (rep_chat_id) and not-already-deleted at CONFIRM time, not just at prompt time — the
// callback_data only carries an id, so this is the actual authorization check, not the
// prompt above. Always acks the callback (deps.tgAnswerCallback) so the button never
// spins forever on the user's phone, even on error.
async function handleCallbackQuery(cq, deps = {}) {
  const answer = deps.tgAnswerCallback || tgAnswerCallback;
  const send = deps.tgSend || tgSend;
  const edit = deps.tgEditMessage || tgEditMessage;
  const select = deps.sbSelect || sbSelect;
  // sbSelectGlobal (2026-08-23): every 'expenses' lookup by `id` alone in this function used
  // to go through the scoped `select` above, which defaults to account_id=cfg.ACCOUNT_ID when
  // no scope is passed. That silently broke EVERY post-capture button (category pick, edit,
  // delete, duplicate view/edit/delete, staff picker) for any account with its own unique
  // account_id — i.e. every real personal signup since 2026-08-14, confirmed live: a receipt
  // captured seconds earlier under Barat's own account_id (p_0a0b1781...) came back "already
  // gone" the instant he tapped a category, because the lookup was searching the OLD shared
  // bucket for a row that was never there. `id` is already a globally-unique primary key (same
  // reasoning as every other identity-lookup fix this session — see lib/supabase.js's
  // sbSelectGlobal doc comment), so no account_id filter was ever needed here for correctness;
  // the real ownership check (String(row.rep_chat_id) !== String(chatId), right below each of
  // these) is untouched and still runs exactly as before.
  const selectGlobal = deps.sbSelectGlobal || sbSelectGlobal;
  const softDelete = deps.sbSoftDelete || sbSoftDelete;
  const update = deps.sbUpdate || sbUpdate;
  const pending = deps.pendingRemarkMessages || pendingRemarkMessages;
  const pendingCard = deps.pendingCardEdit || pendingCardEdit;
  const data = (cq && cq.data) || '';
  const chatId = cq && cq.message && cq.message.chat && cq.message.chat.id;
  const messageId = cq && cq.message && cq.message.message_id;
  if (!chatId) { await answer(cq && cq.id); return; }

  // Owner request 2026-07-04: the Yes/Cancel delete prompt should turn into its own
  // result in place (buttons cleared) — no separate new message — same edit-in-place
  // pattern already used for the category-picker. `reply(text)` below picks edit vs send
  // depending on whether this update carries a message_id (every real Telegram tap does;
  // the `else send` branch only exists as a defensive fallback, same as elsewhere in this file).
  const reply = (text) => (messageId ? edit(chatId, messageId, text) : send(chatId, text));
  if (data === 'del:cancel') {
    await answer(cq.id);
    await reply('👍 Kept it — no changes.');
    return;
  }
  // Business staff-tag pick ('sp:<expenseId>:<idx>', M2 issue #107): resolve the index
  // against the staff list PINNED at send time (pendingStaffPicks) — never a fresh
  // directory query, so a changed directory can't silently mis-tag. A stale tap (bot
  // restarted in between) degrades to an honest "expired" note; the receipt row itself
  // is already saved either way, only the attribution tag is affected.
  if (data.indexOf('sp:') === 0) {
    const parts = data.split(':'); // ['sp', expenseId, idx]
    const expenseId = parts[1];
    const pick = pendingStaffPicks.get(expenseId);
    const staffEntry = pick && pick.staff[Number(parts[2])];
    if (!pick || !staffEntry) {
      await answer(cq.id, { text: 'Expired' });
      await reply('👤 That staff picker has expired — the receipt is saved, just without a staff tag. You can set it from the dashboard.');
      return;
    }
    try {
      // Issue #162 D11: restore whatever status this receipt was in BEFORE the staff
      // ask (e.g. 'needs_review' from an anomaly) rather than clobbering it — the staff
      // ask must not silently erase an unrelated flag. Falls back to 'saved' for safety
      // if priorStatus is somehow missing (older pin shape / defensive).
      await update('expenses', { id: expenseId }, { staff_user_id: staffEntry.id, status: pick.priorStatus || 'saved' });
      pendingStaffPicks.delete(expenseId);
      lastStaffByChat.set(chatId, staffEntry.id);
      await answer(cq.id, { text: 'Tagged' });
      await reply('👤 Tagged to *' + staffEntry.name + '* ✅');
    } catch (e) {
      console.error('[staffpick]', e && e.message);
      await answer(cq.id);
      await reply('⚠️ Couldn\'t save that tag right now — the receipt itself is safe. You can set the staff from the dashboard.');
    }
    return;
  }
  // Issue #152 part 1: batch/album staff-attribution wizard taps. Keyed by chatId (one
  // wizard per chat at a time — same in-memory pattern as pendingBillDelete). A missing
  // wizard (expired/never started, e.g. after a bot restart) degrades to an honest note;
  // every receipt is already saved either way, only the attribution tag is affected.
  if (data.indexOf('bwpick:') === 0) {
    const wizard = pendingBatchWizard.get(chatId);
    if (!wizard) {
      await answer(cq.id, { text: 'Expired' });
      await reply('👥 That wizard has expired — the receipts are saved, just without staff tags. You can set them from the dashboard.');
      return;
    }
    const idx = Number(data.slice(7));
    const staffEntry = wizard.staff[idx];
    if (!staffEntry) { await answer(cq.id, { text: 'Invalid option' }); return; }
    const it = wizard.items[wizard.idx];
    try {
      await update('expenses', { id: it.id }, { staff_user_id: staffEntry.id, status: it.priorStatus || 'saved' });
      lastStaffByChat.set(chatId, staffEntry.id);
      wizard.lastId = staffEntry.id;
      await answer(cq.id, { text: 'Tagged' });
    } catch (e) {
      console.error('[batch wizard pick]', e && e.message);
      await answer(cq.id, { text: 'Save failed' });
    }
    wizard.idx += 1;
    await wizardRenderOrFinish(wizard, deps);
    return;
  }
  // "👥 Same for all remaining": stamps the LAST-picked person (the ⭐ one) to every
  // remaining item, including the current one — the all-one-person-mid-batch case. A no-op
  // (asks for one manual pick first) if nobody has been picked yet this wizard — there is
  // no "same as" without a first pick to be the same as.
  if (data === 'bwall') {
    const wizard = pendingBatchWizard.get(chatId);
    if (!wizard) {
      await answer(cq.id, { text: 'Expired' });
      await reply('👥 That wizard has expired — the receipts are saved, just without staff tags. You can set them from the dashboard.');
      return;
    }
    const staffEntry = wizard.lastId && wizard.staff.find(s => s.id === wizard.lastId);
    if (!staffEntry) {
      await answer(cq.id, { text: 'Pick someone first' });
      return;
    }
    try {
      for (const it of wizard.items.slice(wizard.idx)) {
        await update('expenses', { id: it.id }, { staff_user_id: staffEntry.id, status: it.priorStatus || 'saved' });
      }
      await answer(cq.id, { text: 'Tagged all' });
    } catch (e) {
      console.error('[batch wizard all]', e && e.message);
      await answer(cq.id, { text: 'Save failed' });
    }
    wizard.idx = wizard.items.length;
    await wizardRenderOrFinish(wizard, deps);
    return;
  }
  // "⏭ Skip": leaves this one item unassigned (still awaiting_staff, fixable on the
  // dashboard) and moves to the next — never blocks the rest of the wizard.
  if (data === 'bwskip') {
    const wizard = pendingBatchWizard.get(chatId);
    if (!wizard) {
      await answer(cq.id, { text: 'Expired' });
      await reply('👥 That wizard has expired — the receipts are saved, just without staff tags. You can set them from the dashboard.');
      return;
    }
    await answer(cq.id, { text: 'Skipped' });
    wizard.idx += 1;
    await wizardRenderOrFinish(wizard, deps);
    return;
  }
  // Staff Lock Mode: pick a staff member to lock all subsequent uploads to.
  if (data.indexOf('slock:') === 0) {
    const pending = pendingStaffLockPicks.get(chatId);
    if (!pending) {
      await answer(cq.id, { text: 'Expired' });
      await reply('👤 That staff lock picker has expired. Tap *👤 Staff Lock* again.');
      return;
    }
    const idx = Number(data.slice(6));
    const staffEntry = pending.staff[idx];
    if (!staffEntry) { await answer(cq.id, { text: 'Invalid' }); return; }
    staffLockByChat.set(chatId, { staffId: staffEntry.id, staffName: staffEntry.name, branchId: pending.branchId });
    lastStaffByChat.set(chatId, staffEntry.id);
    pendingStaffLockPicks.delete(chatId);
    await answer(cq.id, { text: 'Locked' });
    await reply('🔒 *Staff Lock ON*\n\n👤 All receipts → *' + staffEntry.name + '*\n\nUpload receipts now. Tap *✅ Done* when finished.');
    await send(chatId, '📸 _Ready — send receipt photos._', businessMenuKeyboard({ staffName: staffEntry.name }));
    return;
  }
  // Staff Lock: Done button on a locked receipt summary — ends the lock.
  if (data === 'slockdone') {
    staffLockByChat.delete(chatId);
    await answer(cq.id, { text: 'Unlocked' });
    await reply('🔓 *Staff Lock OFF* — back to normal mode.\n\nFuture receipts will ask for staff selection again.');
    await send(chatId, '👤 _Staff Lock cleared._', businessMenuKeyboard(null));
    return;
  }
  // Issue #162 D13: "View" on a duplicate-rejected reply — shows the EXISTING receipt's
  // own details (read-only). Same ownership check as every other tap in this handler.
  if (data.indexOf('dupview:') === 0) {
    const id = data.slice(8);
    try {
      const rows = await selectGlobal('expenses', { eq: { id } });
      const row = rows[0];
      if (!row || row.deleted_at) {
        await answer(cq.id, { text: 'Already gone' });
        await send(chatId, '🗑️ That receipt is already gone.');
        return;
      }
      if (String(row.rep_chat_id) !== String(chatId)) {
        await answer(cq.id, { text: 'Not yours' });
        await send(chatId, '⚠️ Can\'t view that from here.');
        return;
      }
      await answer(cq.id);
      await send(chatId, '🏪 *' + (row.merchant || 'Unknown') + '*\n💰 ' + fmtMoney(row.amount, row.currency)
        + (row.expense_date ? '\n📅 ' + row.expense_date : '') + '\n📂 ' + (row.category || 'Others'));
    } catch (e) {
      console.error('[dupview]', e.message);
      await answer(cq.id);
      await send(chatId, '⚠️ Couldn\'t load that receipt. Please check your dashboard.');
    }
    return;
  }
  // "Edit" on a duplicate-rejected reply: a small menu — edit staff, or delete the
  // EXISTING receipt. Delete reuses the already-built delask: flow (no parallel
  // implementation) — the button below is just 'delask:<id>'.
  if (data.indexOf('dupedit:') === 0) {
    const id = data.slice(8);
    try {
      const rows = await selectGlobal('expenses', { eq: { id } });
      const row = rows[0];
      if (!row || row.deleted_at) {
        await answer(cq.id, { text: 'Already gone' });
        await send(chatId, '🗑️ That receipt is already gone.');
        return;
      }
      if (String(row.rep_chat_id) !== String(chatId)) {
        await answer(cq.id, { text: 'Not yours' });
        await send(chatId, '⚠️ Can\'t edit that from here.');
        return;
      }
      await answer(cq.id);
      const kb = { inline_keyboard: [[
        { text: '👤 Edit staff', callback_data: 'dupstaff:' + id },
        { text: '🗑️ Delete', callback_data: 'dupdel:' + id },
      ]] };
      await send(chatId, '🏪 *' + (row.merchant || 'Unknown') + '*\n💰 ' + fmtMoney(row.amount, row.currency)
        + '\n\nWhat would you like to do?', kb);
    } catch (e) {
      console.error('[dupedit]', e.message);
      await answer(cq.id);
      await send(chatId, '⚠️ Couldn\'t open that right now. Please try again from your dashboard.');
    }
    return;
  }
  // "🗑️ Delete" from the dupedit menu (Owner request 2026-07-11): the menu message turns
  // INTO the Yes/Cancel confirm in place — one message walks menu -> confirm -> deleted
  // (the final step already edits in place via del:'s own `reply`, since it re-uses this
  // SAME message_id once dupdel: has edited it). Deliberately a SEPARATE callback prefix
  // from delask: (used by the Today's Bills LIST): editing that list message in place would
  // wipe out every OTHER bill's own delete button, which is why delask: still opens a fresh
  // message instead. Same ownership/already-deleted checks as delask:, just edit vs send.
  if (data.indexOf('dupdel:') === 0) {
    const id = data.slice(7);
    try {
      const rows = await selectGlobal('expenses', { eq: { id } });
      const row = rows[0];
      if (!row || row.deleted_at) {
        await answer(cq.id, { text: 'Already gone' });
        await (messageId ? edit(chatId, messageId, '🗑️ That receipt is already gone.') : send(chatId, '🗑️ That receipt is already gone.'));
        return;
      }
      if (String(row.rep_chat_id) !== String(chatId)) {
        await answer(cq.id, { text: 'Not yours' });
        await (messageId ? edit(chatId, messageId, '⚠️ Can\'t delete that one from here.') : send(chatId, '⚠️ Can\'t delete that one from here.'));
        return;
      }
      await answer(cq.id);
      const keyboard = { inline_keyboard: [[
        { text: '✅ Yes, delete it', callback_data: 'del:' + row.id },
        { text: '✋ Cancel', callback_data: 'del:cancel' },
      ]] };
      const text = '🗑️ Delete this bill?\n\n🏪 *' + (row.merchant || 'Unknown') + '*\n💰 ' + fmtMoney(row.amount, row.currency);
      if (messageId) await edit(chatId, messageId, text, keyboard);
      else await send(chatId, text, keyboard);
    } catch (e) {
      console.error('[dupdel]', e.message);
      await answer(cq.id);
      await (messageId ? edit(chatId, messageId, '⚠️ Couldn\'t open that right now. Please try again from your dashboard.')
        : send(chatId, '⚠️ Couldn\'t open that right now. Please try again from your dashboard.'));
    }
    return;
  }
  // "👤 Edit staff" from the duplicate-edit menu: re-opens the SAME staff picker
  // (sendStaffPicker) keyed to the EXISTING receipt's own branch — one tested
  // implementation, not a parallel one.
  if (data.indexOf('dupstaff:') === 0) {
    const id = data.slice(9);
    try {
      const rows = await selectGlobal('expenses', { eq: { id } });
      const row = rows[0];
      if (!row || row.deleted_at) {
        await answer(cq.id, { text: 'Already gone' });
        await send(chatId, '🗑️ That receipt is already gone.');
        return;
      }
      if (String(row.rep_chat_id) !== String(chatId)) {
        await answer(cq.id, { text: 'Not yours' });
        await send(chatId, '⚠️ Can\'t edit that from here.');
        return;
      }
      if (!row.branch_id) {
        await answer(cq.id, { text: 'No branch' });
        await send(chatId, '⚠️ No branch on this receipt — set the staff from your dashboard.');
        return;
      }
      // sendStaffPicker silently no-ops on an empty staff directory — correct for its
      // AUTOMATIC post-save call (no spam on every receipt for a branch that hasn't set
      // up staff yet), but this is an EXPLICIT button tap, so silence reads as broken
      // (Owner-reported, live QA 2026-07-10). Check first and say why, here only.
      const staffList = await (deps.listStaff || listStaff)(row.branch_id);
      if (!Array.isArray(staffList) || !staffList.length) {
        await answer(cq.id, { text: 'No staff yet' });
        await send(chatId, '👤 No staff added yet for this branch. Add staff names from the dashboard\'s Team tab first.');
        return;
      }
      await answer(cq.id);
      await (deps.sendStaffPicker || sendStaffPicker)(chatId, row, row.branch_id, deps);
    } catch (e) {
      console.error('[dupstaff]', e.message);
      await answer(cq.id);
      await send(chatId, '⚠️ Couldn\'t open the staff picker. Please try again from your dashboard.');
    }
    return;
  }
  if (data.indexOf('del:') === 0) {
    const id = data.slice(4);
    try {
      const rows = await selectGlobal('expenses', { eq: { id } });
      const row = rows[0];
      if (!row || row.deleted_at) {
        await answer(cq.id, { text: 'Already gone' });
        await reply('🗑️ That receipt is already deleted.');
        return;
      }
      if (String(row.rep_chat_id) !== String(chatId)) {
        await answer(cq.id, { text: 'Not yours' });
        await reply('⚠️ Can\'t delete that one from here.');
        return;
      }
      await softDelete('expenses', { id, scope: { account_id: row.account_id } });
      await answer(cq.id, { text: 'Deleted' });
      await reply('🗑️ Deleted: *' + (row.merchant || 'Unknown') + '* — ' + fmtMoney(row.amount, row.currency));
    } catch (e) {
      console.error('[delete confirm]', e.message);
      await answer(cq.id);
      await reply('⚠️ Couldn\'t delete that receipt. Please try again from your dashboard.');
    }
    return;
  }
  // Category-picker button tap (Owner request 2026-07-03). Re-checks ownership + that
  // the row is STILL awaiting a pick at CONFIRM time (mirrors the delete flow's
  // re-authorization pattern) — a stale/double-tapped button is refused gracefully,
  // never double-applied. 'catpick:<id>:<index>' picks a real category by its index
  // into the account's effective category list (specCategories: FieldSpec.categories
  // when the business defines one, else the built-in default); 'catpick:<id>:others'
  // instead asks for a typed remark (resolved by handleUpdate's pending-remark check,
  // not here — this only flips the row's status).
  if (data.indexOf('catpick:') === 0) {
    const parts = data.split(':'); // ['catpick', id, selector] — a UUID id never contains ':'
    const id = parts[1];
    const selector = parts[2];
    try {
      const rows = await selectGlobal('expenses', { eq: { id } });
      const row = rows[0];
      if (!row || row.deleted_at) {
        await answer(cq.id, { text: 'Already gone' });
        await send(chatId, '🗑️ That receipt is already gone.');
        return;
      }
      if (String(row.rep_chat_id) !== String(chatId)) {
        await answer(cq.id, { text: 'Not yours' });
        await send(chatId, '⚠️ Can\'t do that from here.');
        return;
      }
      if (row.status !== 'awaiting_category') {
        await answer(cq.id, { text: 'Already set' });
        await send(chatId, '✅ That receipt\'s category was already resolved.');
        return;
      }
      if (selector === 'others') {
        await update('expenses', { id, scope: { account_id: row.account_id } }, { category: 'Others', status: 'awaiting_remark' });
        await answer(cq.id);
        // Owner request 2026-07-04: edit the SAME message in place (buttons removed by
        // tgEditMessage) rather than send a new one, so the chat doesn't accumulate stale
        // button messages. Remember which message to edit again once the remark arrives
        // (tryResolveRemark) — best-effort (see pendingRemarkMessages above); falls back
        // to a fresh message if messageId is unavailable for any reason.
        const prompt = '📝 *Please type a short note describing this expense* (e.g. what it was for).';
        if (messageId) { await edit(chatId, messageId, prompt); pending.set(id, { chatId, messageId }); }
        else await send(chatId, prompt);
        return;
      }
      // ADR-021 Phase 5: resolve the index against the account's CURRENT category list
      // (the same list buildCategoryKeyboard rendered from — FieldSpec.categories when
      // the business defines its own chart of accounts, else the built-in default).
      // Known window: a template re-import BETWEEN prompt and tap could reorder the
      // list and mis-resolve; that's an admin editing the taxonomy mid-tap — accepted,
      // same exposure the static list had to a code deploy, and the row stays editable.
      const idx = Number(selector);
      const catList = specCategories(await (deps.getFieldSpec || getFieldSpec)().catch(() => null));
      const category = Number.isInteger(idx) ? catList[idx] : null;
      if (!category || category === 'Others') {
        await answer(cq.id, { text: 'Invalid option' });
        await send(chatId, '⚠️ That option isn\'t valid anymore — please try again.');
        return;
      }
      await update('expenses', { id, scope: { account_id: row.account_id } }, { category, status: 'saved' });
      await answer(cq.id, { text: 'Saved' });
      // 2026-08-23 (Barat reference mockup): a category pick — whether the FIRST resolution
      // of an uncertain receipt, or a re-pick via "✏️ Edit" -> Category — now re-renders the
      // full "Expense Captured" card (same helper expenseFromPhoto's initial send uses),
      // not a terse "Saved as X" line. Lets the user see every field at a glance right after
      // picking, and matches every other card-edit path's "the card re-renders in place"
      // behavior — no separate short-confirmation code path to keep in sync with it.
      const updated = { ...row, category, status: 'saved' };
      const cardText = captureCardText(updated);
      const kb = captureCardKeyboard(id);
      if (messageId) await edit(chatId, messageId, cardText, kb);
      else await send(chatId, cardText, kb);
    } catch (e) {
      console.error('[catpick]', e.message);
      await answer(cq.id);
      await send(chatId, '⚠️ Couldn\'t save that category. Please try again from your dashboard.');
    }
    return;
  }
  // "✏️ Edit category" tap on an already-saved "Expense Captured" message (Owner request
  // 2026-07-04). Re-checks ownership (never another chat's receipt). Deliberately does NOT
  // require any particular prior status — resets it to 'awaiting_category' so the EXISTING
  // catpick: branch above handles the actual re-pick (one tested implementation, not a
  // parallel one). Side effect, documented: this clears any prior 'needs_review' anomaly
  // status until the re-pick completes — acceptable, a rare edge case, not data loss (the
  // anomaly reasons themselves stay on `expense.anomaly`, only `status` is touched).
  if (data.indexOf('catedit:') === 0) {
    const id = data.slice(8);
    try {
      const rows = await selectGlobal('expenses', { eq: { id } });
      const row = rows[0];
      if (!row || row.deleted_at) {
        await answer(cq.id, { text: 'Already gone' });
        await send(chatId, '🗑️ That receipt is already gone.');
        return;
      }
      if (String(row.rep_chat_id) !== String(chatId)) {
        await answer(cq.id, { text: 'Not yours' });
        await send(chatId, '⚠️ Can\'t do that from here.');
        return;
      }
      await update('expenses', { id, scope: { account_id: row.account_id } }, { status: 'awaiting_category' });
      await answer(cq.id);
      const prompt = categoryPromptText(row);
      // Same account-current list the catpick resolver reads (ADR-021) — buttons and
      // resolution always index the same array.
      const kb = buildCategoryKeyboard(id, specCategories(await (deps.getFieldSpec || getFieldSpec)().catch(() => null)));
      if (messageId) await edit(chatId, messageId, prompt, kb);
      else await send(chatId, prompt, kb);
    } catch (e) {
      console.error('[catedit]', e.message);
      await answer(cq.id);
      await send(chatId, '⚠️ Couldn\'t open the category picker. Please try again from your dashboard.');
    }
    return;
  }
  // "✏️ Edit" tap on an "Expense Captured" card (2026-08-23, Barat reference mockup):
  // opens a field-picker submenu (Merchant/Date/Amount/Category/Back), edited in place —
  // the card message becomes the submenu, not a new one. Category routes straight to the
  // existing catedit: branch above (one tested category-repick implementation); the other
  // three set pendingCardEdit and prompt for a typed reply, resolved by tryResolveCardEdit.
  if (data.indexOf('editmenu:') === 0) {
    const id = data.slice(9);
    try {
      const rows = await selectGlobal('expenses', { eq: { id } });
      const row = rows[0];
      if (!row || row.deleted_at) {
        await answer(cq.id, { text: 'Already gone' });
        await send(chatId, '🗑️ That receipt is already gone.');
        return;
      }
      if (String(row.rep_chat_id) !== String(chatId)) {
        await answer(cq.id, { text: 'Not yours' });
        await send(chatId, '⚠️ Can\'t do that from here.');
        return;
      }
      await answer(cq.id);
      const kb = editFieldMenuKeyboard(id);
      if (messageId) await edit(chatId, messageId, '✏️ *What would you like to edit?*', kb);
      else await send(chatId, '✏️ *What would you like to edit?*', kb);
    } catch (e) {
      console.error('[editmenu]', e.message);
      await answer(cq.id);
      await send(chatId, '⚠️ Couldn\'t open the edit menu. Please try again from your dashboard.');
    }
    return;
  }
  // "‹ Back" from the edit-field submenu: re-renders the untouched card, discarding
  // whatever wasn't picked — clears any stale pendingCardEdit for this chat too (a Back
  // tap after opening e.g. the Amount prompt must not leave a dangling "waiting for a
  // typed reply" state that then wrongly consumes the user's NEXT unrelated message).
  if (data.indexOf('editback:') === 0) {
    const id = data.slice(9);
    pendingCard.delete(String(chatId));
    try {
      const rows = await selectGlobal('expenses', { eq: { id } });
      const row = rows[0];
      if (!row || row.deleted_at) {
        await answer(cq.id, { text: 'Already gone' });
        await send(chatId, '🗑️ That receipt is already gone.');
        return;
      }
      await answer(cq.id);
      const text = captureCardText(row);
      const kb = captureCardKeyboard(id);
      if (messageId) await edit(chatId, messageId, text, kb);
      else await send(chatId, text, kb);
    } catch (e) {
      console.error('[editback]', e.message);
      await answer(cq.id);
    }
    return;
  }
  // Merchant/Date/Amount field-edit prompts. 'editfield:<field>:<id>' — a UUID id never
  // contains ':', mirroring catpick:'s own parts[] convention.
  if (data.indexOf('editfield:') === 0) {
    const parts = data.split(':'); // ['editfield', field, id]
    const field = parts[1];
    const id = parts[2];
    try {
      const rows = await selectGlobal('expenses', { eq: { id } });
      const row = rows[0];
      if (!row || row.deleted_at) {
        await answer(cq.id, { text: 'Already gone' });
        await send(chatId, '🗑️ That receipt is already gone.');
        return;
      }
      if (String(row.rep_chat_id) !== String(chatId)) {
        await answer(cq.id, { text: 'Not yours' });
        await send(chatId, '⚠️ Can\'t do that from here.');
        return;
      }
      const prompts = {
        merchant: '🏪 *Please type the correct merchant name.*',
        date: '📅 *Please type the correct date* (DD/MM/YYYY, e.g. 30/06/2026).',
        amount: '💰 *Please type the correct amount* (numbers only, e.g. 12.50).',
      };
      const prompt = prompts[field];
      if (!prompt) { await answer(cq.id, { text: 'Invalid option' }); return; }
      await answer(cq.id);
      pendingCard.set(String(chatId), { expenseId: id, field, messageId });
      if (messageId) await edit(chatId, messageId, prompt);
      else await send(chatId, prompt);
    } catch (e) {
      console.error('[editfield]', e.message);
      await answer(cq.id);
      await send(chatId, '⚠️ Couldn\'t open that right now. Please try again from your dashboard.');
    }
    return;
  }
  // "📝 Add Remark" — available on every "Expense Captured" card, not just when the
  // category is "Others" (that existing awaiting_remark/tryResolveRemark flow is
  // untouched — a SEPARATE, DB-status-based mechanism this doesn't interact with).
  if (data.indexOf('addremark:') === 0) {
    const id = data.slice(10);
    try {
      const rows = await selectGlobal('expenses', { eq: { id } });
      const row = rows[0];
      if (!row || row.deleted_at) {
        await answer(cq.id, { text: 'Already gone' });
        await send(chatId, '🗑️ That receipt is already gone.');
        return;
      }
      if (String(row.rep_chat_id) !== String(chatId)) {
        await answer(cq.id, { text: 'Not yours' });
        await send(chatId, '⚠️ Can\'t do that from here.');
        return;
      }
      await answer(cq.id);
      pendingCard.set(String(chatId), { expenseId: id, field: 'remark', messageId });
      const prompt = '📝 *Please type your remark.*';
      if (messageId) await edit(chatId, messageId, prompt);
      else await send(chatId, prompt);
    } catch (e) {
      console.error('[addremark]', e.message);
      await answer(cq.id);
      await send(chatId, '⚠️ Couldn\'t open that right now. Please try again from your dashboard.');
    }
    return;
  }
  // "❌ #N" tap from the "📋 Today Bills" list (Owner request 2026-07-04). Ownership is
  // checked HERE (before showing any confirm prompt — immediate, honest feedback if this
  // isn't your bill) AND again inside the existing `del:<id>` flow at final confirm time
  // (defense in depth, same pattern used throughout this file). Deliberately scoped to the
  // ORIGINAL submitter only, even though the Today Bills LIST itself is account-wide —
  // Owner's explicit choice, matches how "type delete" already behaves.
  if (data.indexOf('delask:') === 0) {
    const id = data.slice(7);
    try {
      const rows = await selectGlobal('expenses', { eq: { id } });
      const row = rows[0];
      if (!row || row.deleted_at) {
        await answer(cq.id, { text: 'Already gone' });
        await send(chatId, '🗑️ That bill is already gone.');
        return;
      }
      if (String(row.rep_chat_id) !== String(chatId)) {
        await answer(cq.id, { text: 'Not yours' });
        await send(chatId, '⚠️ Only the person who submitted that bill can delete it.');
        return;
      }
      await answer(cq.id);
      const keyboard = { inline_keyboard: [[
        { text: '✅ Yes, delete it', callback_data: 'del:' + row.id },
        { text: '✋ Cancel', callback_data: 'del:cancel' },
      ]] };
      await send(chatId,
        '🗑️ Delete this bill?\n\n🏪 *' + (row.merchant || 'Unknown') + '*\n💰 ' + fmtMoney(row.amount, row.currency),
        keyboard);
    } catch (e) {
      console.error('[delask]', e.message);
      await answer(cq.id);
      await send(chatId, '⚠️ Couldn\'t open that right now. Please try again from your dashboard.');
    }
    return;
  }
  // Business "🗑️ Delete a bill" tap (M2 #107): arm this chat to accept a typed bill
  // number next. The ordered id list was pinned when the Today's Bills list was sent
  // (pendingBillDelete). The actual delete happens in tryResolveBillDelete when the
  // number arrives, re-checking ownership there — nothing is deleted on this tap.
  // delnum:next (tapped after a delete round completes) re-arms exactly like delnum:ask,
  // just without resetting the running `deleted` session total (QA: "Next should prompt
  // for the next bill number" — same list, same session, just another round).
  if (data === 'delnum:ask' || data === 'delnum:next') {
    const delPending = deps.pendingBillDelete || pendingBillDelete;
    const entry = delPending.get(String(chatId));
    if (!entry || !entry.ids.length) {
      await answer(cq.id, { text: 'Expired' });
      await send(chatId, '📋 That list expired — tap *📋 Today Bills* again, then Delete.');
      return;
    }
    entry.armed = true;
    await answer(cq.id);
    await send(chatId, '🗑️ Which bill? Reply with its *number* (1–' + entry.ids.length + '), or a list like 1, 2, 4 to delete several at once.');
    return;
  }

  // delnum:done (QA: "Done should conclude the process and display a summary of the
  // deleted items") — shows everything deleted across this Today's Bills session, then
  // clears the pending entry so a stray later number can't delete anything without a
  // fresh 📋 Today Bills tap.
  if (data === 'delnum:done') {
    const delPending = deps.pendingBillDelete || pendingBillDelete;
    const entry = delPending.get(String(chatId));
    await answer(cq.id);
    const deletedList = (entry && entry.deleted) || [];
    if (!deletedList.length) {
      await send(chatId, '🗑️ No bills were deleted this round.');
    } else {
      const lines = deletedList.map((d, i) => (i + 1) + '. *' + (d.merchant || 'Unknown') + '* — ' + fmtMoney(d.amount, d.currency)).join('\n');
      await send(chatId, '✅ *Done — ' + deletedList.length + ' bill' + (deletedList.length === 1 ? '' : 's') + ' deleted*\n\n' + lines);
    }
    delPending.delete(String(chatId));
    return;
  }
  await answer(cq.id); // unrecognised callback data — just clear the spinner
}

// 2026-08-19 SECURITY FIX: `binding` used to be entirely absent from this function (and
// unpassed at its call site) — see branchEq's matching doc comment for the full story. Same
// fix, same reasoning: fold the chat's own real account_id into the query instead of always
// falling through to sbSelect's cfg.ACCOUNT_ID default.
// 2026-08-21 BUG FIX: this used to have NO deleted_at or status filter at all — every sibling
// summary function (handleTodayBills/handleTodayExpenses/handleWeeklyRecord below) already
// excludes soft-deleted rows via deleted_at=is.null, but this one never did. Confirmed live: a
// bot chat typing "show expenses" got back 3 real receipts PLUS 4 old soft-deleted test rows
// still sitting in the DB — RM237.19 instead of the real RM201.65. status=neq.rejected added
// too, matching lib/agent.js's loadExpenses() (the equivalent query behind Falc's own summary
// tools) — a rejected receipt shouldn't count here either, same reasoning. guestVisibilityExtra
// added for the same reason every sibling function here has it: without it, a guest's summary
// could leak the real account's rows (or vice versa).
async function sendExpenseSummary(chatId, deps = {}, binding = null) {
  const select = deps.sbSelect || sbSelect;
  const send = deps.tgSend || tgSend; // matches handleTodayBills/handleTodayExpenses/handleWeeklyRecord's own override pattern
  try {
    const rows = await select('expenses', {
      eq: branchEq(binding),
      extra: mergeExtra('deleted_at=is.null&status=neq.rejected', binding ? guestVisibilityExtra(binding) : null),
      order: 'created_at.desc', limit: 10,
    });
    if (!rows.length) { await send(chatId, '📭 No expenses logged yet. Send me a receipt photo to get started!'); return; }
    const cur = rows[0].currency || cfg.DEFAULT_CURRENCY;
    const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const lines = rows.slice(0, 8).map(r => '• *' + (r.merchant || 'Unknown') + '* — ' + fmtMoney(r.amount, r.currency || cur) + '  _(' + r.category + ')_').join('\n');
    await send(chatId, '🧾 *Recent Expenses*\n\n' + lines + '\n\n💰 *Last 10 total:* ' + fmtMoney(total, cur));
  } catch (e) { console.error('[summary]', e.message); await send(chatId, '⚠️ Could not load expenses right now.'); }
}

// "📋 Today Bills" menu button (Owner request 2026-07-04): every non-deleted receipt
// CAPTURED today (Malaysia time — filtered by `created_at`, the actual insert timestamp,
// NOT `expense_date`, the date printed on the receipt itself — fixed 2026-07-04 after live
// QA: a receipt photographed today but dated weeks earlier was invisible under the old
// expense_date filter even though it genuinely was captured today). Account-wide (not
// scoped to this chat — matches sendExpenseSummary's existing account-wide behavior). Each
// bill gets its own "❌" delete-ask button (handleCallbackQuery's `delask:` branch); tapping
// it re-checks ownership BEFORE showing the confirm prompt, and confirming reuses the
// existing, already-tested `del:<id>` flow — deletion stays scoped to the ORIGINAL
// submitter only (Owner's explicit choice), even though the list itself shows everyone's bills.
// `binding` (optional, business only, M2 #107): a bound CLERK's list is hard-scoped to
// their own branch; a bound ADMIN still sees every branch (reads span all branches per
// ADR-021 — only their CAPTURES tag to Head Office). null in personal mode (unchanged).
//
// 2026-08-19 SECURITY FIX: this used to return ONLY the clerk branch_id filter, with no
// account_id at all — every caller (sendExpenseSummary/handleTodayBills/handleTodayExpenses/
// handleWeeklyRecord) then fell through to sbSelect's own default (account_id: cfg.ACCOUNT_ID)
// regardless of which account this chat is actually bound to. Business mode never noticed
// (one shared cfg.ACCOUNT_ID per deployment, per ADR-021's managed-silo model), but a
// PERSONAL owner whose own account_id differs from cfg.ACCOUNT_ID (any signup since the
// 2026-08-14 fix — see lib/auth.js accountIdFor()) would see a DIFFERENT account's merchant
// names/amounts in "Today Bills"/"Today Expenses"/"Weekly Record"/free-text summary replies —
// the exact same class of cross-account leak the 2026-08-14 fix closed on the WRITE side
// (bindingMeta below already stamps account_id on every capture; reads never matched it).
// Every `binding` row (business or personal) already carries its own real account_id
// (bot_bindings.account_id), so folding it in here is a straight port of that same fix to
// the READ side — safe for business mode too (still resolves to the one shared account).
function branchEq(binding) {
  const eq = (binding && binding.role === 'clerk' && binding.branch_id) ? { branch_id: binding.branch_id } : {};
  if (binding && binding.account_id) eq.account_id = binding.account_id;
  return eq;
}

// bindingMeta(binding) -> { branch_id?, company_id? } for the WRITE path (expenseFromPhoto /
// handlePdfDocument / batch meta): a bound chat's captures are stamped with its branch AND
// company (a branch lives inside one company). Each key is included only when the binding
// carries it, so a company-less binding stays branch-only and an unbound/personal chat
// gets {} (no attribution). NOTE: this is capture attribution — it applies to admins too
// (unlike branchEq, which is a clerk-only READ filter).
function bindingMeta(binding) {
  if (!binding) return {};
  const meta = {};
  if (binding.branch_id) meta.branch_id = binding.branch_id;
  if (binding.company_id) meta.company_id = binding.company_id;
  // Guest Mode (2026-07-28): a guest binding's captures are tagged with the guest's own
  // user_id so the 4-receipt cap (lib/ocr.js assembleExpense) and the guestVisibilityExtra
  // read-filter (lib/auth.js) can find them. Only ever set for role==='guest' — real
  // owner/admin/clerk bindings never carry this.
  if (binding.role === 'guest') meta.owner_user_id = binding.user_id;
  // 2026-08-14 SECURITY FIX: without this, EVERY bot capture (regardless of which per-account
  // owner sent it) inserted under the single shared default account_id instead of the
  // capturing user's own — see lib/ocr.js assembleExpense's matching doc comment.
  if (binding.account_id) meta.account_id = binding.account_id;
  return meta;
}

async function handleTodayBills(chatId, deps = {}, binding = null) {
  const send = deps.tgSend || tgSend;
  const select = deps.sbSelect || sbSelect;
  const today = (deps.todayISO || todayISO_MYT)();
  const { startUTC, endUTC } = (deps.dayBounds || mytDayBoundsUTC)();
  try {
    const rows = await select('expenses', {
      eq: branchEq(binding),
      // Guest Mode (2026-07-28): guestVisibilityExtra(binding) is a safe no-op (always
      // 'owner_user_id=is.null') whenever guestMode has never inserted a tagged row, so this
      // is unconditional rather than gated behind caps.guestMode.
      extra: mergeExtra('deleted_at=is.null&created_at=gte.' + encodeURIComponent(startUTC) + '&created_at=lt.' + encodeURIComponent(endUTC), binding ? guestVisibilityExtra(binding) : null),
      order: 'created_at.desc',
    });
    if (!rows.length) { await send(chatId, '📋 *Today\'s Bills* (' + today + ')\n\nNothing captured yet today.'); return; }
    const cur = rows[0].currency || cfg.DEFAULT_CURRENCY;
    const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);

    // Business mode (a bound chat, M2 #107): two Owner-requested changes vs personal —
    // (1) each line shows the STAFF member who handed the bill over (staff_user_id ->
    // display_name) instead of the category; (2) the per-bill ❌ buttons are replaced by
    // ONE "🗑️ Delete a bill" button that asks the user to type the bill number (the
    // delnum:ask callback + tryResolveBillDelete resolver). Personal mode (binding null)
    // falls through to the original rendering below, byte-for-byte unchanged.
    if (binding) {
      const pending = deps.pendingBillDelete || pendingBillDelete;
      const staffNames = {};
      try {
        const users = await select('users', { eq: branchEq(binding) });
        for (const u of users) staffNames[u.id] = u.display_name || u.username || '';
      } catch (e) { console.error('[today-bills staff]', e && e.message); } // names are best-effort
      let btext = '📋 *Today\'s Bills* (' + today + ')\n\n';
      rows.forEach((r, i) => {
        const who = (r.staff_user_id && staffNames[r.staff_user_id]) || 'Unassigned';
        btext += (i + 1) + '. *' + (r.merchant || 'Unknown') + '* — ' + fmtMoney(r.amount, r.currency || cur) + '  _(' + who + ')_\n';
      });
      btext += '\n💰 *Total:* ' + fmtMoney(total, cur) + '\n\n_Tap 🗑️ Delete a bill, then reply with the bill number to remove one of yours._';
      pending.set(String(chatId), { ids: rows.map((r) => r.id), armed: false });
      await send(chatId, btext, { inline_keyboard: [[{ text: '🗑️ Delete a bill', callback_data: 'delnum:ask' }]] });
      return;
    }

    let text = '📋 *Today\'s Bills* (' + today + ')\n\n';
    rows.forEach((r, i) => {
      text += (i + 1) + '. *' + (r.merchant || 'Unknown') + '* — ' + fmtMoney(r.amount, r.currency || cur) + '  _(' + r.category + ')_\n';
    });
    text += '\n💰 *Total:* ' + fmtMoney(total, cur) + '\n\n_Tap ❌ below to remove one of yours._';
    const kbRows = [];
    for (let i = 0; i < rows.length; i += 3) {
      kbRows.push(rows.slice(i, i + 3).map((r, j) => ({ text: '❌ #' + (i + j + 1), callback_data: 'delask:' + r.id })));
    }
    await send(chatId, text, { inline_keyboard: kbRows });
  } catch (e) { console.error('[today-bills]', e.message); await send(chatId, '⚠️ Could not load today\'s bills right now.'); }
}

// "💰 Today Expenses" menu button — just the total. 2026-07-23 (Owner/Barat request):
// filters by `expense_date` (the date PRINTED on the receipt) so this total matches the
// dashboard's own totals for "today". Deliberately different from Today Bills, which stays
// on `created_at` ("what did I capture today") per the 2026-07-04 fix above — the two
// buttons now answer different questions on purpose.
async function handleTodayExpenses(chatId, deps = {}, binding = null) {
  const send = deps.tgSend || tgSend;
  const select = deps.sbSelect || sbSelect;
  const today = (deps.todayISO || todayISO_MYT)();
  try {
    const rows = await select('expenses', {
      eq: branchEq(binding),
      extra: mergeExtra('deleted_at=is.null&expense_date=eq.' + encodeURIComponent(today), binding ? guestVisibilityExtra(binding) : null),
    });
    const cur = (rows[0] && rows[0].currency) || cfg.DEFAULT_CURRENCY;
    const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    // 2026-07-20 (owner-requested reversal): the acc8146 "resend on every reply" nudge below
    // was removed — is_persistent:true (see MAIN_MENU_KEYBOARD) already keeps PC/Web clients
    // from collapsing the bar to an icon; resending it here on every reply was ALSO forcing
    // it back open any time a user manually collapsed it, which is what was actually reported
    // this time. /start and any genuine keyboard-shape change (Staff Lock on/off) still resend.
    await send(chatId, '💰 *Today\'s Expenses* (' + today + ')\n\n' + plural(rows.length, 'bill') + ' · *' + fmtMoney(total, cur) + '*');
  } catch (e) { console.error('[today-expenses]', e.message); await send(chatId, '⚠️ Could not load today\'s total right now.'); }
}

// "📅 Weekly Record" menu button — this week's total. 2026-07-23 (Owner/Barat request):
// filters by `expense_date` (the date PRINTED on the receipt), matching the dashboard's
// own period totals. Deliberately different from Today Bills, which stays on `created_at`
// ("what did I capture today") per the 2026-07-04 fix above. Business weeks start on
// SUNDAY (design doc: "weekly = Sun-Sat"); personal weeks keep their existing Monday
// start. Bound business chats (both roles) get the Sunday week; a bound clerk's total is
// additionally branch-scoped (branchEq above).
async function handleWeeklyRecord(chatId, deps = {}, binding = null) {
  const send = deps.tgSend || tgSend;
  const select = deps.sbSelect || sbSelect;
  const today = (deps.todayISO || todayISO_MYT)();
  const weekStart = binding
    ? (deps.weekStartSundayISO || weekStartSundayISO_MYT)()
    : (deps.weekStartISO || weekStartISO_MYT)();
  try {
    const rows = await select('expenses', { eq: branchEq(binding), extra: mergeExtra('deleted_at=is.null&expense_date=gte.' + encodeURIComponent(weekStart), binding ? guestVisibilityExtra(binding) : null) });
    const cur = (rows[0] && rows[0].currency) || cfg.DEFAULT_CURRENCY;
    const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    // 2026-07-20: no longer re-attaches the menu keyboard — see handleTodayExpenses' comment.
    await send(chatId, '📅 *Weekly Record* (' + weekStart + ' to ' + today + ')\n\n' + plural(rows.length, 'bill') + ' · *' + fmtMoney(total, cur) + '*');
  } catch (e) { console.error('[weekly-record]', e.message); await send(chatId, '⚠️ Could not load this week\'s total right now.'); }
}

// Resolves a chat's pending "couldn't read the date clearly" state (issue #149 part 2,
// Owner directive: "if the bot can't see something clearly it should say so, not guess").
// Returns true if this text message was consumed as the date reply (caller must stop
// routing it anywhere else); false if nothing was pending. An unparseable reply re-asks
// (still consumed — true — so it isn't swallowed by the generic keyword routing below)
// rather than silently giving up. Same oldest-first v1 simplification as tryResolveRemark.
async function tryResolveDate(chatId, text, deps = {}) {
  const select = deps.sbSelect || sbSelect;
  const update = deps.sbUpdate || sbUpdate;
  const send = deps.tgSend || tgSend;
  const parseDate = deps.parseDateLoose || parseDateLoose;
  try {
    const rows = await select('expenses', { eq: { rep_chat_id: String(chatId), status: 'awaiting_date' }, order: 'created_at.asc', limit: 1 });
    const row = rows[0];
    if (!row) return false;
    const parsed = parseDate(text);
    if (!parsed) {
      await send(chatId, '🤔 That doesn\'t look like a date — please reply in DD/MM/YYYY format, e.g. 30/06/2026.');
      return true; // consumed: still waiting on a valid reply, don't fall through
    }
    await update('expenses', { id: row.id }, { expense_date: parsed, status: 'saved' });
    await send(chatId, '✅ *Date updated*\n\n🏪 *' + (row.merchant || 'Unknown') + '* — ' + fmtMoney(row.amount, row.currency) + '\n📅 ' + parsed);
    return true;
  } catch (e) {
    console.error('[date-ask]', e.message);
    return false; // fall through to normal text handling rather than leaving the user stuck
  }
}

// Resolves a chat's pending "Others -> type a remark" state (Owner request 2026-07-03,
// completes the catpick:...:others flow from handleCallbackQuery). Returns true if this
// text message was consumed as the remark (caller must stop routing it anywhere else);
// false if nothing was pending, so normal text handling (handleUpdate) proceeds as usual.
// Oldest-first (created_at ascending, limit 1) if more than one row is simultaneously
// awaiting a remark for this chat — a deliberate v1 simplification, documented, not a bug.
async function tryResolveRemark(chatId, text, deps = {}) {
  const select = deps.sbSelect || sbSelect;
  const update = deps.sbUpdate || sbUpdate;
  const send = deps.tgSend || tgSend;
  const edit = deps.tgEditMessage || tgEditMessage;
  const pending = deps.pendingRemarkMessages || pendingRemarkMessages;
  try {
    const rows = await select('expenses', { eq: { rep_chat_id: String(chatId), status: 'awaiting_remark' }, order: 'created_at.asc', limit: 1 });
    const row = rows[0];
    if (!row) return false;
    await update('expenses', { id: row.id }, { remark: text, status: 'saved' });
    const confirmText = '✅ *Saved as Others*\n\n🏪 *' + (row.merchant || 'Unknown') + '* — ' + fmtMoney(row.amount, row.currency) + '\n📝 ' + text;
    // Owner request 2026-07-04: finish editing the ORIGINAL picker message (buttons were
    // already cleared when "Others" was tapped) rather than send yet another new message.
    // Falls back to a fresh send if the mapping is missing (e.g. a bot restart in between —
    // see pendingRemarkMessages' comment; the expense row itself is always saved regardless).
    const at = pending.get(row.id);
    if (at) { await edit(at.chatId, at.messageId, confirmText); pending.delete(row.id); }
    else await send(chatId, confirmText);
    return true;
  } catch (e) {
    console.error('[remark]', e.message);
    return false; // fall through to normal text handling rather than leaving the user stuck
  }
}

// Resolves a chat's pending card-edit state (2026-08-23, Barat reference mockup —
// "✏️ Edit" -> pick Merchant/Date/Amount, or "📝 Add Remark" -> type the new value -> the
// SAME "Expense Captured" card re-renders in place with the update, never a new message).
// Returns true if this text message was consumed (caller must stop routing it anywhere
// else); false if nothing was pending. Deliberately SEPARATE from tryResolveDate/
// tryResolveRemark above (DB-status-column-based, untouched) — this only ever touches the
// specific field edited, never the row's own `status`. sbSelectGlobal (not sbSelect) for
// the same reason as every other id-keyed lookup in this file — see handleCallbackQuery's
// doc comment.
async function tryResolveCardEdit(chatId, text, deps = {}) {
  const pending = deps.pendingCardEdit || pendingCardEdit;
  const entry = pending.get(String(chatId));
  if (!entry) return false;
  const selectGlobal = deps.sbSelectGlobal || sbSelectGlobal;
  const update = deps.sbUpdate || sbUpdate;
  const send = deps.tgSend || tgSend;
  const edit = deps.tgEditMessage || tgEditMessage;
  const parseDate = deps.parseDateLoose || parseDateLoose;
  try {
    const rows = await selectGlobal('expenses', { eq: { id: entry.expenseId } });
    const row = rows[0];
    if (!row || row.deleted_at) {
      pending.delete(String(chatId));
      await send(chatId, '🗑️ That receipt is already gone.');
      return true;
    }
    const raw = String(text || '').trim();
    let patch = null;
    if (entry.field === 'merchant') {
      if (!raw) { await send(chatId, '🤔 That doesn\'t look like a name — please type the merchant name.'); return true; }
      patch = { merchant: raw };
    } else if (entry.field === 'date') {
      const parsed = parseDate(raw);
      if (!parsed) { await send(chatId, '🤔 That doesn\'t look like a date — please reply in DD/MM/YYYY format, e.g. 30/06/2026.'); return true; }
      patch = { expense_date: parsed };
    } else if (entry.field === 'amount') {
      const n = Number(raw.replace(/,/g, ''));
      if (!Number.isFinite(n) || n <= 0) { await send(chatId, '🤔 That doesn\'t look like an amount — please type numbers only, e.g. 12.50.'); return true; }
      patch = { amount: Math.round(n * 100) / 100 };
    } else if (entry.field === 'remark') {
      if (!raw) { await send(chatId, '🤔 Please type a short remark.'); return true; }
      patch = { remark: raw };
    } else {
      pending.delete(String(chatId));
      return false; // unknown field — shouldn't happen, don't get stuck consuming messages
    }
    await update('expenses', { id: row.id, scope: { account_id: row.account_id } }, patch);
    pending.delete(String(chatId));
    const updated = { ...row, ...patch };
    const cardText = captureCardText(updated);
    const kb = captureCardKeyboard(row.id);
    if (entry.messageId) await edit(chatId, entry.messageId, cardText, kb);
    else await send(chatId, cardText, kb);
    return true;
  } catch (e) {
    console.error('[card-edit]', e.message);
    pending.delete(String(chatId));
    return false; // fall through to normal text handling rather than leaving the user stuck
  }
}

// Business "type the bill number to delete" flow (M2 #107, business mode only). Consumes
// the NEXT plain message after a bound chat tapped "🗑️ Delete a bill" on its Today's Bills
// list — mirrors tryResolveRemark's "consume the next message while a state is pending"
// pattern. Returns true (message handled, stop routing) only when this chat is ARMED and
// typed an integer; a non-number falls through (returns false) so the user can still tap a
// menu button or type "cancel". Deletion stays scoped to the ORIGINAL submitter (rep_chat_id),
// the same rule the ❌ per-bill flow enforces — a bound admin/clerk can only remove bills
// submitted from THIS chat, even though the list itself shows the whole branch's bills.
// QA issue: a LIST of bill numbers ("1, 2, 4, 8") used to fail the `/^\d+$/` single-number
// check and fall through to the main menu instead of deleting anything. Now accepts a
// comma/space-separated list too — single number stays byte-identical in wording (still
// worded and ordered exactly as before) so existing single-delete behavior doesn't change;
// a genuine list is processed as a batch with a per-item outcome line for each number.
const DELNUM_LIST_RE = /^\d+(?:[\s,]+\d+)*$/;
const NEXT_DONE_KEYBOARD = { inline_keyboard: [[{ text: '➡️ Next', callback_data: 'delnum:next' }, { text: '✅ Done', callback_data: 'delnum:done' }]] };

async function tryResolveBillDelete(chatId, text, deps = {}) {
  const pending = deps.pendingBillDelete || pendingBillDelete;
  const entry = pending.get(String(chatId));
  if (!entry || !entry.armed) return false;                 // not in delete mode — ignore
  const t = String(text).trim();
  if (!DELNUM_LIST_RE.test(t)) return false;                 // not a number/list — let normal routing handle it
  const nums = [...new Set(t.split(/[\s,]+/).filter(Boolean).map(Number))]; // de-dup, keep order
  // Single-use: any typed number(s) consume the arm, whatever the outcome (Jeevan review of
  // #139). This is the safety property — after the list is shown and Delete tapped, exactly
  // ONE round is honoured; a stray number typed later can never soft-delete a bill. To
  // remove another, the user taps 🗑️ Delete a bill again, or ➡️ Next after a round completes.
  entry.armed = false;
  if (!entry.deleted) entry.deleted = []; // running session total, shown by delnum:done
  // sbSelectGlobal (2026-08-23): same fix as handleCallbackQuery's — see its doc comment.
  const selectGlobal = deps.sbSelectGlobal || sbSelectGlobal;
  const softDelete = deps.sbSoftDelete || sbSoftDelete;
  const send = deps.tgSend || tgSend;

  if (nums.length === 1) {
    const n = nums[0];
    if (n < 1 || n > entry.ids.length) {
      await send(chatId, '🔢 Please reply with a number between 1 and ' + entry.ids.length + ' — tap 🗑️ Delete a bill again to pick one.');
      return true;
    }
    const id = entry.ids[n - 1];
    try {
      const rows = await selectGlobal('expenses', { eq: { id } });
      const row = rows[0];
      if (!row || row.deleted_at) { await send(chatId, '🗑️ Bill #' + n + ' is already gone.'); return true; }
      if (String(row.rep_chat_id) !== String(chatId)) {
        await send(chatId, '⚠️ Only the person who submitted bill #' + n + ' can delete it — tap 🗑️ Delete a bill again to pick one of yours.');
        return true;
      }
      await softDelete('expenses', { id, scope: { account_id: row.account_id } });
      entry.deleted.push({ merchant: row.merchant, amount: row.amount, currency: row.currency });
      await send(chatId, '🗑️ *Bill deleted*\n\n🏪 *' + (row.merchant || 'Unknown') + '* — ' + fmtMoney(row.amount, row.currency), NEXT_DONE_KEYBOARD);
      return true;
    } catch (e) {
      console.error('[bill-delete]', e && e.message);
      await send(chatId, '⚠️ Couldn\'t delete that bill right now. Please try again.');
      return true;
    }
  }

  // List path: process every number, one outcome line each, single combined reply.
  const lines = [];
  for (const n of nums) {
    if (n < 1 || n > entry.ids.length) { lines.push('#' + n + ' — no such bill.'); continue; }
    const id = entry.ids[n - 1];
    try {
      const rows = await selectGlobal('expenses', { eq: { id } });
      const row = rows[0];
      if (!row || row.deleted_at) { lines.push('#' + n + ' — already gone.'); continue; }
      if (String(row.rep_chat_id) !== String(chatId)) { lines.push('#' + n + ' — only the submitter can delete that one.'); continue; }
      await softDelete('expenses', { id, scope: { account_id: row.account_id } });
      entry.deleted.push({ merchant: row.merchant, amount: row.amount, currency: row.currency });
      lines.push('🗑️ #' + n + ' *' + (row.merchant || 'Unknown') + '* — ' + fmtMoney(row.amount, row.currency) + ' deleted.');
    } catch (e) {
      console.error('[bill-delete list]', e && e.message);
      lines.push('#' + n + ' — could not delete, please try again.');
    }
  }
  await send(chatId, '🗑️ *Deleted ' + nums.length + ' bills*\n\n' + lines.join('\n'), NEXT_DONE_KEYBOARD);
  return true;
}

// deps is optional and injected only by tests (setTimeout/clearTimeout/runBatch/etc.);
// production calls handleUpdate(update) and everything defaults to the real modules.
async function handleUpdate(update, deps = {}) {
  // Inline-keyboard button tap (delete confirm/cancel) has no `message`/`edited_message`
  // on this update shape — its chat lives at callback_query.message.chat.id instead.
  // Resolved up front so the allowlist gate below covers BOTH shapes: a stranger must
  // not be able to act on the bot via a button tap any more than via a text message.
  const cq = update.callback_query;
  const msg = update.message || update.edited_message;
  if (!cq && !msg) return;
  const chatId = cq ? (cq.message && cq.message.chat && cq.message.chat.id) : msg.chat.id;
  const send = deps.tgSend || tgSend;

  // Access allowlist: when configured, only listed chat IDs may use the bot.
  const allow = deps.allowedChatIds || ALLOWED_CHAT_IDS;
  if (allow.length && !allow.includes(String(chatId))) {
    console.warn('[access] denied chat id', chatId);
    if (cq) { await (deps.tgAnswerCallback || tgAnswerCallback)(cq.id); return; }
    await send(chatId, '🔒 Sorry, this is a private bot. Please ask the owner to give you access.');
    return;
  }

  // Identity/bind gate (ADR-021 Phase 5, issue #107; extended 2026-07-25 for personal-mode
  // signup): entirely inert when NEITHER capabilities.multiUser NOR personalAuth is on — the
  // plain personal bot below is reached exactly as before, byte-for-byte. When either is on,
  // every chat must be bound via a one-time /start <token> deep link before anything else
  // runs (both cq and msg paths — a stranger must not be able to act via a button tap any
  // more than via a text message). personalAuth accounts bind with role:'owner' (see
  // lib/personalAuth.js) — same bindWithToken/resolveBinding mechanism as business, just a
  // different role value. Guest Mode (2026-07-28) adds a THIRD single-user role, 'guest'
  // (lib/guest.js), same reasoning — which is why every branch below explicitly checks
  // `isPersonalBinding(businessBinding.role)` (owner OR guest) before showing business-only
  // copy/UI (Staff Lock, "ask which staff member it's for") rather than assuming any truthy
  // binding is business.
  const caps = (deps.getCapabilities || getCapabilities)();
  const requireBinding = caps.multiUser || caps.personalAuth || caps.guestMode;
  let businessBinding = null; // stays null when neither flag is on — every branch below is inert
  if (requireBinding) {
    const text0 = msg ? (msg.text || '').trim() : '';
    const startMatch = /^\/start(?:@\S+)?(?:\s+(\S+))?/i.exec(text0);
    if (msg && startMatch && startMatch[1]) {
      const result = await (deps.bindWithToken || bindWithToken)(startMatch[1], chatId, deps);
      if (!result.ok) { await send(chatId, result.message); return; }
      const welcome = result.role === 'owner' ? PERSONAL_WELCOME
        : result.role === 'guest' ? GUEST_WELCOME
        : result.role === 'admin' ? BUSINESS_WELCOME_ADMIN : BUSINESS_WELCOME_CLERK;
      const kb = isPersonalBinding(result.role) ? MAIN_MENU_KEYBOARD : businessMenuKeyboard(null);
      await send(chatId, welcome, kb);
      return;
    }
    businessBinding = await (deps.resolveBinding || resolveBinding)(chatId, deps);
    if (!businessBinding) {
      // 2026-08-08: personal-mode unbound chats (never signed up, OR the 30-day inactivity
      // check above just cleared a stale binding) get the in-bot signup/reconnect flow
      // instead of a dashboard-only dead end. Business mode and bare guestMode (guests are
      // always already bound by /api/guest/start — see isPersonalBinding's own comment)
      // keep their original messages untouched.
      if (caps.personalAuth && !caps.multiUser) {
        if (cq) { await (deps.handleSignupCallback || handleSignupCallback)(cq, chatId, deps); return; }
        if (pendingSignup.has(chatId)) { await (deps.handleSignupStep || handleSignupStep)(msg, chatId, deps); return; }
        await (deps.showSignupPrompt || showSignupPrompt)(chatId, deps);
        return;
      }
      if (cq) { await (deps.tgAnswerCallback || tgAnswerCallback)(cq.id); return; }
      await send(chatId, (caps.personalAuth || caps.guestMode) && !caps.multiUser ? PERSONAL_UNBOUND_MESSAGE : BUSINESS_UNBOUND_MESSAGE);
      return;
    }
    // Bound: fall through to the normal routing below with the binding in hand — uploads tag
    // branch_id (+ the staff picker, business only), today's-bills/weekly scope by branch.
    // An owner binding's branch_id/company_id are null, which every downstream consumer
    // (sendStaffPicker, branchEq, etc.) already treats as "no branch scoping" safely.
    // Heartbeat: keeps the 30-day inactivity clock reset on every message from an active OWNER
    // chat (resolveBinding above only READS last_active_at; this is the only place that
    // refreshes it). Scoped to role==='owner' — business/guest bindings never write this column
    // at all, matching resolveBinding's own scoping. Fire-and-forget-safe (never throws) —
    // must never delay the reply that follows.
    if (businessBinding.role === 'owner') (deps.updateLastActive || updateLastActive)(businessBinding.id, deps);

    // Guest trial-ended gate (2026-08-22, QA report #3: "if user try to chat with bot after
    // their guest mode trial finish, I want bot show message [access the app now...] don't
    // reply other than that"). Before this, only the PHOTO/PDF capture path checked the cap
    // (lib/ocr.js's guestCapped branch) — a capped guest sending plain text or tapping an old
    // inline button still fell through to the normal menu/reply logic, which both contradicts
    // the request and (for a photo/PDF specifically) burns a real OCR API call on a receipt
    // that was always going to be rejected anyway. Checked BEFORE the cq/photo/text routing
    // below so it covers every input shape uniformly. Owner/business roles are never capped —
    // this only ever applies to role==='guest'.
    if (businessBinding.role === 'guest') {
      const used = await (deps.countGuestExpenses || countGuestExpenses)(businessBinding.user_id, deps);
      if (used >= GUEST_RECEIPT_CAP) {
        if (cq) { await (deps.tgAnswerCallback || tgAnswerCallback)(cq.id); }
        await send(chatId, GUEST_CAP_REACHED_MESSAGE);
        return;
      }
    }
  }

  if (cq) {
    await (deps.handleCallbackQuery || handleCallbackQuery)(cq, deps);
    return;
  }

  const repName = (msg.from && (msg.from.first_name || msg.from.username)) || 'User';
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const debounce = deps.debounceMs || GROUP_DEBOUNCE_MS;
  const cap = deps.maxGroupImages || MAX_GROUP_IMAGES;

  // Photo/image batch (2026-07-20 rewrite): buffer under its media_group_id when Telegram
  // gives one, else under a synthetic 'solo:<chatId>' key — so several photos sent as
  // separate individual messages within one debounce window STILL coalesce into one batch,
  // exactly like a real Telegram album. Before this, a burst of individually-sent photos
  // each independently spammed their own "Reading your receipt…" ack and fired at the AI
  // service with zero pacing between them (see docs/qa/2026-07-17-…md and the bulk-pacing
  // fix — that fix only paced TRUE albums; this closes the gap for ungrouped bursts too).
  // flushGroup replays the exact single-receipt reply (processSinglePhoto) when a group ends
  // up with only one photo — a genuinely solo send is unaffected except for the debounce
  // delay (the ack below still fires immediately; only the actual OCR read is deferred).
  if (bestPhotoFileId(msg)) {
    const id = msg.media_group_id ? String(msg.media_group_id) : ('solo:' + chatId);
    let g = groups.get(id);
    if (!g) {
      // branchId/companyId (business only): pinned on the group at creation so the whole
      // batch is attributed to the capturing chat's branch + company when it flushes.
      // null in personal mode. isSolo (2026-07-20): true only for a SYNTHETIC group (no real
      // media_group_id) — flushGroup uses this, not fileIds.length alone, to decide whether a
      // single-image group gets the solo reply. A real Telegram media_group_id is NEVER
      // assigned to just one photo, but several existing tests deliberately send only one
      // photo under a fabricated media_group_id to exercise the batch pipeline in isolation —
      // those must keep going through runBatch, not the solo path.
      g = { chatId, repName, fileIds: [], fileUniqueIds: [], timer: null, isSolo: !msg.media_group_id, overCap: false,
        branchId: businessBinding ? businessBinding.branch_id : null,
        companyId: businessBinding ? businessBinding.company_id : null,
        // Guest Mode (2026-07-28): only ever set for a guest binding, null otherwise/personal.
        ownerUserId: (businessBinding && businessBinding.role === 'guest') ? businessBinding.user_id : null,
        // 2026-08-14 SECURITY FIX: pinned on the group at creation, same as branchId/companyId
        // above, so an album/PDF batch is attributed to the capturing account, not the shared
        // default — see lib/ocr.js assembleExpense's matching doc comment.
        accountId: businessBinding ? businessBinding.account_id : null };
      groups.set(id, g);
      // Immediate reassurance on the FIRST photo, so the chat isn't silent while the
      // debounce + AI read run. Sent ONCE per group — wording matches what triggered
      // creation (a real album vs. an initially-solo send), regardless of how many more
      // photos join before the debounce fires. NOTE: this fires optimistically before we
      // know the group will end up over-cap — flushGroup's reject message (if it goes
      // over-cap) supersedes this, since nothing actually gets read in that case.
      await send(chatId, msg.media_group_id
        ? '🧾 *Got your receipts — reading them all now…*\nPlease hold on a moment 🙏'
        : '🧾 *Reading your receipt…*\nPlease hold on a moment 🙏');
    }
    // fileUniqueIds stays index-aligned with fileIds (issue #152 exact-resend detection —
    // each image's own stable id, distinct from file_id which isn't stable across resends).
    // 2026-07-20 (owner request, revised): over-cap no longer processes the first `cap`
    // photos and drops the rest — it rejects the WHOLE batch, unread. Nothing is scanned at
    // all once a group goes over the limit; flushGroup below checks g.overCap FIRST and, if
    // set, skips runBatch/processSinglePhoto entirely and sends only the reject message.
    if (g.fileIds.length < cap) { g.fileIds.push(bestPhotoFileId(msg)); g.fileUniqueIds.push(bestPhotoFileUniqueId(msg)); }
    else { g.overCap = true; }
    if (g.timer) clearT(g.timer);
    // Return the flush promise from the callback: production setTimeout ignores it
    // (fire-and-forget), but injected test timers can await the real flush. flushGroup
    // itself never throws (see its own try/catch), but this .catch is a defense-in-depth
    // backstop — without it, a future refactor that reopens that guarantee would produce
    // a Node unhandledRejection with no reply ever sent to the user (nothing else here
    // is listening for a timer-callback rejection once handleUpdate has already returned).
    g.timer = setT(() => flushGroup(id, deps).catch(e => console.error('[group timer]', e && e.message)), debounce);
    return;
  }

  // #1 PDF document — before the single-photo path (never intercepts photos/images).
  if (isPdfDocument(msg)) {
    await (deps.handlePdfDocument || handlePdfDocument)(chatId, repName, msg.document.file_id, deps,
      businessBinding ? bindingMeta(businessBinding) : {});
    return;
  }

  const text = (msg.text || '').trim();
  // Owner request 2026-07-03: if this chat tapped "Others" on a category picker and is
  // now expected to type a short note, the NEXT plain-text message is treated as that
  // remark — checked BEFORE /start etc. so it isn't swallowed by the generic keyword
  // routing below. Any text (even one that looks like a command) is consumed as the
  // remark while a row is pending — kept deliberately simple, no special-casing.
  // Business "Delete a bill → type the number" (M2 #107): a cheap in-memory gate that
  // no-ops instantly unless this chat is armed (tapped Delete on its Today's Bills list).
  // Checked before the remark/keyword routing so a typed bill number isn't swallowed.
  if (text && await (deps.tryResolveBillDelete || tryResolveBillDelete)(chatId, text, deps)) return;
  if (text && await (deps.tryResolveDate || tryResolveDate)(chatId, text, deps)) return;
  if (text && await (deps.tryResolveRemark || tryResolveRemark)(chatId, text, deps)) return;
  // 2026-08-23: the new "✏️ Edit"/"📝 Add Remark" card-edit flow — separate in-memory
  // pending state from the two DB-status-based resolvers just above (see pendingCardEdit's
  // own doc comment). Checked in the same "before generic routing" spot for the same reason.
  if (text && await (deps.tryResolveCardEdit || tryResolveCardEdit)(chatId, text, deps)) return;
  if (/^\/start/i.test(text)) {
    const showBusinessMenu = businessBinding && !isPersonalBinding(businessBinding.role);
    await send(chatId, WELCOME, showBusinessMenu ? businessMenuKeyboard(staffLockByChat.get(chatId) || null) : MAIN_MENU_KEYBOARD);
    return;
  }
  // Owner request 2026-07-04: the 4 persistent menu buttons (MAIN_MENU_KEYBOARD) send
  // their exact label text like a normal message — matched here, BEFORE the generic
  // expense-keyword regex below, since "💰 Today Expenses" would otherwise also match that
  // regex and go to the wrong handler (sendExpenseSummary instead of handleTodayExpenses).
  if (text === '📋 Today Bills') { await (deps.handleTodayBills || handleTodayBills)(chatId, deps, businessBinding); return; }
  if (text === '💰 Today Expenses') { await (deps.handleTodayExpenses || handleTodayExpenses)(chatId, deps, businessBinding); return; }
  if (text === '📅 Weekly Record') { await (deps.handleWeeklyRecord || handleWeeklyRecord)(chatId, deps, businessBinding); return; }
  // 2026-07-20: no longer re-attaches the menu keyboard — see handleTodayExpenses' comment.
  if (text === '🧭 Bot Guide') { await send(chatId, BOT_GUIDE_TEXT); return; }
  // Staff Lock Mode menu buttons (business mode only — personal mode never shows these).
  if (text === '👤 Staff Lock' && businessBinding && !isPersonalBinding(businessBinding.role)) {
    await (deps.handleStaffLockStart || handleStaffLockStart)(chatId, businessBinding.branch_id, deps);
    return;
  }
  // 2026-07-22 (Owner-reported live incident): staffLockByChat is in-memory only (never
  // persisted), so a server restart between "Staff Lock ON" and tapping Done silently wipes
  // it -- the keyboard still visually shows the Done button (Telegram keeps a reply keyboard
  // client-side until a NEW message replaces it), but the server has no memory of any lock.
  // This used to have NO else branch, so a stale tap fell all the way through to the
  // unrelated generic "I didn't quite catch that" fallback -- confusing, since the user
  // tapped an actual menu button, not typed free text. Now mirrors the '🔓 Locked:' status
  // button's existing if/else pattern just below: an honest "not currently locked" message,
  // not silence-as-a-fallback.
  if (text === '✅ Done' && businessBinding && !isPersonalBinding(businessBinding.role)) {
    if (staffLockByChat.has(chatId)) {
      staffLockByChat.delete(chatId);
      await send(chatId, '🔓 *Staff Lock OFF* — back to normal mode.\n\nFuture receipts will ask for staff selection again.', businessMenuKeyboard(null));
    } else {
      await send(chatId, '👤 No active lock right now — nothing to unlock. Tap *👤 Staff Lock* to start one.', businessMenuKeyboard(null));
    }
    return;
  }
  if (text.indexOf('🔓 Locked:') === 0 && businessBinding && !isPersonalBinding(businessBinding.role)) {
    const lock = staffLockByChat.get(chatId);
    if (lock) await send(chatId, '🔒 Currently locked to *' + lock.staffName + '*. Tap *✅ Done* to unlock.');
    else await send(chatId, '👤 No active lock. Tap *👤 Staff Lock* to start.', businessMenuKeyboard(null));
    return;
  }
  if (/expense|spent|show|list|total|report|summary/i.test(text)) { await (deps.sendExpenseSummary || sendExpenseSummary)(chatId, deps, businessBinding); return; }
  // Recognise "delete" intent so the reply actually answers what was asked, instead of
  // the generic photo prompt (which reads as if the bot ignored the message entirely).
  if (/delete|remove|undo|cancel/i.test(text)) {
    await (deps.handleDeleteIntent || handleDeleteIntent)(chatId, deps);
    return;
  }
  // 2026-07-20: no longer re-attaches the menu keyboard — see handleTodayExpenses' comment.
  await send(chatId, '🤔 I didn\'t quite catch that, but I\'m great with receipts!\n\n📸 Send me a photo (or a few at once) and I\'ll log them for you.');
}

module.exports = { handleUpdate, sendExpenseSummary, flushGroup, handlePdfDocument, formatBatchSummary, handleDeleteIntent, handleCallbackQuery, tryResolveRemark, tryResolveDate, tryResolveBillDelete, handleTodayBills, handleTodayExpenses, handleWeeklyRecord, todayISO_MYT, weekStartISO_MYT, mytDayBoundsUTC, mytWeekStartBoundUTC, MAIN_MENU_KEYBOARD, BOT_GUIDE_TEXT, WELCOME,
  // Business-mode identity (ADR-021 Phase 5, issue #107)
  resolveBinding, bindWithToken, mytWeekStartSundayBoundUTC, weekStartSundayISO_MYT,
  BUSINESS_WELCOME_ADMIN, BUSINESS_WELCOME_CLERK, BUSINESS_UNBOUND_MESSAGE,
  // Permanent binding + in-bot signup/reconnect (2026-08-08)
  updateLastActive, showSignupPrompt, handleSignupCallback, handleSignupStep, clearPendingSignup,
  PERSONAL_UNBOUND_MESSAGE, PERSONAL_WELCOME, INACTIVITY_UNBIND_MS,
  // Submit-signal admin ping (C5 follow-up)
  notifySubmissionReady,
  // Business staff-tag picker + branch scoping (Phase 5 follow-up, issue #107)
  sendStaffPicker, branchEq,
  // Batch/album staff attribution wizard (issue #152 part 1)
  startBatchStaffWizard,
  // Staff Lock Mode (bulk upload with pre-selected staff)
  staffLockByChat, pendingStaffLockPicks, businessMenuKeyboard,
  handleStaffLockStart, sendLockedReceipt, sendLockedBatchSummary,
  // Bulk-spam fix (2026-07-20): ungrouped photos now coalesce like a real album
  processSinglePhoto };

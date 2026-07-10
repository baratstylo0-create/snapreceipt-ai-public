'use strict';
const { cfg } = require('./config');
const { sbSelect, sbUpdate, sbSoftDelete } = require('./supabase');
const { tgSend, tgSendPhoto, tgEditMessage, tgFileUrl, tgAnswerCallback } = require('./telegram');
const { hreq } = require('./http');
const { fmtMoney, parseDateLoose } = require('./money');
const { expenseFromPhoto, extractReceipts, assembleExpense, categoryPromptText, buildCategoryKeyboard, specCategories, PENDING_CATEGORY, duplicateRejectedText, buildDuplicateKeyboard, skipMessage } = require('./ocr');
const { getFieldSpec } = require('./templates');
const { runBatch } = require('./massupload');
const { rasterizePdf } = require('./pdf');
const { getCapabilities } = require('./account');
const { listStaff } = require('./branches');

const WELCOME = '👋 *Receipt Analyser*\n\nSend me a *photo of any receipt or invoice* and I\'ll read it, extract the merchant, amount, tax and line items, and log it automatically.\n\n• 📸 Snap a receipt → auto-logged\n• 🧾 Send *several photos at once* → all logged in one go\n• 💬 Type *"show expenses"* for a summary\n\nTry it now — send a receipt photo!\n\n_Use the buttons below any time._';

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

// resolveBinding(chatId) -> the active bot_bindings row for this chat, or null if unbound.
async function resolveBinding(chatId, deps = {}) {
  const select = deps.sbSelect || sbSelect;
  try {
    const rows = await select('bot_bindings', { eq: { chat_id: String(chatId), active: true }, limit: 1 });
    return rows[0] || null;
  } catch (e) {
    console.error('[binding lookup]', e.message);
    return null; // fail closed — an error here reads as "unbound", never as "let them through"
  }
}

// bindWithToken(token, chatId) -> { ok, message } — validates + locks a one-time bind_token
// to this chat. Never throws; every failure path returns a friendly, non-technical message.
async function bindWithToken(token, chatId, deps = {}) {
  const select = deps.sbSelect || sbSelect;
  const update = deps.sbUpdate || sbUpdate;
  const t = String(token || '').trim();
  if (!t) return { ok: false, message: '🔒 That link looks incomplete. Please ask your admin for your binding link again.' };
  try {
    const rows = await select('bot_bindings', { eq: { bind_token: t, active: true }, limit: 1 });
    const row = rows[0];
    if (!row) return { ok: false, message: '🔒 That link isn\'t valid. Please ask your admin for a fresh binding link.' };
    if (row.token_expires_at && new Date(row.token_expires_at).getTime() <= Date.now()) {
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
    await update('bot_bindings', { id: row.id }, { chat_id: String(chatId), bound_at: new Date().toISOString() });
    return { ok: true, role: row.role };
  } catch (e) {
    console.error('[bind token]', e.message);
    return { ok: false, message: '⚠️ Couldn\'t complete that right now. Please try your link again shortly.' };
  }
}

const BUSINESS_WELCOME_ADMIN = '👋 *Welcome!*\n\nYou\'re bound as the *admin*. Send a receipt photo any time to log it — I\'ll ask which staff member it\'s for.';
const BUSINESS_WELCOME_CLERK = '👋 *Welcome!*\n\nYou\'re bound as a *branch clerk*. Send a receipt photo any time to log it — I\'ll ask which staff member it\'s for.';
const BUSINESS_UNBOUND_MESSAGE = '🔒 This bot needs a one-time access link before it can be used. Please ask your admin for your binding link.';

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
const MAX_GROUP_IMAGES = Number(process.env.MASS_MAX_IMAGES || '10') || 10;
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
// array of 'blurry' | 'not_receipt' | 'unclear' — one entry per skipped receipt, in the
// order they were skipped — captured by flushGroup's captureAssemble wrapper. When it's
// available and fully accounted for, breaks the count down by WHY (mirrors the
// single-photo skipMessage() wording in lib/ocr.js); otherwise falls back to one safe
// generic line rather than guessing.
function skipFooter(summary, skippedReasons) {
  if (!summary.skipped) return '';
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const generic = '\n\n_' + plural(summary.skipped, 'photo') + " didn't look like a clear receipt, so "
    + (summary.skipped === 1 ? 'it was' : 'they were') + ' skipped rather than guessed._';
  if (!Array.isArray(skippedReasons) || skippedReasons.length !== summary.skipped) return generic;
  const blurryN = skippedReasons.filter(r => r === 'blurry').length;
  const notReceiptN = skippedReasons.filter(r => r === 'not_receipt').length;
  if (blurryN + notReceiptN !== summary.skipped) return generic; // some 'unclear' in the mix — stay safe/generic
  const bits = [];
  if (blurryN) bits.push(plural(blurryN, 'photo') + ' too blurry to read');
  if (notReceiptN) bits.push(plural(notReceiptN, 'photo') + " that didn't look like a receipt at all");
  return '\n\n_Skipped ' + bits.join(' and ') + ' — nothing was guessed._';
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
  if (summary.failed.length) parts.push(summary.failed.length + ' couldn\'t read');
  let text = '✅ *Batch processed*\n\n' + parts.join(' · ');
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

// Flush one buffered media group: resolve each file_id -> URL, runBatch once, one reply.
// Never throws (mirrors expenseFromPhoto's graceful degradation).
async function flushGroup(groupId, deps = {}) {
  const g = groups.get(groupId);
  if (!g) return;
  groups.delete(groupId);
  if (!g.fileIds.length) return;
  // send is resolved first, outside the try — it's the one thing the catch block
  // itself depends on to report failure, so it must survive even if every other
  // dep below throws while being resolved (e.g. a hostile/misconfigured deps object).
  const send = deps.tgSend || tgSend;
  const sendPhoto = deps.tgSendPhoto || tgSendPhoto;
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
    if (images.every(u => u == null)) { await send(g.chatId, '📷 Couldn\'t download those photos. Please resend them.'); return; }
    // Option (A), decided with J1 (issue #31 tracks per-image links): one meta for the
    // batch, fileId:null — consistent with the dashboard adapter; assembleExpense tolerates null.
    // branch_id/company_id (business only, M2 #107/#8): pinned on the group at creation —
    // the whole album is attributed to the capturing chat's branch + company. Absent in
    // personal mode. rejectDuplicates (issue #152): extends #162 D13's exact-reject
    // behaviour from the single-photo path to the batch path too — was previously only
    // flag-and-save here, the same gap #162 already closed for single photos.
    const meta = { chatId: g.chatId, repName: g.repName, fileId: null,
      ...(g.branchId ? { branch_id: g.branchId } : {}),
      ...(g.companyId ? { company_id: g.companyId } : {}),
      rejectDuplicates: true };
    // Per-image file_unique_id (issue #152) — the stable id used for exact-resend
    // detection, distinct from the fileId/URL used to read the image content.
    const metaForImage = (i) => ({ ...meta, receipt_file_unique_id: g.fileUniqueIds[i] });
    // Capture each saved receipt's details WITHOUT touching runBatch (Jeevan's file):
    // wrap the injected assembleExpense so every successfully-assembled expense is
    // recorded here, then rendered as a per-receipt breakdown in the summary.
    const saved = [];
    const skippedReasons = []; // one 'blurry' | 'not_receipt' | 'unclear' per skipped receipt, feeds skipFooter()
    // Owner request 2026-07-03: a receipt whose category is uncertain is already saved
    // (assembleExpense inserted it) but kept OUT of the normal `saved` breakdown — it
    // gets its own separate category-picker message, sent AFTER the main summary below.
    const awaitingPicks = [];
    const captureAssemble = async (args) => {
      const res = await assemble(args);
      if (res && res.skipped) {
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
    const summary = await batch(images, fieldSpec, { extractReceipts: extract, assembleExpense: captureAssemble, meta, metaForImage });
    await send(g.chatId, formatBatchSummary(summary, saved, skippedReasons, awaitingPicks.length));
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
      await (deps.startBatchStaffWizard || startBatchStaffWizard)(g.chatId, saved, g.branchId, deps);
    }
  } catch (e) {
    console.error('[group]', e && e.message);
    await send(g.chatId, '⚠️ Couldn\'t process that batch. Please resend the photos.');
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
    const meta = { chatId, repName, fileId: null, // option A (issue #31): single meta, no per-page link
      ...(extraMeta && extraMeta.branch_id ? { branch_id: extraMeta.branch_id } : {}),
      ...(extraMeta && extraMeta.company_id ? { company_id: extraMeta.company_id } : {}) };
    // Parity with flushGroup: capture per-receipt details + skip reasons so a PDF that
    // renders fine but yields nothing usable gets an honest explanation ("not a clear
    // receipt") instead of a bare, unexplained "0 saved" (fixed 2026-07-03).
    const saved = [];
    const skippedReasons = [];
    const captureAssemble = async (args) => {
      const res = await assemble(args);
      if (res && res.skipped) {
        skippedReasons.push(res.skipReason || 'unclear');
      } else if (res && res.expense) {
        const e = res.expense;
        saved.push({ merchant: e.merchant, amount: e.amount, currency: e.currency, category: e.category, flagged: !!res.flagged });
      }
      return res;
    };
    const summary = await batch(images, fieldSpec, { extractReceipts: extract, assembleExpense: captureAssemble, meta });
    let text = formatBatchSummary(summary, saved, skippedReasons);
    if (pagesTruncated) text += '\n\n_This PDF had more pages than I could read at once._';
    await send(chatId, text);
  } catch (e) {
    console.error('[pdf]', e && e.message);
    await send(chatId, '📄 Couldn\'t read that PDF. Please resend a clearer scan.');
  }
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
  const softDelete = deps.sbSoftDelete || sbSoftDelete;
  const update = deps.sbUpdate || sbUpdate;
  const pending = deps.pendingRemarkMessages || pendingRemarkMessages;
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
  // Issue #162 D13: "View" on a duplicate-rejected reply — shows the EXISTING receipt's
  // own details (read-only). Same ownership check as every other tap in this handler.
  if (data.indexOf('dupview:') === 0) {
    const id = data.slice(8);
    try {
      const rows = await select('expenses', { eq: { id } });
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
      const rows = await select('expenses', { eq: { id } });
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
        { text: '🗑️ Delete', callback_data: 'delask:' + id },
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
  // "👤 Edit staff" from the duplicate-edit menu: re-opens the SAME staff picker
  // (sendStaffPicker) keyed to the EXISTING receipt's own branch — one tested
  // implementation, not a parallel one.
  if (data.indexOf('dupstaff:') === 0) {
    const id = data.slice(9);
    try {
      const rows = await select('expenses', { eq: { id } });
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
      const rows = await select('expenses', { eq: { id } });
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
      await softDelete('expenses', { id });
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
      const rows = await select('expenses', { eq: { id } });
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
        await update('expenses', { id }, { category: 'Others', status: 'awaiting_remark' });
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
      await update('expenses', { id }, { category, status: 'saved' });
      await answer(cq.id, { text: 'Saved' });
      // Owner request 2026-07-04: a re-pick via the "✏️ Edit category" button (catedit:
      // below, which resets an already-resolved row back to awaiting_category) reads
      // "(updated)" instead of the plain first-time wording, so it's clear this changed
      // an existing answer rather than resolving a fresh uncertain receipt.
      const wasEdit = row.category && row.category !== PENDING_CATEGORY;
      const confirmText = '✅ *Saved as ' + category + (wasEdit ? ' (updated)*' : '*')
        + '\n\n🏪 *' + (row.merchant || 'Unknown') + '* — ' + fmtMoney(row.amount, row.currency);
      if (messageId) await edit(chatId, messageId, confirmText);
      else await send(chatId, confirmText);
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
      const rows = await select('expenses', { eq: { id } });
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
      await update('expenses', { id }, { status: 'awaiting_category' });
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
  // "❌ #N" tap from the "📋 Today Bills" list (Owner request 2026-07-04). Ownership is
  // checked HERE (before showing any confirm prompt — immediate, honest feedback if this
  // isn't your bill) AND again inside the existing `del:<id>` flow at final confirm time
  // (defense in depth, same pattern used throughout this file). Deliberately scoped to the
  // ORIGINAL submitter only, even though the Today Bills LIST itself is account-wide —
  // Owner's explicit choice, matches how "type delete" already behaves.
  if (data.indexOf('delask:') === 0) {
    const id = data.slice(7);
    try {
      const rows = await select('expenses', { eq: { id } });
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
  if (data === 'delnum:ask') {
    const delPending = deps.pendingBillDelete || pendingBillDelete;
    const entry = delPending.get(String(chatId));
    if (!entry || !entry.ids.length) {
      await answer(cq.id, { text: 'Expired' });
      await send(chatId, '📋 That list expired — tap *📋 Today Bills* again, then Delete.');
      return;
    }
    entry.armed = true;
    await answer(cq.id);
    await send(chatId, '🗑️ Which bill? Reply with its *number* (1–' + entry.ids.length + ').');
    return;
  }
  await answer(cq.id); // unrecognised callback data — just clear the spinner
}

async function sendExpenseSummary(chatId) {
  try {
    const rows = await sbSelect('expenses', { order: 'created_at.desc', limit: 10 });
    if (!rows.length) { await tgSend(chatId, '📭 No expenses logged yet. Send me a receipt photo to get started!'); return; }
    const cur = rows[0].currency || cfg.DEFAULT_CURRENCY;
    const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const lines = rows.slice(0, 8).map(r => '• *' + (r.merchant || 'Unknown') + '* — ' + fmtMoney(r.amount, r.currency || cur) + '  _(' + r.category + ')_').join('\n');
    await tgSend(chatId, '🧾 *Recent Expenses*\n\n' + lines + '\n\n💰 *Last 10 total:* ' + fmtMoney(total, cur));
  } catch (e) { console.error('[summary]', e.message); await tgSend(chatId, '⚠️ Could not load expenses right now.'); }
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
function branchEq(binding) {
  return (binding && binding.role === 'clerk' && binding.branch_id) ? { branch_id: binding.branch_id } : {};
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
      extra: 'deleted_at=is.null&created_at=gte.' + encodeURIComponent(startUTC) + '&created_at=lt.' + encodeURIComponent(endUTC),
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

// "💰 Today Expenses" menu button — just the total, account-wide, same day boundary as
// handleTodayBills (Malaysia time, filtered by `created_at` — see the fix note above).
async function handleTodayExpenses(chatId, deps = {}, binding = null) {
  const send = deps.tgSend || tgSend;
  const select = deps.sbSelect || sbSelect;
  const today = (deps.todayISO || todayISO_MYT)();
  const { startUTC, endUTC } = (deps.dayBounds || mytDayBoundsUTC)();
  try {
    const rows = await select('expenses', {
      eq: branchEq(binding),
      extra: 'deleted_at=is.null&created_at=gte.' + encodeURIComponent(startUTC) + '&created_at=lt.' + encodeURIComponent(endUTC),
    });
    const cur = (rows[0] && rows[0].currency) || cfg.DEFAULT_CURRENCY;
    const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    await send(chatId, '💰 *Today\'s Expenses* (' + today + ')\n\n' + plural(rows.length, 'bill') + ' · *' + fmtMoney(total, cur) + '*');
  } catch (e) { console.error('[today-expenses]', e.message); await send(chatId, '⚠️ Could not load today\'s total right now.'); }
}

// "📅 Weekly Record" menu button — this week's total, Monday (MYT) through now, filtered
// by `created_at` (see the fix note on handleTodayBills — same reasoning applies here).
// Business weeks start on SUNDAY (design doc: "weekly = Sun-Sat"); personal weeks keep
// their existing Monday start. Bound business chats (both roles) get the Sunday week;
// a bound clerk's total is additionally branch-scoped (branchEq above).
async function handleWeeklyRecord(chatId, deps = {}, binding = null) {
  const send = deps.tgSend || tgSend;
  const select = deps.sbSelect || sbSelect;
  const today = (deps.todayISO || todayISO_MYT)();
  const weekStart = binding
    ? (deps.weekStartSundayISO || weekStartSundayISO_MYT)()
    : (deps.weekStartISO || weekStartISO_MYT)();
  const weekStartUTC = binding
    ? (deps.weekStartSundayBoundUTC || mytWeekStartSundayBoundUTC)()
    : (deps.weekStartBoundUTC || mytWeekStartBoundUTC)();
  try {
    const rows = await select('expenses', { eq: branchEq(binding), extra: 'deleted_at=is.null&created_at=gte.' + encodeURIComponent(weekStartUTC) });
    const cur = (rows[0] && rows[0].currency) || cfg.DEFAULT_CURRENCY;
    const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
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

// Business "type the bill number to delete" flow (M2 #107, business mode only). Consumes
// the NEXT plain message after a bound chat tapped "🗑️ Delete a bill" on its Today's Bills
// list — mirrors tryResolveRemark's "consume the next message while a state is pending"
// pattern. Returns true (message handled, stop routing) only when this chat is ARMED and
// typed an integer; a non-number falls through (returns false) so the user can still tap a
// menu button or type "cancel". Deletion stays scoped to the ORIGINAL submitter (rep_chat_id),
// the same rule the ❌ per-bill flow enforces — a bound admin/clerk can only remove bills
// submitted from THIS chat, even though the list itself shows the whole branch's bills.
async function tryResolveBillDelete(chatId, text, deps = {}) {
  const pending = deps.pendingBillDelete || pendingBillDelete;
  const entry = pending.get(String(chatId));
  if (!entry || !entry.armed) return false;                 // not in delete mode — ignore
  const t = String(text).trim();
  if (!/^\d+$/.test(t)) return false;                        // not a number — let normal routing handle it
  const n = Number(t);
  // Single-use: any typed number consumes the arm, whatever the outcome (Jeevan review of
  // #139). This is the safety property — after the list is shown and Delete tapped, exactly
  // ONE number is honoured; a stray number typed later can never soft-delete a bill. To
  // remove another, the user taps 🗑️ Delete a bill again (which re-arms with a fresh list).
  entry.armed = false;
  const select = deps.sbSelect || sbSelect;
  const softDelete = deps.sbSoftDelete || sbSoftDelete;
  const send = deps.tgSend || tgSend;
  if (n < 1 || n > entry.ids.length) {
    await send(chatId, '🔢 Please reply with a number between 1 and ' + entry.ids.length + ' — tap 🗑️ Delete a bill again to pick one.');
    return true;
  }
  const id = entry.ids[n - 1];
  try {
    const rows = await select('expenses', { eq: { id } });
    const row = rows[0];
    if (!row || row.deleted_at) { await send(chatId, '🗑️ Bill #' + n + ' is already gone.'); return true; }
    if (String(row.rep_chat_id) !== String(chatId)) {
      await send(chatId, '⚠️ Only the person who submitted bill #' + n + ' can delete it — tap 🗑️ Delete a bill again to pick one of yours.');
      return true;
    }
    await softDelete('expenses', { id });
    await send(chatId, '🗑️ *Bill deleted*\n\n🏪 *' + (row.merchant || 'Unknown') + '* — ' + fmtMoney(row.amount, row.currency));
    return true;
  } catch (e) {
    console.error('[bill-delete]', e && e.message);
    await send(chatId, '⚠️ Couldn\'t delete that bill right now. Please try again.');
    return true;
  }
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

  // Business-mode identity gate (ADR-021 Phase 5, issue #107): entirely inert when
  // capabilities.multiUser is off — the personal bot below is reached exactly as before,
  // byte-for-byte. When on, every chat must be bound via a one-time /start <token> deep
  // link before anything else runs (both cq and msg paths — a stranger must not be able
  // to act via a button tap any more than via a text message).
  const caps = (deps.getCapabilities || getCapabilities)();
  let businessBinding = null; // stays null in personal mode — every business branch below is inert
  if (caps.multiUser) {
    const text0 = msg ? (msg.text || '').trim() : '';
    const startMatch = /^\/start(?:@\S+)?(?:\s+(\S+))?/i.exec(text0);
    if (msg && startMatch && startMatch[1]) {
      const result = await (deps.bindWithToken || bindWithToken)(startMatch[1], chatId, deps);
      if (!result.ok) { await send(chatId, result.message); return; }
      await send(chatId, result.role === 'admin' ? BUSINESS_WELCOME_ADMIN : BUSINESS_WELCOME_CLERK, MAIN_MENU_KEYBOARD);
      return;
    }
    businessBinding = await (deps.resolveBinding || resolveBinding)(chatId, deps);
    if (!businessBinding) {
      if (cq) { await (deps.tgAnswerCallback || tgAnswerCallback)(cq.id); return; }
      await send(chatId, BUSINESS_UNBOUND_MESSAGE);
      return;
    }
    // Bound: fall through to the normal routing below with the binding in hand —
    // uploads tag branch_id (+ the staff picker), today's-bills/weekly scope by branch.
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

  // Multi-photo batch: buffer this photo under its media_group_id, (re)arm the debounce.
  // Checked BEFORE the single-photo branch so grouped photos don't each start their own flow.
  if (msg.media_group_id && bestPhotoFileId(msg)) {
    const id = String(msg.media_group_id);
    let g = groups.get(id);
    if (!g) {
      // branchId/companyId (business only): pinned on the group at creation so the whole
      // album is attributed to the capturing chat's branch + company when it flushes.
      // null in personal mode.
      g = { chatId, repName, fileIds: [], fileUniqueIds: [], timer: null,
        branchId: businessBinding ? businessBinding.branch_id : null,
        companyId: businessBinding ? businessBinding.company_id : null };
      groups.set(id, g);
      // Immediate reassurance on the FIRST photo of the album, so the chat isn't silent
      // while the debounce + AI read run. Sent once per group; the summary follows.
      await send(chatId, '🧾 *Got your receipts — reading them all now…*\nPlease hold on a moment 🙏');
    }
    // fileUniqueIds stays index-aligned with fileIds (issue #152 exact-resend detection —
    // each image's own stable id, distinct from file_id which isn't stable across resends).
    if (g.fileIds.length < cap) { g.fileIds.push(bestPhotoFileId(msg)); g.fileUniqueIds.push(bestPhotoFileUniqueId(msg)); }
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

  // Single photo/image: in business mode the receipt is tagged with the binding's branch
  // and, once saved, followed by the "which staff?" picker (sendStaffPicker no-ops when
  // the branch has no staff directory yet). Personal mode: no branch/company/staff meta —
  // byte-for-byte the old behaviour (issue #152's file_unique_id is the one thing now
  // always passed, personal or business, since exact-resend detection applies to both).
  const photoFileId = (Array.isArray(msg.photo) && msg.photo.length) ? msg.photo[msg.photo.length - 1].file_id
    : (msg.document && /^image\//i.test(msg.document.mime_type || '')) ? msg.document.file_id : null;
  if (photoFileId) {
    await send(chatId, '🧾 *Reading your receipt…*\nPlease hold on a moment 🙏');
    const bm = businessBinding ? bindingMeta(businessBinding) : {};
    const meta = { ...bm, file_unique_id: bestPhotoFileUniqueId(msg) };
    const res = await (deps.expenseFromPhoto || expenseFromPhoto)(chatId, repName, photoFileId, meta);
    if (businessBinding && res && res.ok && res.expense) {
      await (deps.sendStaffPicker || sendStaffPicker)(chatId, res.expense, businessBinding.branch_id, deps);
    }
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
  if (/^\/start/i.test(text)) { await send(chatId, WELCOME, MAIN_MENU_KEYBOARD); return; }
  // Owner request 2026-07-04: the 4 persistent menu buttons (MAIN_MENU_KEYBOARD) send
  // their exact label text like a normal message — matched here, BEFORE the generic
  // expense-keyword regex below, since "💰 Today Expenses" would otherwise also match that
  // regex and go to the wrong handler (sendExpenseSummary instead of handleTodayExpenses).
  if (text === '📋 Today Bills') { await (deps.handleTodayBills || handleTodayBills)(chatId, deps, businessBinding); return; }
  if (text === '💰 Today Expenses') { await (deps.handleTodayExpenses || handleTodayExpenses)(chatId, deps, businessBinding); return; }
  if (text === '📅 Weekly Record') { await (deps.handleWeeklyRecord || handleWeeklyRecord)(chatId, deps, businessBinding); return; }
  if (text === '🧭 Bot Guide') { await send(chatId, BOT_GUIDE_TEXT); return; }
  if (/expense|spent|show|list|total|report|summary/i.test(text)) { await sendExpenseSummary(chatId); return; }
  // Recognise "delete" intent so the reply actually answers what was asked, instead of
  // the generic photo prompt (which reads as if the bot ignored the message entirely).
  if (/delete|remove|undo|cancel/i.test(text)) {
    await (deps.handleDeleteIntent || handleDeleteIntent)(chatId, deps);
    return;
  }
  await send(chatId, '🤔 I didn\'t quite catch that, but I\'m great with receipts!\n\n📸 Send me a photo (or a few at once) and I\'ll log them for you.');
}

module.exports = { handleUpdate, sendExpenseSummary, flushGroup, handlePdfDocument, formatBatchSummary, handleDeleteIntent, handleCallbackQuery, tryResolveRemark, tryResolveDate, tryResolveBillDelete, handleTodayBills, handleTodayExpenses, handleWeeklyRecord, todayISO_MYT, weekStartISO_MYT, mytDayBoundsUTC, mytWeekStartBoundUTC, MAIN_MENU_KEYBOARD, BOT_GUIDE_TEXT, WELCOME,
  // Business-mode identity (ADR-021 Phase 5, issue #107)
  resolveBinding, bindWithToken, mytWeekStartSundayBoundUTC, weekStartSundayISO_MYT,
  BUSINESS_WELCOME_ADMIN, BUSINESS_WELCOME_CLERK, BUSINESS_UNBOUND_MESSAGE,
  // Business staff-tag picker + branch scoping (Phase 5 follow-up, issue #107)
  sendStaffPicker, branchEq,
  // Batch/album staff attribution wizard (issue #152 part 1)
  startBatchStaffWizard };

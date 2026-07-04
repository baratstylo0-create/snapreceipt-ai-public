'use strict';
const { cfg } = require('./config');
const { sbSelect, sbUpdate, sbSoftDelete } = require('./supabase');
const { tgSend, tgEditMessage, tgFileUrl, tgAnswerCallback } = require('./telegram');
const { hreq } = require('./http');
const { fmtMoney } = require('./money');
const { expenseFromPhoto, extractReceipts, assembleExpense, categoryPromptText, buildCategoryKeyboard, PENDING_CATEGORY } = require('./ocr');
const { CATEGORIES } = require('./categorize');
const { getFieldSpec } = require('./templates');
const { runBatch } = require('./massupload');
const { rasterizePdf } = require('./pdf');

const WELCOME = '👋 *Receipt Analyser*\n\nSend me a *photo of any receipt or invoice* and I\'ll read it, extract the merchant, amount, tax and line items, and log it automatically.\n\n• 📸 Snap a receipt → auto-logged\n• 🧾 Send *several photos at once* → all logged in one go\n• 💬 Type *"show expenses"* for a summary\n\nTry it now — send a receipt photo!\n\n_Use the buttons below any time._';

// Owner request 2026-07-04: a persistent, always-visible menu bar (a Telegram
// ReplyKeyboardMarkup — distinct from the inline "buttons attached to one message" kind
// used everywhere else in this file). Sent once on /start; Telegram keeps it visible for
// every message after that until explicitly replaced/removed, so it is NOT resent per-reply.
const MAIN_MENU_KEYBOARD = {
  keyboard: [
    ['📋 Today Bills', '💰 Today Expenses'],
    ['📅 Weekly Record', '🧭 Bot Guide'],
  ],
  resize_keyboard: true,
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
  try {
    const fileUrl = deps.tgFileUrl || tgFileUrl;
    const fetchSpec = deps.getFieldSpec || getFieldSpec;
    const batch = deps.runBatch || runBatch;
    const extract = deps.extractReceipts || extractReceipts;
    const assemble = deps.assembleExpense || assembleExpense;
    const fieldSpec = await fetchSpec();
    const images = [];
    for (const fid of g.fileIds) {
      try { const f = await fileUrl(fid); if (f && f.url) images.push(f.url); } catch { /* skip unresolvable photo */ }
    }
    if (!images.length) { await send(g.chatId, '📷 Couldn\'t download those photos. Please resend them.'); return; }
    // Option (A), decided with J1 (issue #31 tracks per-image links): one meta for the
    // batch, fileId:null — consistent with the dashboard adapter; assembleExpense tolerates null.
    const meta = { chatId: g.chatId, repName: g.repName, fileId: null };
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
      } else if (res && res.awaitingCategory) {
        awaitingPicks.push(res);
      } else if (res && res.expense) {
        const e = res.expense;
        saved.push({ merchant: e.merchant, amount: e.amount, currency: e.currency, category: e.category, voucher_no: e.voucher_no, flagged: !!res.flagged });
      }
      return res;
    };
    const summary = await batch(images, fieldSpec, { extractReceipts: extract, assembleExpense: captureAssemble, meta });
    await send(g.chatId, formatBatchSummary(summary, saved, skippedReasons, awaitingPicks.length));
    // One separate follow-up prompt+keyboard per uncertain receipt (matches the Owner's
    // own example: 5 photos, 3 confident -> one summary, 2 uncertain -> two more messages).
    for (const res of awaitingPicks) {
      await send(g.chatId, categoryPromptText(res.expense), buildCategoryKeyboard(res.expense.id, res.categoryOptions));
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
async function handlePdfDocument(chatId, repName, fileId, deps = {}) {
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
    const meta = { chatId, repName, fileId: null }; // option A (issue #31): single meta, no per-page link
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

  if (data === 'del:cancel') {
    await answer(cq.id);
    await send(chatId, '👍 Kept it — no changes.');
    return;
  }
  if (data.indexOf('del:') === 0) {
    const id = data.slice(4);
    try {
      const rows = await select('expenses', { eq: { id } });
      const row = rows[0];
      if (!row || row.deleted_at) {
        await answer(cq.id, { text: 'Already gone' });
        await send(chatId, '🗑️ That receipt is already deleted.');
        return;
      }
      if (String(row.rep_chat_id) !== String(chatId)) {
        await answer(cq.id, { text: 'Not yours' });
        await send(chatId, '⚠️ Can\'t delete that one from here.');
        return;
      }
      await softDelete('expenses', { id });
      await answer(cq.id, { text: 'Deleted' });
      await send(chatId, '🗑️ Deleted: *' + (row.merchant || 'Unknown') + '* — ' + fmtMoney(row.amount, row.currency));
    } catch (e) {
      console.error('[delete confirm]', e.message);
      await answer(cq.id);
      await send(chatId, '⚠️ Couldn\'t delete that receipt. Please try again from your dashboard.');
    }
    return;
  }
  // Category-picker button tap (Owner request 2026-07-03). Re-checks ownership + that
  // the row is STILL awaiting a pick at CONFIRM time (mirrors the delete flow's
  // re-authorization pattern) — a stale/double-tapped button is refused gracefully,
  // never double-applied. 'catpick:<id>:<index>' picks a real category by its index
  // into CATEGORIES; 'catpick:<id>:others' instead asks for a typed remark (resolved by
  // handleUpdate's pending-remark check, not here — this only flips the row's status).
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
      const idx = Number(selector);
      const category = Number.isInteger(idx) ? CATEGORIES[idx] : null;
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
      const kb = buildCategoryKeyboard(id, CATEGORIES);
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
// dated today (Malaysia time), account-wide (not scoped to this chat — matches
// sendExpenseSummary's existing account-wide behavior). Each bill gets its own "❌"
// delete-ask button (handleCallbackQuery's `delask:` branch); tapping it re-checks
// ownership BEFORE showing the confirm prompt, and confirming reuses the existing,
// already-tested `del:<id>` flow — deletion stays scoped to the ORIGINAL submitter only
// (Owner's explicit choice), even though the list itself shows everyone's bills.
async function handleTodayBills(chatId, deps = {}) {
  const send = deps.tgSend || tgSend;
  const select = deps.sbSelect || sbSelect;
  const today = (deps.todayISO || todayISO_MYT)();
  try {
    const rows = await select('expenses', { extra: 'deleted_at=is.null&expense_date=eq.' + today, order: 'created_at.desc' });
    if (!rows.length) { await send(chatId, '📋 *Today\'s Bills* (' + today + ')\n\nNothing captured yet today.'); return; }
    const cur = rows[0].currency || cfg.DEFAULT_CURRENCY;
    const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
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
// handleTodayBills (Malaysia time).
async function handleTodayExpenses(chatId, deps = {}) {
  const send = deps.tgSend || tgSend;
  const select = deps.sbSelect || sbSelect;
  const today = (deps.todayISO || todayISO_MYT)();
  try {
    const rows = await select('expenses', { extra: 'deleted_at=is.null&expense_date=eq.' + today });
    const cur = (rows[0] && rows[0].currency) || cfg.DEFAULT_CURRENCY;
    const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    await send(chatId, '💰 *Today\'s Expenses* (' + today + ')\n\n' + plural(rows.length, 'bill') + ' · *' + fmtMoney(total, cur) + '*');
  } catch (e) { console.error('[today-expenses]', e.message); await send(chatId, '⚠️ Could not load today\'s total right now.'); }
}

// "📅 Weekly Record" menu button — this week's total, Monday through today, Malaysia time.
async function handleWeeklyRecord(chatId, deps = {}) {
  const send = deps.tgSend || tgSend;
  const select = deps.sbSelect || sbSelect;
  const today = (deps.todayISO || todayISO_MYT)();
  const weekStart = (deps.weekStartISO || weekStartISO_MYT)();
  try {
    const rows = await select('expenses', { extra: 'deleted_at=is.null&expense_date=gte.' + weekStart + '&expense_date=lte.' + today });
    const cur = (rows[0] && rows[0].currency) || cfg.DEFAULT_CURRENCY;
    const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    await send(chatId, '📅 *Weekly Record* (' + weekStart + ' to ' + today + ')\n\n' + plural(rows.length, 'bill') + ' · *' + fmtMoney(total, cur) + '*');
  } catch (e) { console.error('[weekly-record]', e.message); await send(chatId, '⚠️ Could not load this week\'s total right now.'); }
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
      g = { chatId, repName, fileIds: [], timer: null };
      groups.set(id, g);
      // Immediate reassurance on the FIRST photo of the album, so the chat isn't silent
      // while the debounce + AI read run. Sent once per group; the summary follows.
      await send(chatId, '🧾 *Got your receipts — reading them all now…*\nPlease hold on a moment 🙏');
    }
    if (g.fileIds.length < cap) g.fileIds.push(bestPhotoFileId(msg));
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
    await (deps.handlePdfDocument || handlePdfDocument)(chatId, repName, msg.document.file_id, deps);
    return;
  }

  if (Array.isArray(msg.photo) && msg.photo.length) {
    await send(chatId, '🧾 *Reading your receipt…*\nPlease hold on a moment 🙏');
    await (deps.expenseFromPhoto || expenseFromPhoto)(chatId, repName, msg.photo[msg.photo.length - 1].file_id);
    return;
  }
  if (msg.document && /^image\//i.test(msg.document.mime_type || '')) {
    await send(chatId, '🧾 *Reading your receipt…*\nPlease hold on a moment 🙏');
    await (deps.expenseFromPhoto || expenseFromPhoto)(chatId, repName, msg.document.file_id);
    return;
  }

  const text = (msg.text || '').trim();
  // Owner request 2026-07-03: if this chat tapped "Others" on a category picker and is
  // now expected to type a short note, the NEXT plain-text message is treated as that
  // remark — checked BEFORE /start etc. so it isn't swallowed by the generic keyword
  // routing below. Any text (even one that looks like a command) is consumed as the
  // remark while a row is pending — kept deliberately simple, no special-casing.
  if (text && await (deps.tryResolveRemark || tryResolveRemark)(chatId, text, deps)) return;
  if (/^\/start/i.test(text)) { await send(chatId, WELCOME, MAIN_MENU_KEYBOARD); return; }
  // Owner request 2026-07-04: the 4 persistent menu buttons (MAIN_MENU_KEYBOARD) send
  // their exact label text like a normal message — matched here, BEFORE the generic
  // expense-keyword regex below, since "💰 Today Expenses" would otherwise also match that
  // regex and go to the wrong handler (sendExpenseSummary instead of handleTodayExpenses).
  if (text === '📋 Today Bills') { await (deps.handleTodayBills || handleTodayBills)(chatId, deps); return; }
  if (text === '💰 Today Expenses') { await (deps.handleTodayExpenses || handleTodayExpenses)(chatId, deps); return; }
  if (text === '📅 Weekly Record') { await (deps.handleWeeklyRecord || handleWeeklyRecord)(chatId, deps); return; }
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

module.exports = { handleUpdate, sendExpenseSummary, flushGroup, handlePdfDocument, formatBatchSummary, handleDeleteIntent, handleCallbackQuery, tryResolveRemark, handleTodayBills, handleTodayExpenses, handleWeeklyRecord, todayISO_MYT, weekStartISO_MYT, MAIN_MENU_KEYBOARD, BOT_GUIDE_TEXT, WELCOME };

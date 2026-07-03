'use strict';
const { cfg } = require('./config');
const { sbSelect } = require('./supabase');
const { tgSend, tgFileUrl } = require('./telegram');
const { hreq } = require('./http');
const { fmtMoney } = require('./money');
const { expenseFromPhoto, extractReceipts, assembleExpense } = require('./ocr');
const { getFieldSpec } = require('./templates');
const { runBatch } = require('./massupload');
const { rasterizePdf } = require('./pdf');

const WELCOME = '👋 *Receipt Analyser*\n\nSend me a *photo of any receipt or invoice* and I\'ll read it, extract the merchant, amount, tax and line items, and log it automatically.\n\n• 📸 Snap a receipt → auto-logged\n• 🧾 Send *several photos at once* → all logged in one go\n• 💬 Type *"show expenses"* for a summary\n\nTry it now — send a receipt photo!';

// #7 Telegram multi-photo: a media group arrives as N SEPARATE webhook updates that
// share a media_group_id, milliseconds apart. We buffer them (keyed by group id),
// debounce, then run the whole group through the shared runBatch() ONCE and reply with
// a single summary. Single-photo flow is unchanged. In-memory buffer = single-process
// v1 (documented in the spec); a group mid-arrival during a restart is best-effort.
const GROUP_DEBOUNCE_MS = Number(process.env.MASS_GROUP_DEBOUNCE_MS || '2000') || 2000;
const MAX_GROUP_IMAGES = Number(process.env.MASS_MAX_IMAGES || '10') || 10;
const groups = new Map(); // media_group_id -> { chatId, repName, fileIds:[], timer }

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

// User-facing batch summary. `saved` (optional) is a list of the receipts that were
// actually logged — {merchant, amount, currency, category, flagged} — so we can show a
// per-receipt breakdown, not just counts. It's our OWN saved data (merchant/amount from
// the receipt), never the raw failed[].reason error text (that stays hidden — SOP §7.2).
function formatBatchSummary(summary, saved) {
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const parts = [plural(summary.images, 'photo'), plural(summary.receipts, 'receipt'), summary.saved + ' saved'];
  if (summary.flagged.length) parts.push(summary.flagged.length + ' need review');
  if (summary.failed.length) parts.push(summary.failed.length + ' couldn\'t read');
  let text = '✅ *Batch processed*\n\n' + parts.join(' · ');
  if (Array.isArray(saved) && saved.length) {
    const MAX = 15; // keep the message tidy / under Telegram's length cap
    text += '\n';
    saved.slice(0, MAX).forEach((s, i) => {
      text += '\n' + (i + 1) + '. *' + (s.merchant || 'Unknown') + '* — ' + fmtMoney(s.amount, s.currency)
        + ' · ' + (s.category || 'Others') + (s.flagged ? ' ⚠️' : '');
    });
    if (saved.length > MAX) text += '\n_…and ' + (saved.length - MAX) + ' more._';
  }
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
    const captureAssemble = async (args) => {
      const res = await assemble(args);
      if (res && res.expense) {
        const e = res.expense;
        saved.push({ merchant: e.merchant, amount: e.amount, currency: e.currency, category: e.category, flagged: !!res.flagged });
      }
      return res;
    };
    const summary = await batch(images, fieldSpec, { extractReceipts: extract, assembleExpense: captureAssemble, meta });
    await send(g.chatId, formatBatchSummary(summary, saved));
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
    const summary = await batch(images, fieldSpec, { extractReceipts: extract, assembleExpense: assemble, meta });
    let text = formatBatchSummary(summary);
    if (pagesTruncated) text += '\n\n_This PDF had more pages than I could read at once._';
    await send(chatId, text);
  } catch (e) {
    console.error('[pdf]', e && e.message);
    await send(chatId, '📄 Couldn\'t read that PDF. Please resend a clearer scan.');
  }
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

// deps is optional and injected only by tests (setTimeout/clearTimeout/runBatch/etc.);
// production calls handleUpdate(update) and everything defaults to the real modules.
async function handleUpdate(update, deps = {}) {
  const msg = update.message || update.edited_message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const repName = (msg.from && (msg.from.first_name || msg.from.username)) || 'User';
  const send = deps.tgSend || tgSend;

  // Access allowlist: when configured, only listed chat IDs may use the bot.
  const allow = deps.allowedChatIds || ALLOWED_CHAT_IDS;
  if (allow.length && !allow.includes(String(chatId))) {
    console.warn('[access] denied chat id', chatId);
    await send(chatId, '🔒 Sorry, this is a private bot. Please ask the owner to give you access.');
    return;
  }
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
  if (/^\/start/i.test(text)) { await send(chatId, WELCOME); return; }
  if (/expense|spent|show|list|total|report|summary/i.test(text)) { await sendExpenseSummary(chatId); return; }
  await send(chatId, '📸 Send me a photo of a receipt and I\'ll log it for you.');
}

module.exports = { handleUpdate, sendExpenseSummary, flushGroup, handlePdfDocument, formatBatchSummary, WELCOME };

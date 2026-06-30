'use strict';
const { cfg } = require('./config');
const { sbSelect } = require('./supabase');
const { tgSend } = require('./telegram');
const { fmtMoney } = require('./money');
const { expenseFromPhoto } = require('./ocr');

const WELCOME = '👋 *Receipt Analyser*\n\nSend me a *photo of any receipt or invoice* and I\'ll read it, extract the merchant, amount, tax and line items, and log it automatically.\n\n• 📸 Snap a receipt → auto-logged\n• 💬 Type *"show expenses"* for a summary\n\nTry it now — send a receipt photo!';

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

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const repName = (msg.from && (msg.from.first_name || msg.from.username)) || 'User';

  if (Array.isArray(msg.photo) && msg.photo.length) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    await tgSend(chatId, '🧾 Reading your receipt…');
    await expenseFromPhoto(chatId, repName, fileId);
    return;
  }
  if (msg.document && /^image\//i.test(msg.document.mime_type || '')) {
    await tgSend(chatId, '🧾 Reading your receipt…');
    await expenseFromPhoto(chatId, repName, msg.document.file_id);
    return;
  }

  const text = (msg.text || '').trim();
  if (/^\/start/i.test(text)) { await tgSend(chatId, WELCOME); return; }
  if (/expense|spent|show|list|total|report|summary/i.test(text)) { await sendExpenseSummary(chatId); return; }
  await tgSend(chatId, '📸 Send me a photo of a receipt and I\'ll log it for you.');
}

module.exports = { handleUpdate, sendExpenseSummary, WELCOME };

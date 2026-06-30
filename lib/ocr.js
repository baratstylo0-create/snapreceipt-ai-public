'use strict';
const { cfg } = require('./config');
const { groqVision } = require('./groq');
const { sbInsert } = require('./supabase');
const { tgSend, tgFileUrl } = require('./telegram');
const { fmtMoney, normaliseDate } = require('./money');
const { normaliseExpenseCategory } = require('./categorize');

// Receipt photo → OCR → expense row. Behaviour preserved from server.js:106-161.
async function expenseFromPhoto(chatId, repName, fileId) {
  try {
    const file = await tgFileUrl(fileId);
    if (!file) throw new Error('no file path');

    const prompt = 'Extract ALL data from this receipt/invoice. Return JSON ONLY (no prose): {"merchant":"","date":"YYYY-MM-DD","line_items":[{"description":"","qty":1,"price":0}],"subtotal":0,"tax":0,"total":0,"currency":"' + cfg.DEFAULT_CURRENCY + '","category":"Food|Transport|Software|Inventory|Office|Other"}. tax = the tax/GST amount shown. subtotal = pre-tax amount. total = grand total including tax. price = per-line amount. Use 0 for any value not visible.';
    const content = await groqVision(file.url, prompt, { max_tokens: 900 });

    let ex = {};
    try { const m = content.match(/\{[\s\S]*\}/); if (m) ex = JSON.parse(m[0]); } catch (e) {}

    const items = Array.isArray(ex.line_items) ? ex.line_items : [];
    const total = Number(ex.total) || Number(ex.amount) || 0;
    let sub = Number(ex.subtotal) || 0;
    let tax = Number(ex.tax) || Number(ex.gst) || 0;
    const cur = /^[A-Za-z]{3}$/.test(String(ex.currency || '').trim()) ? String(ex.currency).trim().toUpperCase() : cfg.DEFAULT_CURRENCY;
    if (!sub && total) sub = cfg.DEFAULT_TAX_RATE ? Math.round((total / (1 + cfg.DEFAULT_TAX_RATE)) * 100) / 100 : total;
    if (!tax && total) tax = cfg.DEFAULT_TAX_RATE ? Math.round((total - sub) * 100) / 100 : 0;

    const expense = {
      rep_chat_id: String(chatId), rep_name: repName,
      merchant: ex.merchant || 'Unknown', expense_date: normaliseDate(ex.date), amount: total, currency: cur,
      category: normaliseExpenseCategory(ex.category), subtotal: sub, tax,
      line_items: items, receipt_file_id: fileId, ai_raw: ex, status: 'saved'
    };
    await sbInsert('expenses', expense);

    const itemsTxt = items.length
      ? ('\n📝 *Items:*\n' + items.slice(0, 10).map(it => '  • ' + (it.description || 'item') + ((Number(it.qty) || 1) > 1 ? (' ×' + it.qty) : '') + ' — ' + fmtMoney(Number(it.price) || 0, cur)).join('\n'))
      : '';
    const totalsTxt = cfg.DEFAULT_TAX_RATE
      ? ('\n\n💵 *Subtotal:* ' + fmtMoney(sub, cur) + '\n🧾 *Tax:* ' + fmtMoney(tax, cur) + '\n💰 *Total:* ' + fmtMoney(total, cur))
      : ('\n\n💰 *Total:* ' + fmtMoney(total, cur));

    await tgSend(chatId, '✅ *Expense Captured*\n\n🏪 *Merchant:* ' + expense.merchant + '\n📅 *Date:* ' + expense.expense_date + itemsTxt + totalsTxt + '\n📂 *Category:* ' + expense.category + '\n\n_Open your dashboard to see all expenses._');
    return true;
  } catch (e) {
    console.error('[expenseFromPhoto]', e.message);
    await tgSend(chatId, '📷 Got the receipt but couldn\'t read it clearly. Please resend a sharper photo.');
    return false;
  }
}

module.exports = { expenseFromPhoto };

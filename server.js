/**
 * Receipt Analyser SaaS — standalone server
 * ------------------------------------------
 * Telegram bot: send a receipt photo → Groq vision OCR → parsed expense saved to Supabase.
 * Dashboard:    /  → Expenses page (cards/table, filters, CSV, receipt thumbnails).
 * API:          GET /api/expenses, GET /receipt/:fileId (Telegram image proxy).
 *
 * Single-account v1. Multi-tenant SaaS layer can be added later (see CLAUDE.md).
 * Only deps: express + dotenv. Uses Node 20 native fetch / Buffer.
 */
'use strict';
require('dotenv').config();
const express = require('express');
const path = require('path');

// ──────────────────────────────────────────────────────────────────────────
// Config (all from .env — nothing hardcoded)
// ──────────────────────────────────────────────────────────────────────────
const BOT_TOKEN       = process.env.BOT_TOKEN;
const GROQ_KEY        = process.env.GROQ_KEY;
const SB_URL          = (process.env.SB_URL || '').replace(/\/$/, '');   // https://<project>.supabase.co
const SB_KEY          = process.env.SB_KEY;                              // service-role key (server-side only)
const PUBLIC_URL      = (process.env.PUBLIC_URL || '').replace(/\/$/, ''); // https://yourdomain — for auto webhook
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || '';               // Telegram secret_token header
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';              // optional API/dashboard gate
const ACCOUNT_ID      = process.env.ACCOUNT_ID || 'default';            // single-account scope key
const DEFAULT_CURRENCY= (process.env.DEFAULT_CURRENCY || 'USD').toUpperCase();
const DEFAULT_TAX_RATE= Number(process.env.DEFAULT_TAX_RATE || '0') || 0; // e.g. 0.10 for 10% GST
const VISION_MODEL    = process.env.VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const PORT            = Number(process.env.PORT || '3001');

const SB_REST = SB_URL + '/rest/v1';
const sbH = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

// Startup guard — surface missing secrets loudly instead of failing silently.
['BOT_TOKEN', 'GROQ_KEY', 'SB_URL', 'SB_KEY'].forEach(k => {
  if (!process.env[k]) console.error('[FATAL] Missing env var:', k, '— the app will not work correctly until this is set in .env');
});

// ──────────────────────────────────────────────────────────────────────────
// Small HTTP helper (native fetch + timeout + json/arraybuffer)
// ──────────────────────────────────────────────────────────────────────────
async function hreq({ method = 'GET', url, headers = {}, body, json, timeout = 20000, encoding } = {}) {
  const opt = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeout) };
  if (body !== undefined) {
    opt.body = json ? JSON.stringify(body) : body;
    if (json && !opt.headers['Content-Type']) opt.headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(url, opt);
  if (encoding === 'arraybuffer') return Buffer.from(await r.arrayBuffer());
  const text = await r.text();
  if (json) { try { return JSON.parse(text); } catch { return text; } }
  return text;
}

// Groq chat with exponential backoff for 429s.
async function groqChat(messages, { model = VISION_MODEL, max_tokens = 900, temperature = 0.1 } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await hreq({
        method: 'POST', url: 'https://api.groq.com/openai/v1/chat/completions',
        headers: { Authorization: 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' },
        body: { model, messages, max_tokens, temperature }, json: true, timeout: 30000
      });
      if (r && r.choices && r.choices[0]) return (r.choices[0].message && r.choices[0].message.content) || '';
      if (r && r.error && /rate|429|too many/i.test(JSON.stringify(r.error))) throw new Error('429');
      return '';
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(s => setTimeout(s, 1000 * (attempt + 1)));
    }
  }
  return '';
}

// ──────────────────────────────────────────────────────────────────────────
// Domain helpers
// ──────────────────────────────────────────────────────────────────────────
function normaliseExpenseCategory(raw) {
  const r = String(raw || '').toLowerCase();
  if (/fuel|petrol|gas|diesel|transport|toll|parking|uber|taxi|cab|mileage|car\b/.test(r)) return 'Petrol';
  if (/food|meal|lunch|dinner|breakfast|cafe|café|restaurant|coffee|grill|catering|drink|snack/.test(r)) return 'Food';
  if (/software|app\b|subscription|saas|licen[cs]e|cloud|hosting|domain/.test(r)) return 'Software';
  if (/inventory|stock|parts|materials|equipment|hardware|supplies|tools/.test(r)) return 'Inventory';
  return 'Others';
}

const CUR_SYM = { USD: '$', AUD: 'A$', NZD: 'NZ$', SGD: 'S$', MYR: 'RM', EUR: '€', GBP: '£', INR: '₹', JPY: '¥', CAD: 'C$' };
const curSym = c => CUR_SYM[String(c || '').toUpperCase()] || (String(c || '').toUpperCase() + ' ');
const fmtMoney = (v, c) => curSym(c) + (Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function todayISO() { return new Date().toISOString().slice(0, 10); }

async function tgSend(chatId, text, replyMarkup) {
  try {
    await hreq({
      method: 'POST', url: 'https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', json: true,
      body: { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }
    });
  } catch (e) { console.error('[tgSend]', e.message); }
}

// ──────────────────────────────────────────────────────────────────────────
// Core: receipt photo → OCR → expense row
// ──────────────────────────────────────────────────────────────────────────
async function expenseFromPhoto(chatId, repName, fileId) {
  try {
    const f = await hreq({ url: 'https://api.telegram.org/bot' + BOT_TOKEN + '/getFile?file_id=' + fileId, json: true, timeout: 8000 });
    const photoUrl = 'https://api.telegram.org/file/bot' + BOT_TOKEN + '/' + f.result.file_path;

    const content = await groqChat([{
      role: 'user',
      content: [
        { type: 'text', text: 'Extract ALL data from this receipt/invoice. Return JSON ONLY (no prose): {"merchant":"","date":"YYYY-MM-DD","line_items":[{"description":"","qty":1,"price":0}],"subtotal":0,"tax":0,"total":0,"currency":"' + DEFAULT_CURRENCY + '","category":"Food|Transport|Software|Inventory|Office|Other"}. tax = the tax/GST amount shown. subtotal = pre-tax amount. total = grand total including tax. price = per-line amount. Use 0 for any value not visible.' },
        { type: 'image_url', image_url: { url: photoUrl } }
      ]
    }], { max_tokens: 900, temperature: 0.1 });

    let ex = {};
    try { const m = content.match(/\{[\s\S]*\}/); if (m) ex = JSON.parse(m[0]); } catch (e) {}

    const items = Array.isArray(ex.line_items) ? ex.line_items : [];
    const total = Number(ex.total) || Number(ex.amount) || 0;
    let sub = Number(ex.subtotal) || 0;
    let tax = Number(ex.tax) || Number(ex.gst) || 0;
    const cur = /^[A-Za-z]{3}$/.test(String(ex.currency || '').trim()) ? String(ex.currency).trim().toUpperCase() : DEFAULT_CURRENCY;
    if (!sub && total) sub = DEFAULT_TAX_RATE ? Math.round((total / (1 + DEFAULT_TAX_RATE)) * 100) / 100 : total;
    if (!tax && total) tax = DEFAULT_TAX_RATE ? Math.round((total - sub) * 100) / 100 : 0;

    // Normalise date to ISO so the column never rejects it.
    let date = String(ex.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const m = date.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/); // assume DD/MM/YYYY
      date = m ? (m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0')) : todayISO();
    }
    // Guard: some receipts misprint the date in the future — cap to today so the row isn't hidden by month filters.
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date > todayISO()) date = todayISO();

    const expense = {
      account_id: ACCOUNT_ID, rep_chat_id: String(chatId), rep_name: repName,
      merchant: ex.merchant || 'Unknown', expense_date: date, amount: total, currency: cur,
      category: normaliseExpenseCategory(ex.category), subtotal: sub, tax: tax,
      line_items: items, receipt_file_id: fileId, ai_raw: ex, status: 'saved'
    };
    await hreq({ method: 'POST', url: SB_REST + '/expenses', headers: { ...sbH, Prefer: 'return=minimal' }, body: expense, json: true });

    const itemsTxt = items.length
      ? ('\n📝 *Items:*\n' + items.slice(0, 10).map(it => '  • ' + (it.description || 'item') + ((Number(it.qty) || 1) > 1 ? (' ×' + it.qty) : '') + ' — ' + fmtMoney(Number(it.price) || 0, cur)).join('\n'))
      : '';
    const totalsTxt = DEFAULT_TAX_RATE
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

async function sendExpenseSummary(chatId) {
  try {
    const rows = await hreq({ url: SB_REST + '/expenses?account_id=eq.' + encodeURIComponent(ACCOUNT_ID) + '&order=created_at.desc&limit=10', headers: sbH, json: true });
    if (!Array.isArray(rows) || !rows.length) { await tgSend(chatId, '📭 No expenses logged yet. Send me a receipt photo to get started!'); return; }
    const cur = rows[0].currency || DEFAULT_CURRENCY;
    const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const lines = rows.slice(0, 8).map(r => '• *' + (r.merchant || 'Unknown') + '* — ' + fmtMoney(r.amount, r.currency || cur) + '  _(' + r.category + ')_').join('\n');
    await tgSend(chatId, '🧾 *Recent Expenses*\n\n' + lines + '\n\n💰 *Last 10 total:* ' + fmtMoney(total, cur));
  } catch (e) { console.error('[summary]', e.message); await tgSend(chatId, '⚠️ Could not load expenses right now.'); }
}

// ──────────────────────────────────────────────────────────────────────────
// Telegram update router
// ──────────────────────────────────────────────────────────────────────────
const WELCOME =
  '👋 *Receipt Analyser*\n\nSend me a *photo of any receipt or invoice* and I\'ll read it, extract the merchant, amount, tax and line items, and log it automatically.\n\n• 📸 Snap a receipt → auto-logged\n• 💬 Type *"show expenses"* for a summary\n\nTry it now — send a receipt photo!';

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const repName = (msg.from && (msg.from.first_name || msg.from.username)) || 'User';

  // Photo receipt
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const fileId = msg.photo[msg.photo.length - 1].file_id; // largest size
    await tgSend(chatId, '🧾 Reading your receipt…');
    await expenseFromPhoto(chatId, repName, fileId);
    return;
  }
  // Image sent as a document/file
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

// ──────────────────────────────────────────────────────────────────────────
// Express app
// ──────────────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', true);

// Telegram webhook
app.post('/webhook', express.json({ limit: '2mb' }), (req, res) => {
  if (WEBHOOK_SECRET && req.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) return res.sendStatus(401);
  res.sendStatus(200); // ack immediately so Telegram doesn't retry
  handleUpdate(req.body).catch(e => console.error('[handleUpdate]', e.message));
});

// Optional API gate (enabled only when DASHBOARD_TOKEN is set)
function checkDash(req, res, next) {
  if (!DASHBOARD_TOKEN) return next();
  const a = req.get('Authorization') || '';
  if (a === 'Bearer ' + DASHBOARD_TOKEN || req.query.key === DASHBOARD_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Expenses API (server holds the service key — no Supabase key ever reaches the browser)
app.get('/api/expenses', checkDash, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const rows = await hreq({ url: SB_REST + '/expenses?account_id=eq.' + encodeURIComponent(ACCOUNT_ID) + '&deleted_at=is.null&order=created_at.desc&limit=2000', headers: sbH, json: true });
    res.json(Array.isArray(rows) ? rows : []);
  } catch (e) { console.error('[api/expenses]', e.message); res.status(502).json({ error: 'load failed' }); }
});

// Edit an expense — whitelisted fields only (server holds the service key).
app.patch('/api/expenses/:id', checkDash, express.json({ limit: '1mb' }), async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const id = String(req.params.id || '');
    const allow = ['merchant', 'expense_date', 'amount', 'currency', 'category', 'status', 'remark', 'subtotal', 'tax'];
    const body = {};
    for (const k of allow) if (req.body && k in req.body) body[k] = req.body[k];
    if (!Object.keys(body).length) return res.status(400).json({ error: 'no fields to update' });
    const rows = await hreq({ method: 'PATCH', url: SB_REST + '/expenses?id=eq.' + encodeURIComponent(id) + '&account_id=eq.' + encodeURIComponent(ACCOUNT_ID), headers: { ...sbH, Prefer: 'return=representation' }, body, json: true });
    res.json(Array.isArray(rows) && rows[0] ? rows[0] : { ok: true });
  } catch (e) { console.error('[patch expense]', e.message); res.status(502).json({ error: 'update failed' }); }
});

// Soft-delete an expense — sets deleted_at (recoverable; never hard-deletes).
app.delete('/api/expenses/:id', checkDash, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const id = String(req.params.id || '');
    await hreq({ method: 'PATCH', url: SB_REST + '/expenses?id=eq.' + encodeURIComponent(id) + '&account_id=eq.' + encodeURIComponent(ACCOUNT_ID), headers: { ...sbH, Prefer: 'return=minimal' }, body: { deleted_at: new Date().toISOString() }, json: true });
    res.json({ ok: true });
  } catch (e) { console.error('[delete expense]', e.message); res.status(502).json({ error: 'delete failed' }); }
});

// Tells the dashboard whether a token is required (so it can prompt).
app.get('/api/config', (req, res) => {
  res.json({ auth_required: !!DASHBOARD_TOKEN, default_currency: DEFAULT_CURRENCY });
});

// Receipt image proxy — serves the Telegram file behind the bot token.
app.get('/receipt/:fileId', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const fileId = String(req.params.fileId || '').slice(0, 400);
    if (!fileId) return res.status(400).send('missing file_id');
    const f = await hreq({ url: 'https://api.telegram.org/bot' + BOT_TOKEN + '/getFile?file_id=' + encodeURIComponent(fileId), json: true, timeout: 8000 });
    const fp = (f && f.result && f.result.file_path) || '';
    if (!fp) return res.status(404).send('not found');
    const buf = await hreq({ url: 'https://api.telegram.org/file/bot' + BOT_TOKEN + '/' + fp, encoding: 'arraybuffer', timeout: 20000 });
    const ext = (fp.split('.').pop() || '').toLowerCase();
    res.set('Content-Type', ext === 'png' ? 'image/png' : ext === 'pdf' ? 'application/pdf' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) { console.error('[receipt proxy]', e.message); res.status(502).send('error'); }
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'receipt-saas', account: ACCOUNT_ID }));

// Static dashboard
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ──────────────────────────────────────────────────────────────────────────
// Telegram webhook auto-registration
// ──────────────────────────────────────────────────────────────────────────
async function registerWebhook() {
  if (!PUBLIC_URL) { console.log('[webhook] PUBLIC_URL not set — skipping auto-registration. Set it and restart, or register manually (see README).'); return; }
  try {
    const url = PUBLIC_URL + '/webhook';
    const body = { url, allowed_updates: ['message', 'edited_message'], drop_pending_updates: false };
    if (WEBHOOK_SECRET) body.secret_token = WEBHOOK_SECRET;
    const r = await hreq({ method: 'POST', url: 'https://api.telegram.org/bot' + BOT_TOKEN + '/setWebhook', json: true, body });
    console.log('[webhook]', r && r.ok ? ('registered → ' + url) : ('FAILED: ' + JSON.stringify(r)));
  } catch (e) { console.error('[webhook reg]', e.message); }
}

// `node server.js --register-only` registers the webhook then exits (no server).
if (process.argv.includes('--register-only')) {
  registerWebhook().then(() => process.exit(0));
} else {
  app.listen(PORT, () => {
    console.log('[receipt-saas] listening on :' + PORT + '  (account: ' + ACCOUNT_ID + ')');
    setTimeout(registerWebhook, 1500);
  });
}

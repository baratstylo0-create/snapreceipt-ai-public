# Modularize server.js Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the single-file `server.js` into focused `lib/` + `routes/` modules with the frozen interfaces from `docs/ARCHITECTURE.md` §3 — **without changing any runtime behavior** — so three Claude Codes can build features in parallel without collisions.

**Architecture:** Pure helpers (money/date, categorization) are extracted first with real unit tests. Then I/O modules (http, config, groq, supabase, telegram, ocr) are moved structurally. Finally `server.js` becomes wiring-only and `routes/*` hold the endpoints. A smoke test (`/health` boots, helpers imported) proves the refactor preserved behavior. No feature logic is added.

**Tech Stack:** Node 22 (native `fetch`/`Buffer`), Express, `node:test` + `node:assert` (built-in test runner — **no new dependency**), dotenv.

**Branch:** `feature/jeevan-p2-modularize-server` (off `main`). One PR at the end, reviewed by Barat, merged by Owner.

**Ownership note (ADR-001):** This is the one Owner-coordinated refactor that *establishes* files other people will own later. After it merges, the collision rule (edit only your files) takes effect.

---

## Pre-flight

- [ ] **Step 0.1: Sync and branch**

```bash
cd C:/Users/Asus/Downloads/receipt-analyser-saas
git fetch --all --prune
git checkout main && git pull
git checkout -b feature/jeevan-p2-modularize-server
```

- [ ] **Step 0.2: Add the built-in test runner script (no new deps)**

Modify `package.json` — add a `test` script:

```json
{
  "name": "receipt-saas",
  "version": "0.1.0",
  "description": "Receipt Analyser SaaS — Telegram bot OCR + expenses dashboard. Standalone, extracted from FrictionAI.",
  "main": "server.js",
  "type": "commonjs",
  "scripts": {
    "start": "node server.js",
    "setup-webhook": "node server.js --register-only",
    "test": "node --test"
  },
  "engines": { "node": ">=20" },
  "dependencies": { "dotenv": "^16.4.5", "express": "^4.19.2" }
}
```

- [ ] **Step 0.3: Commit the tooling**

```bash
git add package.json
git commit -m "chore: add node:test runner script (no new deps)"
```

---

## Task 1: Extract `lib/money.js` (pure money/date helpers) — TDD

**Files:**
- Create: `lib/money.js`
- Test: `tests/money.test.js`
- Modify (later, Task 9): `server.js` imports these

These move verbatim from `server.js:88-92` and the date logic in `server.js:131-137`.

- [ ] **Step 1.1: Write the failing test**

Create `tests/money.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { curSym, fmtMoney, todayISO, normaliseDate } = require('../lib/money');

test('curSym maps known currencies and falls back to CODE+space', () => {
  assert.strictEqual(curSym('USD'), '$');
  assert.strictEqual(curSym('myr'), 'RM');
  assert.strictEqual(curSym('XYZ'), 'XYZ ');
});

test('fmtMoney formats with two decimals and the right symbol', () => {
  assert.strictEqual(fmtMoney(1234.5, 'USD'), '$1,234.50');
  assert.strictEqual(fmtMoney(0, 'MYR'), 'RM0.00');
  assert.strictEqual(fmtMoney('not-a-number', 'USD'), '$0.00');
});

test('todayISO returns YYYY-MM-DD', () => {
  assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/);
});

test('normaliseDate passes ISO through, converts DD/MM/YYYY, caps future, falls back to today', () => {
  assert.strictEqual(normaliseDate('2026-06-12'), '2026-06-12');
  assert.strictEqual(normaliseDate('12/06/2026'), '2026-06-12');   // DD/MM/YYYY
  assert.strictEqual(normaliseDate('garbage'), todayISO());        // fallback
  assert.strictEqual(normaliseDate('2999-01-01'), todayISO());     // future capped
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/money'`.

- [ ] **Step 1.3: Implement `lib/money.js`**

```js
'use strict';
// Pure money + date helpers. Moved verbatim from server.js (no behaviour change).

const CUR_SYM = { USD: '$', AUD: 'A$', NZD: 'NZ$', SGD: 'S$', MYR: 'RM', EUR: '€', GBP: '£', INR: '₹', JPY: '¥', CAD: 'C$' };
const curSym = c => CUR_SYM[String(c || '').toUpperCase()] || (String(c || '').toUpperCase() + ' ');
const fmtMoney = (v, c) => curSym(c) + (Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function todayISO() { return new Date().toISOString().slice(0, 10); }

// Normalise a messy OCR date to ISO YYYY-MM-DD; assume DD/MM/YYYY; cap future to today; else today.
function normaliseDate(raw) {
  let date = String(raw || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const m = date.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    date = m ? (m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0')) : todayISO();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date > todayISO()) date = todayISO();
  return date;
}

module.exports = { CUR_SYM, curSym, fmtMoney, todayISO, normaliseDate };
```

- [ ] **Step 1.4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS (4 money tests green).

- [ ] **Step 1.5: Commit**

```bash
git add lib/money.js tests/money.test.js
git commit -m "refactor: extract pure money/date helpers into lib/money.js with tests"
```

---

## Task 2: Extract `lib/categorize.js` (category normalization) — TDD

**Files:**
- Create: `lib/categorize.js`
- Test: `tests/categorize.test.js`

Moves `normaliseExpenseCategory` from `server.js:79-86` verbatim. (This file is later OWNED by Jeevan for feature #6; here we only move the existing function.)

- [ ] **Step 2.1: Write the failing test**

Create `tests/categorize.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normaliseExpenseCategory } = require('../lib/categorize');

test('maps keywords to the canonical category set', () => {
  assert.strictEqual(normaliseExpenseCategory('Uber ride'), 'Petrol');
  assert.strictEqual(normaliseExpenseCategory('Lunch at cafe'), 'Food');
  assert.strictEqual(normaliseExpenseCategory('Adobe subscription'), 'Software');
  assert.strictEqual(normaliseExpenseCategory('spare parts'), 'Inventory');
  assert.strictEqual(normaliseExpenseCategory('mystery'), 'Others');
  assert.strictEqual(normaliseExpenseCategory(''), 'Others');
});
```

- [ ] **Step 2.2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/categorize'`.

- [ ] **Step 2.3: Implement `lib/categorize.js`**

```js
'use strict';
// Category normalization. Moved verbatim from server.js (no behaviour change).
// OWNER (post-refactor): Jeevan (#6 line-item categorization extends this file).

function normaliseExpenseCategory(raw) {
  const r = String(raw || '').toLowerCase();
  if (/fuel|petrol|gas|diesel|transport|toll|parking|uber|taxi|cab|mileage|car\b/.test(r)) return 'Petrol';
  if (/food|meal|lunch|dinner|breakfast|cafe|café|restaurant|coffee|grill|catering|drink|snack/.test(r)) return 'Food';
  if (/software|app\b|subscription|saas|licen[cs]e|cloud|hosting|domain/.test(r)) return 'Software';
  if (/inventory|stock|parts|materials|equipment|hardware|supplies|tools/.test(r)) return 'Inventory';
  return 'Others';
}

module.exports = { normaliseExpenseCategory };
```

- [ ] **Step 2.4: Run to verify it passes**

Run: `npm test`
Expected: PASS (money + categorize tests green).

- [ ] **Step 2.5: Commit**

```bash
git add lib/categorize.js tests/categorize.test.js
git commit -m "refactor: extract normaliseExpenseCategory into lib/categorize.js with tests"
```

---

## Task 3: Extract `lib/http.js` (the `hreq` helper)

**Files:**
- Create: `lib/http.js`
- Test: `tests/http.test.js`

Moves `hreq` from `server.js:43-54` verbatim. I/O helper — test only the argument-shaping we can check without a network call.

- [ ] **Step 3.1: Write a light test (no network)**

Create `tests/http.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { hreq } = require('../lib/http');

test('hreq is a function and rejects on an unreachable host quickly', async () => {
  assert.strictEqual(typeof hreq, 'function');
  await assert.rejects(
    () => hreq({ url: 'http://127.0.0.1:1/never', timeout: 200 }),
    /.*/
  );
});
```

- [ ] **Step 3.2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/http'`.

- [ ] **Step 3.3: Implement `lib/http.js`**

```js
'use strict';
// Native fetch + timeout helper. Moved verbatim from server.js (no behaviour change).

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

module.exports = { hreq };
```

- [ ] **Step 3.4: Run to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3.5: Commit**

```bash
git add lib/http.js tests/http.test.js
git commit -m "refactor: extract hreq into lib/http.js"
```

---

## Task 4: Extract `lib/config.js` (centralized env + model routes)

**Files:**
- Create: `lib/config.js`

Centralizes the config block from `server.js:19-33` and adds the model-routing map from `docs/ARCHITECTURE.md` §3.5 (reading the new `.env` keys, with the existing defaults).

- [ ] **Step 4.1: Implement `lib/config.js`**

```js
'use strict';
require('dotenv').config();

const cfg = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  GROQ_KEY: process.env.GROQ_KEY,
  SB_URL: (process.env.SB_URL || '').replace(/\/$/, ''),
  SB_KEY: process.env.SB_KEY,
  PUBLIC_URL: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
  DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN || '',
  ACCOUNT_ID: process.env.ACCOUNT_ID || 'default',
  DEFAULT_CURRENCY: (process.env.DEFAULT_CURRENCY || 'USD').toUpperCase(),
  DEFAULT_TAX_RATE: Number(process.env.DEFAULT_TAX_RATE || '0') || 0,
  PORT: Number(process.env.PORT || '3001'),
};

// Model routing (ARCHITECTURE §3.5). IDs come from .env so deprecations are a config change (ADR-006).
cfg.MODEL_ROUTES = {
  visionDefault: process.env.VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
  visionEscalate: process.env.VISION_MODEL_HEAVY || 'meta-llama/llama-4-maverick-17b-128e-instruct',
  text: process.env.TEXT_MODEL || 'llama-3.3-70b-versatile',
  classify: process.env.CLASSIFY_MODEL || 'openai/gpt-oss-20b',
};

cfg.SB_REST = cfg.SB_URL + '/rest/v1';
cfg.sbH = { apikey: cfg.SB_KEY, Authorization: 'Bearer ' + cfg.SB_KEY, 'Content-Type': 'application/json' };

// Startup guard — surface missing secrets loudly (moved from server.js:36-38).
function assertConfig() {
  ['BOT_TOKEN', 'GROQ_KEY', 'SB_URL', 'SB_KEY'].forEach(k => {
    if (!process.env[k]) console.error('[FATAL] Missing env var:', k, '— set it in .env');
  });
}

module.exports = { cfg, assertConfig };
```

- [ ] **Step 4.2: Commit**

```bash
git add lib/config.js
git commit -m "refactor: centralize env + model routing in lib/config.js"
```

---

## Task 5: Extract `lib/groq.js` (Groq client + routing)

**Files:**
- Create: `lib/groq.js`

Moves `groqChat` from `server.js:57-74` verbatim, wired to `cfg`. Adds a thin `groqVision(imageUrl, promptText, opts)` wrapper so callers (#7, #9) don't hand-build the vision message. (Owner post-refactor: Barat.)

- [ ] **Step 5.1: Implement `lib/groq.js`**

```js
'use strict';
const { cfg } = require('./config');
const { hreq } = require('./http');

// Chat with exponential backoff for 429s. Moved verbatim from server.js (default model now from routing).
async function groqChat(messages, { model = cfg.MODEL_ROUTES.visionDefault, max_tokens = 900, temperature = 0.1 } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await hreq({
        method: 'POST', url: 'https://api.groq.com/openai/v1/chat/completions',
        headers: { Authorization: 'Bearer ' + cfg.GROQ_KEY, 'Content-Type': 'application/json' },
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

// Convenience wrapper for a single image + text prompt. Returns raw model text.
async function groqVision(imageUrl, promptText, { model = cfg.MODEL_ROUTES.visionDefault, max_tokens = 900 } = {}) {
  return groqChat([{
    role: 'user',
    content: [
      { type: 'text', text: promptText },
      { type: 'image_url', image_url: { url: imageUrl } }
    ]
  }], { model, max_tokens, temperature: 0.1 });
}

module.exports = { groqChat, groqVision, MODEL_ROUTES: cfg.MODEL_ROUTES };
```

- [ ] **Step 5.2: Commit**

```bash
git add lib/groq.js
git commit -m "refactor: extract Groq client + groqVision wrapper into lib/groq.js"
```

---

## Task 6: Extract `lib/supabase.js` (account-scoped DB helpers)

**Files:**
- Create: `lib/supabase.js`

Replaces the inline `SB_REST` fetches (`server.js:145,165,231,245,255`) with the frozen helpers from ARCHITECTURE §3.3. (Owner post-refactor: Barat.)

- [ ] **Step 6.1: Implement `lib/supabase.js`**

```js
'use strict';
const { cfg } = require('./config');
const { hreq } = require('./http');

const enc = encodeURIComponent;
function qEq(obj) { return Object.entries(obj).map(([k, v]) => k + '=eq.' + enc(v)).join('&'); }

// All helpers inject account_id so callers can never forget tenant scoping.
async function sbSelect(table, { eq = {}, order, limit, extra } = {}) {
  let url = cfg.SB_REST + '/' + table + '?' + qEq({ account_id: cfg.ACCOUNT_ID, ...eq });
  if (extra) url += '&' + extra;                 // e.g. 'deleted_at=is.null'
  if (order) url += '&order=' + order;
  if (limit) url += '&limit=' + limit;
  const rows = await hreq({ url, headers: cfg.sbH, json: true });
  return Array.isArray(rows) ? rows : [];
}

async function sbInsert(table, row) {
  await hreq({ method: 'POST', url: cfg.SB_REST + '/' + table, headers: { ...cfg.sbH, Prefer: 'return=minimal' },
    body: { account_id: cfg.ACCOUNT_ID, ...row }, json: true });
}

async function sbUpdate(table, { id }, patch) {
  const url = cfg.SB_REST + '/' + table + '?' + qEq({ id, account_id: cfg.ACCOUNT_ID });
  const rows = await hreq({ method: 'PATCH', url, headers: { ...cfg.sbH, Prefer: 'return=representation' }, body: patch, json: true });
  return Array.isArray(rows) ? rows : [];
}

async function sbSoftDelete(table, { id }) {
  const url = cfg.SB_REST + '/' + table + '?' + qEq({ id, account_id: cfg.ACCOUNT_ID });
  await hreq({ method: 'PATCH', url, headers: { ...cfg.sbH, Prefer: 'return=minimal' }, body: { deleted_at: new Date().toISOString() }, json: true });
}

module.exports = { sbSelect, sbInsert, sbUpdate, sbSoftDelete };
```

- [ ] **Step 6.2: Commit**

```bash
git add lib/supabase.js
git commit -m "refactor: extract account-scoped Supabase helpers into lib/supabase.js"
```

---

## Task 7: Extract `lib/telegram.js` (bot send + file + webhook reg)

**Files:**
- Create: `lib/telegram.js`

Moves `tgSend` (`server.js:94-101`), the getFile/photo-url logic, the receipt-proxy fetch, and `registerWebhook` (`server.js:291-300`). (Owner post-refactor: Barat — input channel.)

- [ ] **Step 7.1: Implement `lib/telegram.js`**

```js
'use strict';
const { cfg } = require('./config');
const { hreq } = require('./http');

const api = m => 'https://api.telegram.org/bot' + cfg.BOT_TOKEN + '/' + m;

async function tgSend(chatId, text, replyMarkup) {
  try {
    await hreq({ method: 'POST', url: api('sendMessage'), json: true,
      body: { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) } });
  } catch (e) { console.error('[tgSend]', e.message); }
}

// Resolve a Telegram file_id to a downloadable URL.
async function tgFileUrl(fileId) {
  const f = await hreq({ url: api('getFile?file_id=' + encodeURIComponent(fileId)), json: true, timeout: 8000 });
  const fp = f && f.result && f.result.file_path;
  if (!fp) return null;
  return { url: 'https://api.telegram.org/file/bot' + cfg.BOT_TOKEN + '/' + fp, path: fp };
}

async function registerWebhook() {
  if (!cfg.PUBLIC_URL) { console.log('[webhook] PUBLIC_URL not set — skipping auto-registration.'); return; }
  try {
    const url = cfg.PUBLIC_URL + '/webhook';
    const body = { url, allowed_updates: ['message', 'edited_message'], drop_pending_updates: false };
    if (cfg.WEBHOOK_SECRET) body.secret_token = cfg.WEBHOOK_SECRET;
    const r = await hreq({ method: 'POST', url: api('setWebhook'), json: true, body });
    console.log('[webhook]', r && r.ok ? ('registered → ' + url) : ('FAILED: ' + JSON.stringify(r)));
  } catch (e) { console.error('[webhook reg]', e.message); }
}

module.exports = { tgSend, tgFileUrl, registerWebhook, api };
```

- [ ] **Step 7.2: Commit**

```bash
git add lib/telegram.js
git commit -m "refactor: extract Telegram helpers into lib/telegram.js"
```

---

## Task 8: Extract `lib/ocr.js` + `lib/bot.js` (receipt pipeline + update router)

**Files:**
- Create: `lib/ocr.js` (the `expenseFromPhoto` pipeline, `server.js:106-161`)
- Create: `lib/bot.js` (`sendExpenseSummary` + `handleUpdate` + `WELCOME`, `server.js:163-204`)

Move verbatim, rewired to the new modules. `expense_date` normalization now uses `normaliseDate` from `lib/money.js`. (Owner post-refactor: `ocr.js` → Barat; `bot.js` → Barat input.)

- [ ] **Step 8.1: Implement `lib/ocr.js`**

```js
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
```

- [ ] **Step 8.2: Implement `lib/bot.js`**

```js
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
```

- [ ] **Step 8.3: Commit**

```bash
git add lib/ocr.js lib/bot.js
git commit -m "refactor: extract receipt pipeline (lib/ocr.js) and update router (lib/bot.js)"
```

---

## Task 9: Extract `routes/*` (Express endpoints)

**Files:**
- Create: `routes/webhook.js`, `routes/expenses.js`, `routes/receipt.js`, `routes/misc.js`

Move the route handlers from `server.js:212-286` verbatim, grouped. Each exports a function that mounts onto the app.

- [ ] **Step 9.1: Implement `routes/webhook.js`**

```js
'use strict';
const express = require('express');
const { cfg } = require('../lib/config');
const { handleUpdate } = require('../lib/bot');

module.exports = function mountWebhook(app) {
  app.post('/webhook', express.json({ limit: '2mb' }), (req, res) => {
    if (cfg.WEBHOOK_SECRET && req.get('X-Telegram-Bot-Api-Secret-Token') !== cfg.WEBHOOK_SECRET) return res.sendStatus(401);
    res.sendStatus(200);
    handleUpdate(req.body).catch(e => console.error('[handleUpdate]', e.message));
  });
};
```

- [ ] **Step 9.2: Implement `routes/expenses.js`**

```js
'use strict';
const express = require('express');
const { cfg } = require('../lib/config');
const { sbSelect, sbUpdate, sbSoftDelete } = require('../lib/supabase');

// Optional API gate (enabled only when DASHBOARD_TOKEN is set). Moved from server.js:220-225.
function checkDash(req, res, next) {
  if (!cfg.DASHBOARD_TOKEN) return next();
  const a = req.get('Authorization') || '';
  if (a === 'Bearer ' + cfg.DASHBOARD_TOKEN || req.query.key === cfg.DASHBOARD_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

module.exports = function mountExpenses(app) {
  app.get('/api/expenses', checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      const rows = await sbSelect('expenses', { extra: 'deleted_at=is.null', order: 'created_at.desc', limit: 2000 });
      res.json(rows);
    } catch (e) { console.error('[api/expenses]', e.message); res.status(502).json({ error: 'load failed' }); }
  });

  app.patch('/api/expenses/:id', checkDash, express.json({ limit: '1mb' }), async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      const allow = ['merchant', 'expense_date', 'amount', 'currency', 'category', 'status', 'remark', 'subtotal', 'tax'];
      const body = {};
      for (const k of allow) if (req.body && k in req.body) body[k] = req.body[k];
      if (!Object.keys(body).length) return res.status(400).json({ error: 'no fields to update' });
      const rows = await sbUpdate('expenses', { id: req.params.id }, body);
      res.json(rows[0] || { ok: true });
    } catch (e) { console.error('[patch expense]', e.message); res.status(502).json({ error: 'update failed' }); }
  });

  app.delete('/api/expenses/:id', checkDash, async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      await sbSoftDelete('expenses', { id: req.params.id });
      res.json({ ok: true });
    } catch (e) { console.error('[delete expense]', e.message); res.status(502).json({ error: 'delete failed' }); }
  });

  app.get('/api/config', (req, res) => res.json({ auth_required: !!cfg.DASHBOARD_TOKEN, default_currency: cfg.DEFAULT_CURRENCY }));
};

module.exports.checkDash = checkDash;
```

- [ ] **Step 9.3: Implement `routes/receipt.js`**

```js
'use strict';
const { cfg } = require('../lib/config');
const { hreq } = require('../lib/http');
const { tgFileUrl } = require('../lib/telegram');

module.exports = function mountReceipt(app) {
  app.get('/receipt/:fileId', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      const fileId = String(req.params.fileId || '').slice(0, 400);
      if (!fileId) return res.status(400).send('missing file_id');
      const file = await tgFileUrl(fileId);
      if (!file) return res.status(404).send('not found');
      const buf = await hreq({ url: file.url, encoding: 'arraybuffer', timeout: 20000 });
      const ext = (file.path.split('.').pop() || '').toLowerCase();
      res.set('Content-Type', ext === 'png' ? 'image/png' : ext === 'pdf' ? 'application/pdf' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(buf);
    } catch (e) { console.error('[receipt proxy]', e.message); res.status(502).send('error'); }
  });
};
```

- [ ] **Step 9.4: Implement `routes/misc.js`**

```js
'use strict';
const path = require('path');
const express = require('express');
const { cfg } = require('../lib/config');

module.exports = function mountMisc(app) {
  app.get('/health', (req, res) => res.json({ ok: true, service: 'receipt-saas', account: cfg.ACCOUNT_ID }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
};
```

- [ ] **Step 9.5: Commit**

```bash
git add routes/
git commit -m "refactor: extract Express endpoints into routes/*"
```

---

## Task 10: Slim `server.js` to wiring only

**Files:**
- Modify: `server.js` (replace entire contents)

- [ ] **Step 10.1: Replace `server.js` with wiring only**

```js
/**
 * Receipt Analyser SaaS — server entry (wiring only).
 * All logic lives in lib/* and routes/*. See docs/ARCHITECTURE.md.
 */
'use strict';
const express = require('express');
const { cfg, assertConfig } = require('./lib/config');
const { registerWebhook } = require('./lib/telegram');

const mountWebhook = require('./routes/webhook');
const mountExpenses = require('./routes/expenses');
const mountReceipt = require('./routes/receipt');
const mountMisc = require('./routes/misc');

assertConfig();

const app = express();
app.set('trust proxy', true);
mountWebhook(app);
mountExpenses(app);
mountReceipt(app);
mountMisc(app);

if (process.argv.includes('--register-only')) {
  registerWebhook().then(() => process.exit(0));
} else {
  app.listen(cfg.PORT, () => {
    console.log('[receipt-saas] listening on :' + cfg.PORT + '  (account: ' + cfg.ACCOUNT_ID + ')');
    setTimeout(registerWebhook, 1500);
  });
}
```

- [ ] **Step 10.2: Smoke test — server boots and `/health` responds**

Create `tests/smoke.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('all modules import without throwing', () => {
  assert.doesNotThrow(() => {
    require('../lib/config'); require('../lib/http'); require('../lib/groq');
    require('../lib/supabase'); require('../lib/telegram'); require('../lib/money');
    require('../lib/categorize'); require('../lib/ocr'); require('../lib/bot');
    require('../routes/webhook'); require('../routes/expenses');
    require('../routes/receipt'); require('../routes/misc');
  });
});

test('GET /health returns ok JSON', async () => {
  const express = require('express');
  const mountMisc = require('../routes/misc');
  const app = express();
  mountMisc(app);
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/health');
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.service, 'receipt-saas');
  } finally { server.close(); }
});
```

- [ ] **Step 10.3: Run the full test suite**

Run: `npm test`
Expected: PASS — money, categorize, http, smoke (imports + /health) all green.

- [ ] **Step 10.4: Manual boot check**

Run: `node server.js`
Expected: logs `[receipt-saas] listening on :3001` (and `[FATAL] Missing env var` warnings if `.env` isn't filled — that's expected without secrets). Ctrl-C to stop.

- [ ] **Step 10.5: Commit**

```bash
git add server.js tests/smoke.test.js
git commit -m "refactor: slim server.js to wiring only; add smoke tests"
```

---

## Task 11: Update docs and open the PR

**Files:**
- Modify: `docs/WORKLOG.md`, `docs/STATUS.md`

- [ ] **Step 11.1: Append a WORKLOG entry** (newest first, above the marker) recording: branch `feature/jeevan-p2-modularize-server`, files created (`lib/*`, `routes/*`, `tests/*`), "modularized server.js, behaviour preserved, smoke + unit tests green", next = "Barat starts P3 infra (schema + fill groq.js/supabase.js/templates.js)".

- [ ] **Step 11.2: Update STATUS.md** — mark modularization done, phase ready for P3; set "who's on what" to Barat=P3 infra, Jeevan=#10/#2 scaffolds, Mugi=#3.

- [ ] **Step 11.3: Commit and push the branch**

```bash
git add docs/WORKLOG.md docs/STATUS.md
git commit -m "docs: log modularization, advance STATUS to P3-ready"
git push -u origin feature/jeevan-p2-modularize-server
```

- [ ] **Step 11.4: Open the PR**

```bash
gh pr create --base main --head feature/jeevan-p2-modularize-server \
  --title "refactor(P2): modularize server.js into lib/ + routes/ (no behaviour change)" \
  --body "Implements ADR-001. Moves all logic out of the single-file server.js into focused modules with the frozen interfaces from ARCHITECTURE §3. No behaviour change. Unit tests (money, categorize, http) + smoke test (imports, /health) green via \`npm test\`. Unblocks parallel feature work. Reviewer: @<barat-gh>. Owner merges."
```

---

## Self-Review (completed by author)

- **Spec coverage:** Every `lib/*` and `routes/*` file named in ARCHITECTURE §2 either created here (infra/shared/ocr) or left for its feature owner (anomaly, reports, agent, excel, currency, massupload, templates, confidence) — those are feature tasks, not part of this refactor. ✅
- **Behaviour preserved:** every moved block is verbatim except dependency injection (cfg/imports) and the `sbSelect` account-scope helper replacing inline URLs (same query result). ✅
- **Type/name consistency:** `hreq`, `groqChat`/`groqVision`, `sbSelect/sbInsert/sbUpdate/sbSoftDelete`, `tgSend/tgFileUrl/registerWebhook`, `normaliseDate`, `normaliseExpenseCategory`, `expenseFromPhoto`, `handleUpdate` — names match across all tasks. ✅
- **No placeholders:** all steps contain real code/commands. ✅
- **No new deps:** uses built-in `node:test`; stack lock honored. ✅

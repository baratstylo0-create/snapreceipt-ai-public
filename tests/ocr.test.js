'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { extractReceipt, parseModelJson, coerce } = require('../lib/ocr');

// Stub global.fetch so extractReceipt -> groqChat -> hreq -> fetch never hits the
// network. Returns a Groq chat-completion shaped body whose content is `text`.
// (Same hermetic pattern as tests/currency.test.js.)
function stubGroq(content) {
  const realFetch = global.fetch;
  let lastBody = null;
  global.fetch = async (_url, opt) => {
    lastBody = JSON.parse(opt.body);
    return { text: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
  };
  return { restore: () => { global.fetch = realFetch; }, sent: () => lastBody };
}

const SPEC = {
  account_id: 'default',
  columns: [
    { key: 'merchant',     label: 'Vendor',   type: 'text',     required: true },
    { key: 'amount',       label: 'Total',    type: 'currency', required: true },
    { key: 'expense_date', label: 'Date',     type: 'date',     required: true },
    { key: 'category',     label: 'Category', type: 'category', required: false },
  ],
};

test('parseModelJson strips <think> and extracts the JSON object', () => {
  assert.deepStrictEqual(parseModelJson('<think>hmm let me look</think>\n{"a":1}'), { a: 1 });
  assert.deepStrictEqual(parseModelJson('noise {"a":1,"b":"x"} trailing'), { a: 1, b: 'x' });
});

test('parseModelJson returns {} for garbage / arrays / truncated JSON', () => {
  assert.deepStrictEqual(parseModelJson('no json here'), {});
  assert.deepStrictEqual(parseModelJson('[1,2,3]'), {});
  assert.deepStrictEqual(parseModelJson('{"a":1'), {});
  assert.deepStrictEqual(parseModelJson(''), {});
  assert.deepStrictEqual(parseModelJson(null), {});
});

test('coerce enforces the declared type', () => {
  assert.strictEqual(coerce('2026-01-02', 'date'), '2026-01-02');
  assert.strictEqual(coerce('12.50', 'currency'), 12.5);
  assert.strictEqual(coerce('not a number', 'currency'), 0);
  assert.strictEqual(coerce('Uber ride', 'category'), 'Petrol');
  assert.strictEqual(coerce(null, 'text'), '');
  assert.strictEqual(coerce(1234, 'text'), '1234');
});

test('extractReceipt returns coerced fields for exactly the FieldSpec keys', async () => {
  const s = stubGroq('<think>reading</think>{"merchant":"Acme Cafe","amount":"18.90","expense_date":"02/01/2026","category":"lunch cafe"}');
  try {
    const { fields, rawParsed } = await extractReceipt('data:image/png;base64,xxx', SPEC);
    assert.deepStrictEqual(Object.keys(fields).sort(), ['amount', 'category', 'expense_date', 'merchant']);
    assert.strictEqual(fields.merchant, 'Acme Cafe');
    assert.strictEqual(fields.amount, 18.9);              // currency coerced to number
    assert.strictEqual(fields.expense_date, '2026-01-02'); // DD/MM/YYYY -> ISO
    assert.strictEqual(fields.category, 'Food');           // normalised to canonical set
    assert.strictEqual(rawParsed.amount, '18.90');         // raw preserved for confidence
  } finally { s.restore(); }
});

test('extractReceipt ignores extra keys the model volunteers (only FieldSpec keys used)', async () => {
  const s = stubGroq('{"merchant":"X","amount":5,"expense_date":"2026-01-01","evil_injected":"rm -rf","secret":"leak"}');
  try {
    const { fields } = await extractReceipt('img', SPEC);
    assert.ok(!('evil_injected' in fields));
    assert.ok(!('secret' in fields));
  } finally { s.restore(); }
});

test('extractReceipt uses a generous max_tokens (qwen <think>) and isolates system from image', async () => {
  const s = stubGroq('{"merchant":"X","amount":1,"expense_date":"2026-01-01"}');
  try {
    await extractReceipt('img', SPEC);
    const body = s.sent();
    assert.ok(body.max_tokens >= 2000, 'generous token budget for qwen <think>');
    assert.strictEqual(body.messages[0].role, 'system');   // untrusted image isolated from system prompt
    assert.match(body.messages[0].content, /UNTRUSTED|do not obey/i);
    const userParts = body.messages[1].content;
    assert.ok(userParts.some(p => p.type === 'image_url'));
  } finally { s.restore(); }
});

test('extractReceipt fills type-safe defaults when the model returns nothing usable', async () => {
  const s = stubGroq('the receipt is too blurry, sorry');
  try {
    const { fields } = await extractReceipt('img', SPEC);
    assert.strictEqual(fields.amount, 0);
    assert.strictEqual(fields.merchant, '');
    assert.strictEqual(fields.category, 'Others');
    assert.match(fields.expense_date, /^\d{4}-\d{2}-\d{2}$/); // falls back to today, still valid ISO
  } finally { s.restore(); }
});

test('extractReceipt throws without a valid FieldSpec', async () => {
  await assert.rejects(() => extractReceipt('img', null), /FieldSpec/);
  await assert.rejects(() => extractReceipt('img', { columns: [] }), /FieldSpec/);
});

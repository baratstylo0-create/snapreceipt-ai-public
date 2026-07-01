'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { extractReceipt, extractReceipts, parseModelJson, parseModelJsonArray, coerce } = require('../lib/ocr');

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

// PR #12 review (Critical): an UNTERMINATED <think> (qwen cut off mid-reasoning)
// must NOT let a {...}-shaped example inside the reasoning be accepted as the answer.
test('parseModelJson rejects an unterminated <think> instead of brace-scanning the reasoning', () => {
  assert.deepStrictEqual(
    parseModelJson('<think>...a receipt might look like {"merchant":"X","amount":1}... '),
    {},
  );
  // unterminated think with no braces at all -> still {}
  assert.deepStrictEqual(parseModelJson('<think>let me read the total'), {});
  // multiple blocks where the LAST think is cut off -> {} (no completed answer)
  assert.deepStrictEqual(parseModelJson('<think>a</think>{"real":1} then <think>b {"fake":2}'), {});
  // sanity: a properly CLOSED think followed by real JSON still parses
  assert.deepStrictEqual(parseModelJson('<think>done</think>{"merchant":"Acme"}'), { merchant: 'Acme' });
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

// ---- #7 mass upload: parseModelJsonArray + extractReceipts (multi-receipt) ----

test('parseModelJsonArray extracts an array of objects and drops non-objects', () => {
  assert.deepStrictEqual(parseModelJsonArray('<think>reading</think>[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }]);
  assert.deepStrictEqual(parseModelJsonArray('noise [{"a":1}] trailing'), [{ a: 1 }]);
  // nested/non-object elements are filtered out, plain objects kept
  assert.deepStrictEqual(parseModelJsonArray('[{"a":1}, 5, "x", [9], null]'), [{ a: 1 }]);
});

test('parseModelJsonArray returns [] for garbage / a bare object / truncated / unterminated <think>', () => {
  assert.deepStrictEqual(parseModelJsonArray('no json here'), []);
  assert.deepStrictEqual(parseModelJsonArray('{"a":1}'), []);          // a single object is NOT an array
  assert.deepStrictEqual(parseModelJsonArray('[{"a":1}'), []);         // truncated array
  assert.deepStrictEqual(parseModelJsonArray(''), []);
  assert.deepStrictEqual(parseModelJsonArray(null), []);
  // unterminated <think> must not let a [...]-shaped example be accepted as the answer
  assert.deepStrictEqual(parseModelJsonArray('<think>maybe [{"merchant":"X"}]'), []);
});

test('extractReceipts returns one coerced {fields,rawParsed} per receipt in the array', async () => {
  const s = stubGroq('<think>reading</think>[' +
    '{"merchant":"Cafe A","amount":"18.90","expense_date":"02/01/2026","category":"lunch cafe"},' +
    '{"merchant":"Shop B","amount":"5","expense_date":"2026-01-03","category":"software"}]');
  try {
    const { receipts, truncated } = await extractReceipts('data:image/png;base64,xxx', SPEC);
    assert.strictEqual(truncated, false);
    assert.strictEqual(receipts.length, 2);
    assert.strictEqual(receipts[0].fields.merchant, 'Cafe A');
    assert.strictEqual(receipts[0].fields.amount, 18.9);            // currency coerced
    assert.strictEqual(receipts[0].fields.expense_date, '2026-01-02'); // DD/MM/YYYY -> ISO
    assert.strictEqual(receipts[0].fields.category, 'Food');        // normalised
    assert.strictEqual(receipts[0].rawParsed.amount, '18.90');      // raw preserved
    assert.strictEqual(receipts[1].fields.merchant, 'Shop B');
    assert.strictEqual(receipts[1].fields.amount, 5);
    // each element carries EXACTLY the FieldSpec keys, ready for assembleExpense
    assert.deepStrictEqual(Object.keys(receipts[1].fields).sort(), ['amount', 'category', 'expense_date', 'merchant']);
  } finally { s.restore(); }
});

test('extractReceipts caps at maxReceipts and sets truncated=true when the model returns more', async () => {
  const many = Array.from({ length: 5 }, (_, i) => '{"merchant":"M' + i + '","amount":' + i + ',"expense_date":"2026-01-01"}');
  const s = stubGroq('[' + many.join(',') + ']');
  try {
    const { receipts, truncated } = await extractReceipts('img', SPEC, { maxReceipts: 3 });
    assert.strictEqual(receipts.length, 3);         // extra receipts dropped
    assert.strictEqual(truncated, true);
    assert.strictEqual(receipts[0].fields.merchant, 'M0'); // reading order preserved
    // the cap is echoed into the instruction so the model is told the limit too
    assert.match(s.sent().messages[1].content[0].text, /at most 3 receipts/);
  } finally { s.restore(); }
});

test('extractReceipts returns an empty list (not a throw) when nothing usable is read', async () => {
  const s = stubGroq('the page is blank, sorry');
  try {
    const { receipts, truncated } = await extractReceipts('img', SPEC);
    assert.deepStrictEqual(receipts, []);
    assert.strictEqual(truncated, false);
  } finally { s.restore(); }
});

test('extractReceipts ignores extra keys and asks for a JSON ARRAY, image isolated from system', async () => {
  const s = stubGroq('[{"merchant":"X","amount":1,"expense_date":"2026-01-01","evil":"rm -rf"}]');
  try {
    const { receipts } = await extractReceipts('img', SPEC);
    assert.ok(!('evil' in receipts[0].fields));         // only FieldSpec keys kept
    const body = s.sent();
    assert.strictEqual(body.messages[0].role, 'system'); // untrusted image isolated
    assert.match(body.messages[0].content, /UNTRUSTED|do not obey/i);
    assert.match(body.messages[1].content[0].text, /JSON ARRAY/i);
    assert.ok(body.messages[1].content.some(p => p.type === 'image_url'));
  } finally { s.restore(); }
});

test('extractReceipts throws without a valid FieldSpec', async () => {
  await assert.rejects(() => extractReceipts('img', null), /FieldSpec/);
  await assert.rejects(() => extractReceipts('img', { columns: [] }), /FieldSpec/);
});

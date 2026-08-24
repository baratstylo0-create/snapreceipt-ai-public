'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { extractReceipt, extractReceipts, parseModelJson, parseModelJsonArray, coerce } = require('../lib/ocr');
const { todayISO } = require('../lib/money');
const { cfg } = require('../lib/config');

// Stub global.fetch so extractReceipt -> orChat (lib/openrouter) -> hreq -> fetch
// never hits the network. Returns an OpenRouter chat-completion shaped body whose
// content is `text`. (Same hermetic pattern as tests/currency.test.js.)
function stubGroq(content) {
  const realFetch = global.fetch;
  let lastBody = null;
  let lastUrl = null;
  global.fetch = async (url, opt) => {
    lastUrl = url;
    lastBody = JSON.parse(opt.body);
    return { text: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
  };
  return { restore: () => { global.fetch = realFetch; }, sent: () => lastBody, url: () => lastUrl };
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

test('extractReceipt calls OpenRouter (not Groq) with the pre-qwen 900 token budget and isolates system from image', async () => {
  const s = stubGroq('{"merchant":"X","amount":1,"expense_date":"2026-01-01"}');
  try {
    await extractReceipt('img', SPEC);
    assert.strictEqual(s.url(), 'https://openrouter.ai/api/v1/chat/completions');
    const body = s.sent();
    assert.strictEqual(body.max_tokens, 900); // Scout isn't a reasoning model — no <think> budget needed
    assert.strictEqual('reasoning_effort' in body, false); // OpenRouter/Scout never takes this param
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

// ---- Buffer image → data-URI (bug: /api/upload passes raw Buffers; Groq needs a string) ----

function sentImageUrl(sent) {
  return sent.messages[1].content.find(p => p.type === 'image_url').image_url.url;
}

test('extractReceipt converts a Buffer image to a base64 data-URI string (not {"type":"Buffer"})', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]); // PNG magic + bytes
  const s = stubGroq('{"merchant":"X","amount":1,"expense_date":"2026-01-01"}');
  try {
    await extractReceipt(png, SPEC);
    const url = sentImageUrl(s.sent());
    assert.strictEqual(typeof url, 'string', 'url must be a string, never a Buffer object');
    assert.strictEqual(url, 'data:image/png;base64,' + png.toString('base64'));
  } finally { s.restore(); }
});

test('extractReceipt sniffs JPEG magic bytes for the data-URI mime', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7]);
  const s = stubGroq('{"merchant":"X","amount":1,"expense_date":"2026-01-01"}');
  try {
    await extractReceipt(jpeg, SPEC);
    assert.match(sentImageUrl(s.sent()), /^data:image\/jpeg;base64,/);
  } finally { s.restore(); }
});

test('extractReceipt passes a string URL / data-URI through unchanged', async () => {
  const s = stubGroq('{"merchant":"X","amount":1,"expense_date":"2026-01-01"}');
  try {
    await extractReceipt('https://example.com/r.png', SPEC);
    assert.strictEqual(sentImageUrl(s.sent()), 'https://example.com/r.png');
  } finally { s.restore(); }
});

test('extractReceipts also converts a Buffer image to a data-URI (mass-upload /api/upload path)', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
  const s = stubGroq('[{"merchant":"X","amount":1,"expense_date":"2026-01-01"}]');
  try {
    await extractReceipts(png, SPEC);
    assert.strictEqual(sentImageUrl(s.sent()), 'data:image/png;base64,' + png.toString('base64'));
  } finally { s.restore(); }
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

// --- 2026-07-18: reasoning_effort passthrough + retry-on-empty ---
// A sequence stub: returns each `contents[i]` in order (last one sticks), counts calls,
// and records every request body so we can assert what was actually sent to Groq.
function stubGroqSeq(contents) {
  const realFetch = global.fetch;
  const bodies = [];
  let i = 0;
  global.fetch = async (_url, opt) => {
    bodies.push(JSON.parse(opt.body));
    const content = contents[Math.min(i, contents.length - 1)];
    i++;
    return { text: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
  };
  return { restore: () => { global.fetch = realFetch; }, calls: () => i, bodies: () => bodies };
}

test('retry-on-empty: a totally empty first result is retried and the good second result wins', async () => {
  // 1st call: unterminated <think> => parseModelJson -> {} (empty). 2nd call: real JSON.
  // expense_date included (and plausible) so the date-escalation path (extractReceipt,
  // 2026-08-23) never triggers here — this test is about the retry-on-empty count, not dates.
  const s = stubGroqSeq(['<think>is it a 4 or a 6... let me reconsider', '{"merchant":"Shell","amount":97.2,"expense_date":"' + todayISO() + '"}']);
  try {
    const out = await extractReceipt('img', SPEC);
    assert.strictEqual(s.calls(), 2, 'should have retried exactly once');
    assert.strictEqual(out.fields.merchant, 'Shell');
    assert.strictEqual(out.fields.amount, 97.2);
  } finally { s.restore(); }
});

test('retry-on-empty: a good first result is NOT retried (one call only)', async () => {
  const s = stubGroqSeq(['{"merchant":"KFC","amount":12,"expense_date":"' + todayISO() + '"}', '{"merchant":"SHOULD_NOT_BE_USED","amount":0}']);
  try {
    const out = await extractReceipt('img', SPEC);
    assert.strictEqual(s.calls(), 1, 'a usable first parse must not trigger a retry');
    assert.strictEqual(out.fields.merchant, 'KFC');
  } finally { s.restore(); }
});

// NO_DATE_SPEC: used ONLY by the "totally empty response" tests below. A response that
// never parses at all has no expense_date either way, which would otherwise trigger
// extractReceipt's date-escalation retry (2026-08-23) — an extra call these tests aren't
// about (they're testing the retry-on-empty COUNT and the parse-failure log, not dates;
// escalation has its own dedicated tests). Dropping the date column from the spec keeps
// the escalation guard (hasDateColumn) off, same effect as before that feature existed.
const NO_DATE_SPEC = { account_id: 'default', columns: SPEC.columns.filter((c) => c.key !== 'expense_date') };

test('retry-on-empty: retries:0 disables the retry (stays empty)', async () => {
  const s = stubGroqSeq(['<think>never closes', '{"merchant":"Shell","amount":97.2}']);
  try {
    const out = await extractReceipt('img', NO_DATE_SPEC, { retries: 0 });
    assert.strictEqual(s.calls(), 1);
    assert.strictEqual(out.fields.merchant, ''); // empty parse -> text coerces to '', no retry
  } finally { s.restore(); }
});

test('retry-on-empty: still empty after the retry -> returns empty (never throws)', async () => {
  const s = stubGroqSeq(['<think>a', '<think>b']); // both attempts empty
  try {
    const out = await extractReceipt('img', NO_DATE_SPEC);
    assert.strictEqual(s.calls(), 2);
    assert.strictEqual(out.fields.merchant, ''); // text -> ''
    assert.strictEqual(out.fields.amount, 0);    // currency -> 0
  } finally { s.restore(); }
});

// 2026-07-22 (Owner-reported live incident): a parse failure used to be TOTALLY silent —
// a live "NOT saved, I couldn't read this clearly" had nothing to diagnose from, not even
// server logs. A capped snippet of the model's raw text must now be logged so a repeat is
// root-causeable instead of guessed at (ADR-002-safe: lib/log.js caps + drops PII already).
test('a parse failure after all retries is logged with a snippet of the raw model text', async () => {
  const s = stubGroqSeq(['<think>a', '<think>b']); // both attempts empty, same as the test above
  const realWarn = console.warn;
  const warned = [];
  console.warn = (line) => warned.push(line);
  try {
    await extractReceipt('img', NO_DATE_SPEC);
    assert.strictEqual(warned.length, 1, 'exactly one warning for the fully-failed extraction');
    const rec = JSON.parse(warned[0]);
    assert.strictEqual(rec.level, 'warn');
    assert.strictEqual(rec.where, 'ocr.extractReceipt');
    assert.ok(rec.rawSnippet && rec.rawSnippet.includes('<think>b'), 'carries the LAST attempt\'s raw text, not the first');
  } finally { console.warn = realWarn; s.restore(); }
});

test('a successful extraction (no retry needed) never logs a parse-failure warning', async () => {
  const s = stubGroqSeq(['{"merchant":"KFC","amount":12,"expense_date":"' + todayISO() + '"}']);
  const realWarn = console.warn;
  const warned = [];
  console.warn = (line) => warned.push(line);
  try {
    await extractReceipt('img', SPEC);
    assert.strictEqual(warned.length, 0);
  } finally { console.warn = realWarn; s.restore(); }
});

test('retry-on-empty (multi): an empty array is retried; the good second result wins', async () => {
  const s = stubGroqSeq(['<think>never closes', '[{"merchant":"A","amount":1},{"merchant":"B","amount":2}]']);
  try {
    const out = await extractReceipts('img', SPEC);
    assert.strictEqual(s.calls(), 2, 'multi path should retry on an empty array');
    assert.strictEqual(out.receipts.length, 2);
    assert.strictEqual(out.receipts[0].fields.merchant, 'A');
  } finally { s.restore(); }
});

// --- date-read escalation (2026-08-23, Barat: "try to strong the OCR on date reading") ----
// A misread-but-parseable date (isDatePlausible catches this, unlike plain parseability) or
// an outright unreadable one retries the WHOLE receipt with cfg.MODEL_ROUTES.visionEscalate —
// only for receipts that actually need it, never a blanket extra call.
function withModelRoutes(overrides, fn) {
  const saved = { ...cfg.MODEL_ROUTES };
  Object.assign(cfg.MODEL_ROUTES, overrides);
  return Promise.resolve().then(fn).finally(() => { Object.assign(cfg.MODEL_ROUTES, saved); });
}

test('escalation: an implausible date (misread year, still parses) triggers a second call to the escalate model', async () => {
  await withModelRoutes({ visionDefault: 'cheap-model', visionEscalate: 'strong-model' }, async () => {
    const s = stubGroqSeq([
      '{"merchant":"Old Town","amount":8.5,"expense_date":"1924-06-01"}', // parses fine, but ~100 years ago -> implausible
      '{"merchant":"Old Town","amount":8.5,"expense_date":"' + todayISO() + '"}',
    ]);
    try {
      const out = await extractReceipt('img', SPEC);
      assert.strictEqual(s.calls(), 2, 'implausible date triggers exactly one escalation call');
      assert.strictEqual(s.bodies()[0].model, 'cheap-model');
      assert.strictEqual(s.bodies()[1].model, 'strong-model');
      assert.strictEqual(out.fields.expense_date, todayISO(), 'the escalated (recovered) read wins');
    } finally { s.restore(); }
  });
});

test('escalation: a plausible date on the FIRST try never escalates (one call only)', async () => {
  await withModelRoutes({ visionDefault: 'cheap-model', visionEscalate: 'strong-model' }, async () => {
    const s = stubGroqSeq(['{"merchant":"Shell","amount":50,"expense_date":"' + todayISO() + '"}']);
    try {
      await extractReceipt('img', SPEC);
      assert.strictEqual(s.calls(), 1, 'a good date must never trigger the extra (paid) escalation call');
      assert.strictEqual(s.bodies()[0].model, 'cheap-model');
    } finally { s.restore(); }
  });
});

test('escalation: visionEscalate unset/equal to visionDefault never double-calls', async () => {
  await withModelRoutes({ visionDefault: 'same-model', visionEscalate: 'same-model' }, async () => {
    const s = stubGroqSeq(['{"merchant":"X","amount":1,"expense_date":"1924-06-01"}']); // implausible, but nothing to escalate TO
    try {
      await extractReceipt('img', SPEC);
      assert.strictEqual(s.calls(), 1, 'an unconfigured/equal escalate model must never spend twice for an identical result');
    } finally { s.restore(); }
  });
});

test('escalation: a FieldSpec with no expense_date column never escalates', async () => {
  await withModelRoutes({ visionDefault: 'cheap-model', visionEscalate: 'strong-model' }, async () => {
    const noDateSpec = { account_id: 'default', columns: SPEC.columns.filter((c) => c.key !== 'expense_date') };
    const s = stubGroqSeq(['{"merchant":"X","amount":1}']);
    try {
      await extractReceipt('img', noDateSpec);
      assert.strictEqual(s.calls(), 1, 'a spec that never tracks a date has nothing to escalate over');
    } finally { s.restore(); }
  });
});

test('escalation: an unrecovered date after escalation still returns the escalated (stronger-model) result', async () => {
  await withModelRoutes({ visionDefault: 'cheap-model', visionEscalate: 'strong-model' }, async () => {
    const s = stubGroqSeq([
      '{"merchant":"Cafe","amount":8.5,"expense_date":"1924-06-01"}',
      '{"merchant":"Cafe Real Name","amount":8.5,"expense_date":"1924-06-01"}', // strong model ALSO can't recover the date
    ]);
    try {
      const out = await extractReceipt('img', SPEC);
      assert.strictEqual(s.calls(), 2);
      // Still trusts the stronger model's overall read (merchant etc.) even though the date
      // itself stayed unreadable — normaliseDate's own "can't read at all" fallback (unchanged
      // by this feature) is what ultimately handles the still-bad date downstream.
      assert.strictEqual(out.fields.merchant, 'Cafe Real Name');
    } finally { s.restore(); }
  });
});

test('escalation: a network failure on the escalation call falls back to the original (never throws)', async () => {
  await withModelRoutes({ visionDefault: 'cheap-model', visionEscalate: 'strong-model' }, async () => {
    // orChat (lib/openrouter.js) has its own internal retry/backoff on a throw (up to 4
    // attempts) — a real network failure isn't a single call, it's that whole exhausted
    // sequence. This test only cares that extractReceipt's OWN try/catch around the
    // escalation attempt falls back to the original read afterward, never throws.
    const realFetch = global.fetch;
    let firstCallDone = false;
    global.fetch = async (_url, opt) => {
      if (!firstCallDone) {
        firstCallDone = true;
        return { text: async () => JSON.stringify({ choices: [{ message: { content: '{"merchant":"X","amount":1,"expense_date":"1924-06-01"}' } }] }) };
      }
      throw new Error('ECONNRESET');
    };
    try {
      const out = await extractReceipt('img', SPEC);
      assert.strictEqual(out.fields.merchant, 'X', 'a failed escalation keeps the original (best-effort) read, never throws');
    } finally { global.fetch = realFetch; }
  });
});

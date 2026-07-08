'use strict';
// #12 Custom Field Template — the FieldSpec engine (ARCHITECTURE §3.1). SHARED CONTRACT.
// OWNER: Barat. Jeevan's Excel (#2) + OCR (#4) + the dashboard all read FieldSpec.columns
// to know WHAT to extract and WHAT to output. Do NOT change the signatures of
// parseTemplate() / getFieldSpec() without announcing in WORKLOG first (frozen interface).
//
// FieldSpec = { account_id, columns: [{ key, label, type, required }], updated_at }
//   key      canonical machine key (e.g. "merchant") — what OCR extracts / DB stores
//   label    the exact header the customer wrote (e.g. "Vendor") — what Excel emits
//   type     "text" | "date" | "number" | "currency" | "category"
//   required whether the field must be present

const { cfg } = require('./config');
const { sbSelect, sbInsert, sbUpdate } = require('./supabase');

// Guardrails on untrusted CSV input (SOP §7.2 — validate at the boundary).
const MAX_COLS = 100;
const MAX_LABEL_LEN = 128;

// Header → canonical field dictionary. Matched against a normalised header
// (lowercased, trimmed, whitespace-collapsed). First match wins; unknown
// headers are kept verbatim as free-text columns (type "text").
const CANON = [
  { key: 'merchant',     type: 'text',     required: true,  match: /^(merchant|vendor|store|shop|supplier|payee|seller|business|company)$/ },
  { key: 'expense_date', type: 'date',     required: true,  match: /^(date|expense ?date|transaction ?date|txn ?date|purchase ?date|day)$/ },
  { key: 'amount',       type: 'currency', required: true,  match: /^(amount|total|grand ?total|total ?amount|price|cost|sum|paid|value)$/ },
  { key: 'currency',     type: 'text',     required: false, match: /^(currency|curr|ccy|currency ?code)$/ },
  { key: 'category',     type: 'category', required: false, match: /^(category|categories|type|expense ?type|class|kind)$/ },
  { key: 'subtotal',     type: 'currency', required: false, match: /^(subtotal|sub ?total|net|net ?amount)$/ },
  { key: 'tax',          type: 'currency', required: false, match: /^(tax|vat|gst|hst|sales ?tax)$/ },
  { key: 'remark',       type: 'text',     required: false, match: /^(remark|remarks|note|notes|description|desc|memo|comment|comments)$/ },
  { key: 'quantity',     type: 'number',   required: false, match: /^(quantity|qty|units?)$/ },
];

// The FieldSpec used when an account has not imported a template yet.
const DEFAULT_COLUMNS = [
  { key: 'merchant',     label: 'Merchant', type: 'text',     required: true },
  { key: 'expense_date', label: 'Date',     type: 'date',     required: true },
  { key: 'amount',       label: 'Amount',   type: 'currency', required: true },
  { key: 'currency',     label: 'Currency', type: 'text',     required: false },
  { key: 'category',     label: 'Category', type: 'category', required: false },
];

// Strip a leading UTF-8 BOM (Excel-exported CSVs commonly start with one).
function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

// P6 hardening (parse-side of issue #17): the customer-supplied `label` is the one
// untrusted string that flows downstream to the Excel export (#2) and the dashboard
// render. Strip C0/C1 control characters (NUL, etc.) here so malformed CSV can't smuggle
// control bytes into stored FieldSpec labels. This is defense-in-depth — render-time
// HTML-escaping remains the primary XSS defense in the frontend lane (issue #17).
// eslint-disable-next-line no-control-regex
function stripControls(s) { return String(s).replace(/[\u0000-\u001F\u007F-\u009F]/g, ''); }

// Remaining part of issue #17: by the time a header reaches us as a JS string,
// body-parser has already lossily decoded any invalid UTF-8 byte sequence to
// U+FFFD (the raw bytes are gone) -- so we can't "fix" the encoding here, only
// detect that it happened and reject at the boundary (SOP §7.2) instead of
// silently persisting a lossy label.
function hasReplacementChar(s) { return String(s).indexOf('�') !== -1; }

function normHeader(h) {
  return stripControls(stripBom(String(h))).trim().toLowerCase().replace(/\s+/g, ' ');
}

// Turn an unrecognised header into a safe snake_case key (alnum + underscore only).
function slugify(norm) {
  return norm.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Minimal RFC-4180-ish parser for a SINGLE line: handles quoted fields,
// embedded commas, and "" escaped quotes. Known limit: a quoted header
// containing an embedded newline will NOT parse correctly (the caller splits
// on \r?\n before this runs) — acceptable for header rows in practice.
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; }
      } else { cur += c; }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// Shared by parseTemplate (CSV) and parseExcelTemplate (.xlsx): maps a list of
// raw header strings to FieldSpec columns via the CANON dictionary, deduping
// by key (first occurrence wins). Thrown errors are prefixed by the CALLER
// (parseTemplate: / parseExcelTemplate:) so existing error-matching in
// routes/templates.js keeps working unchanged for both formats.
function columnsFromHeaders(headers) {
  const seen = new Set();
  const columns = [];
  let unknownN = 0;
  for (const label of headers) {
    const norm = normHeader(label);
    const hit = CANON.find(c => c.match.test(norm));
    let key, type, required;
    if (hit) {
      key = hit.key; type = hit.type; required = hit.required;
    } else {
      key = slugify(norm) || ('field_' + (++unknownN));
      type = 'text'; required = false;
    }
    if (seen.has(key)) continue; // dedupe: first header claiming a key wins
    seen.add(key);
    columns.push({ key, label: stripControls(label).slice(0, MAX_LABEL_LEN), type, required });
  }
  return columns;
}

// parseTemplate(csvText) -> FieldSpec.columns
// Reads the header row, maps each header to a canonical key (unknown -> "text"),
// dedupes by key (first occurrence wins). Throws on empty/invalid input.
function parseTemplate(csvText) {
  if (typeof csvText !== 'string') throw new Error('parseTemplate: csvText must be a string');
  const headerLine = stripBom(csvText).split(/\r?\n/).find(l => l.trim() !== '');
  if (!headerLine) throw new Error('parseTemplate: no header row found');

  const headers = splitCsvLine(headerLine)
    .map(h => stripBom(h).trim())
    .filter(h => h !== '');
  if (headers.length === 0) throw new Error('parseTemplate: header row is empty');
  if (headers.length > MAX_COLS) throw new Error('parseTemplate: too many columns (>' + MAX_COLS + ')');
  if (headers.some(hasReplacementChar)) {
    throw new Error('parseTemplate: header contains invalid/malformed text encoding');
  }

  return columnsFromHeaders(headers);
}

// parseExcelTemplate(buffer) -> FieldSpec.columns
// Reads a real .xlsx file's FIRST worksheet, row 1 = headers (same canonical
// mapping as parseTemplate/CSV — a company's own Excel column names like
// "Vendor" or "Supplier" map to the same "merchant" key a CSV header would).
// Uses exceljs (already a dependency for Excel EXPORT, ADR-012) to read
// instead. Async because exceljs's workbook load is async; throws (via a
// rejected promise) on a non-.xlsx buffer or an empty first row, mirroring
// parseTemplate's synchronous throws on bad CSV input.
async function parseExcelTemplate(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('parseExcelTemplate: buffer must be a Buffer');
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (e) {
    throw new Error('parseExcelTemplate: could not read this as an Excel (.xlsx) file');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('parseExcelTemplate: no worksheet found in this file');

  const headerRow = sheet.getRow(1);
  const headers = [];
  // ExcelJS cells are 1-indexed and sparse (eachCell skips truly empty cells);
  // stringify defensively since a header cell could hold a number/date/formula.
  headerRow.eachCell({ includeEmpty: false }, (cell) => {
    const v = cell.value && typeof cell.value === 'object' && 'result' in cell.value
      ? cell.value.result   // formula cell -> its computed value
      : cell.value;
    const s = v === null || v === undefined ? '' : String(v).trim();
    if (s !== '') headers.push(s);
  });
  if (headers.length === 0) throw new Error('parseExcelTemplate: header row is empty');
  if (headers.length > MAX_COLS) throw new Error('parseExcelTemplate: too many columns (>' + MAX_COLS + ')');

  return columnsFromHeaders(headers);
}

// A stored column must look like a real FieldSpec column, not just be truthy —
// defense-in-depth against a malformed/partial row (SOP §7.2), even though
// every writer of field_templates.columns is our own parseTemplate() output.
const VALID_TYPES = new Set(['text', 'date', 'number', 'currency', 'category']);
function isValidColumn(c) {
  return !!c && typeof c === 'object'
    && typeof c.key === 'string' && c.key !== ''
    && typeof c.label === 'string'
    && VALID_TYPES.has(c.type)
    && typeof c.required === 'boolean';
}

// Business category sets (ADR-021 Phase 5: "categories from FieldSpec"). An account's
// own chart of accounts, stored in field_templates.categories (nullable jsonb — absent
// means "use the default CATEGORIES everywhere", so personal accounts are untouched).
// Returned as an OPTIONAL FieldSpec.categories array — an additive extension of the
// frozen FieldSpec shape (announced in WORKLOG per SOP §4.6): existing consumers that
// only read .columns are unaffected, while lib/categorize.js's effectiveAllow() and the
// bot's category picker pick it up when present.
// Same boundary hardening as column labels (SOP §7.2): strings only, control chars
// stripped, trimmed, length-capped, case-insensitively deduped, count-capped. 'Others'
// is always appended when missing — the categorizer's fallback and the picker's
// "type a note" escape hatch both assume it exists.
const MAX_CATEGORIES = 64;
const MAX_CATEGORY_LEN = 64;
function sanitizeCategories(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const name = stripControls(raw).trim().slice(0, MAX_CATEGORY_LEN);
    if (name === '') continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_CATEGORIES) break;
  }
  if (out.length === 0) return null;
  // 'Others' must always be present (the categorizer fallback + the picker's "type a
  // note" escape hatch both assume it). Reserve a slot for it within the cap rather
  // than letting the append push the total to MAX_CATEGORIES + 1.
  if (!seen.has('others')) {
    if (out.length >= MAX_CATEGORIES) out.pop();
    out.push('Others');
  }
  return out;
}

// getFieldSpec(account_id) -> FieldSpec
// Reads the account's stored template; falls back to DEFAULT_COLUMNS if none
// (or if the stored row's columns don't shape-check as valid FieldSpec entries).
// FieldSpec.categories is included ONLY when the stored row carries a valid
// non-empty category set (see sanitizeCategories above).
async function getFieldSpec(account_id = cfg.ACCOUNT_ID) {
  const rows = await sbSelect('field_templates', { eq: { account_id }, order: 'updated_at.desc', limit: 1 });
  const row = rows[0];
  const columns = row && Array.isArray(row.columns) ? row.columns.filter(isValidColumn) : [];
  if (columns.length === 0) {
    return { account_id, columns: DEFAULT_COLUMNS.map(c => ({ ...c })), updated_at: null };
  }
  const spec = { account_id, columns, updated_at: row.updated_at || null };
  const categories = sanitizeCategories(row.categories);
  if (categories) spec.categories = categories;
  return spec;
}

// saveTemplate(csvText, opts) -> FieldSpec
// Parses + persists a template for the account (upsert on (account_id, name)).
// Accepts raw CSV text or an already-parsed columns array.
// NOTE (single-account v1 limitation): `account_id` here is accepted for the
// future multi-tenant signature, but sbInsert/sbUpdate (lib/supabase.js) always
// scope writes to cfg.ACCOUNT_ID — passing a non-default account_id will write
// under the default account, not the one named. Harmless today (account_id is
// always the default in v1); revisit when lib/supabase.js grows an account_id
// override for multi-tenant (announce in WORKLOG first — it's a shared contract).
// `categories` (optional, ADR-021): the account's own chart of accounts.
//   - omitted/undefined  -> stored category set left untouched (re-importing columns
//                           never silently wipes a business's category list);
//   - an array           -> sanitized + stored; an array that sanitizes to nothing
//                           (e.g. []) explicitly CLEARS the stored set (back to defaults);
//   - anything else      -> reject-and-explain, same convention as bad columns.
async function saveTemplate(csvTextOrColumns, { account_id = cfg.ACCOUNT_ID, name = 'default', categories } = {}) {
  const columns = typeof csvTextOrColumns === 'string'
    ? parseTemplate(csvTextOrColumns)
    : csvTextOrColumns;
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('saveTemplate: columns must be a non-empty array');
  }
  if (categories !== undefined && !Array.isArray(categories)) {
    throw new Error('saveTemplate: categories must be an array of category names');
  }
  const updated_at = new Date().toISOString();
  const patch = { columns, updated_at };
  if (categories !== undefined) patch.categories = sanitizeCategories(categories); // null = clear
  const existing = await sbSelect('field_templates', { eq: { account_id, name } });
  if (existing[0]) {
    await sbUpdate('field_templates', { id: existing[0].id }, patch);
  } else {
    await sbInsert('field_templates', { name, ...patch });
  }
  const spec = { account_id, columns, updated_at };
  // Echo the EFFECTIVE stored set: the one just written, or (on a columns-only
  // re-import of an existing template) the untouched previously-stored one — so the
  // response always matches what getFieldSpec would now return.
  const effective = categories !== undefined ? patch.categories
    : sanitizeCategories(existing[0] && existing[0].categories);
  if (effective) spec.categories = effective;
  return spec;
}

module.exports = { parseTemplate, parseExcelTemplate, getFieldSpec, saveTemplate, sanitizeCategories, DEFAULT_COLUMNS };

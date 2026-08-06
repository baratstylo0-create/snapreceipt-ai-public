'use strict';
// Pure money + date helpers. Moved verbatim from server.js (no behaviour change).

const CUR_SYM = { USD: '$', AUD: 'A$', NZD: 'NZ$', SGD: 'S$', MYR: 'RM', EUR: '€', GBP: '£', INR: '₹', JPY: '¥', CAD: 'C$' };
const curSym = c => CUR_SYM[String(c || '').toUpperCase()] || (String(c || '').toUpperCase() + ' ');
const fmtMoney = (v, c) => curSym(c) + (Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function todayISO() { return new Date().toISOString().slice(0, 10); }

// A receipt timestamp sometimes rides along with the date (e.g. a thermal print's
// "30/06/2026 12:46:53", or a POS's 12-hour "7/21/26 2:06 PM" — the exact live receipt
// this was found on, 2026-07-22). Strip a trailing HH:MM[:SS] with an optional AM/PM
// (issue #149, extended) so the date portion still matches below instead of falling
// through as unparseable.
function stripTrailingTime(s) {
  return s.replace(/[T\s]+\d{1,2}:\d{2}(:\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?\s*$/, '');
}

const pad2 = n => String(n).padStart(2, '0');
const isoOf = (y, m, d) => y + '-' + pad2(m) + '-' + pad2(d);

// Expand a 2-digit year to a 4-digit one, anchored to the CURRENT era (Owner directive
// 2026-07-22: "a bill you're uploading now is a current bill — 26 means 2026, never 2021
// or 1926"). So `yy` maps to 2000+yy, unless that lands absurdly far in the future (more
// than a year ahead of now — no real receipt is), in which case it's a genuinely old
// document and we fall back to 1900+yy. `now` injectable for deterministic tests.
function expandYear(yy, now) {
  const nowYear = (now instanceof Date ? now : new Date()).getUTCFullYear();
  const candidate = 2000 + yy;
  return candidate > nowYear + 1 ? 1900 + yy : candidate;
}

// resolveReceiptDate(raw, opts?) -> { iso: 'YYYY-MM-DD', ambiguous: bool } | null.
// THE smart date-format resolver (Owner directive 2026-07-22). Receipts arrive in mixed
// formats — most Malaysian ones are D/M/Y, but some POS systems (e.g. Mesincashier2u)
// print M/D/Y, plus 2-digit years. Rather than let the AI model guess the format (which
// misread 7/21/26 as 2021-07-26), format logic lives HERE, deterministically:
//   1. ISO YYYY-MM-DD passes straight through.
//   2. For D/D/Y numeric dates, the "impossible value" rule disambiguates: any part >12
//      MUST be the day, which fixes the month for free (7/24/26 -> 24 is the day -> month
//      is 7 -> 24 Jul 2026), catching odd M/D/Y receipts without breaking normal D/M/Y ones.
//   3. A 2-digit year is expanded to the current era (see expandYear) — 26 -> 2026.
//   4. Only a GENUINELY ambiguous date (both parts <=12, e.g. 3/4/26) can't be resolved by
//      the numbers alone; it falls back to the account default (D/M/Y unless preferDMY:false)
//      and is returned with ambiguous:true so the caller can flag it for a human to verify.
// PURE: no I/O; `now` injectable. null = "this doesn't look like a date at all".
function resolveReceiptDate(raw, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const preferDMY = opts.preferDMY !== false;   // default true: Day/Month/Year
  const s = stripTrailingTime(String(raw || '').trim());
  if (!s) return null;

  // (1) Already ISO.
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    return (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) ? { iso: isoOf(y, mo, d), ambiguous: false } : null;
  }

  // (2) Numeric D/D/D with / - or . separators.
  m = s.match(/^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/);
  if (!m) return null;

  let year, first, second, yearFirst;
  if (m[1].length === 4) {                 // YYYY/M/D
    year = +m[1]; first = +m[2]; second = +m[3]; yearFirst = true;
  } else {                                  // D/M/YY(YY) or M/D/YY(YY)
    first = +m[1]; second = +m[2]; yearFirst = false;
    year = m[3].length === 4 ? +m[3] : expandYear(+m[3], now);
  }
  if (first > 31 || second > 31) return null;

  let day, month, ambiguous = false;
  if (yearFirst) {                          // Y/M/D convention; tolerate Y/D/M if forced
    month = first; day = second;
    if (month > 12 && day <= 12) { const t = month; month = day; day = t; }
  } else if (first > 12 && second > 12) {
    return null;                            // impossible — neither can be a month
  } else if (first > 12) {
    day = first; month = second;            // first must be the day -> D/M order
  } else if (second > 12) {
    month = first; day = second;            // second must be the day -> M/D order (e.g. 7/24)
  } else {                                  // both <=12: genuinely ambiguous
    ambiguous = true;
    if (preferDMY) { day = first; month = second; } else { month = first; day = second; }
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { iso: isoOf(year, month, day), ambiguous };
}

// parseDateLoose(raw) -> 'YYYY-MM-DD' | null. Pure — unlike normaliseDate, this NEVER
// falls back to today; null means "this genuinely doesn't look like a date at all",
// which is exactly the signal lib/confidence.js needs (issue #149) to flag an
// unreadable date instead of silently trusting whatever normaliseDate() defaults to.
// Delegates format logic to resolveReceiptDate; a user-typed reply (bot.js) is DD/MM/YYYY.
function parseDateLoose(raw, opts) {
  const r = resolveReceiptDate(raw, opts);
  return r ? r.iso : null;
}

// Normalise a messy OCR date to ISO YYYY-MM-DD via the smart resolver; cap future to
// today (with the same RECEIPT_FUTURE_GRACE_DAYS tolerance isDatePlausible uses below,
// not a hard same-instant cap — issue found 2026-07-22 while testing the smart resolver:
// this server runs in UTC, but receipts are read/printed in Malaysia time (UTC+8), so a
// receipt genuinely dated "today" in MYT can still be "tomorrow" by UTC's clock for a few
// hours each night. Without the grace window, that legitimate same-day MYT date would get
// wrongly capped backwards. Falls back to today only when the value can't be read at all.
function normaliseDate(raw) {
  let date = parseDateLoose(raw) || todayISO();
  const capAt = Date.parse(todayISO() + 'T00:00:00Z') + RECEIPT_FUTURE_GRACE_DAYS * 86400000;
  if (Date.parse(date + 'T00:00:00Z') > capAt) date = todayISO();
  return date;
}

// isDatePlausible(raw, opts?) -> boolean. Answers "is the date the model read a SANE
// receipt date, or a likely misread?" — a guard the presence-based confidence check
// (lib/confidence.js) structurally cannot give: it only asks "did the value parse", so a
// wrong-but-parseable date like a misread year (2026 -> 2024) scores 'high' and is trusted.
// This range-checks the parsed date instead. Used by lib/ocr.js to REFUSE + ask for a clear
// re-photo rather than silently save a receipt under the wrong year (which then hides it from
// the dashboard's date filter and corrupts the RC-<year>-#### voucher sequence).
//   true  = parses AND sits inside [today - maxAgeDays, today + futureGraceDays]
//   false = unparseable, too old (likely a misread year), or too far in the future
// Judge the RAW model value here — NOT normaliseDate()'s output, which has already silently
// capped/defaulted a bad date to today and would always look plausible.
// PURE: no I/O; `now` injectable for deterministic tests. Env override RECEIPT_MAX_AGE_DAYS.
const RECEIPT_MAX_AGE_DAYS = Number(process.env.RECEIPT_MAX_AGE_DAYS || '366') || 366;
const RECEIPT_FUTURE_GRACE_DAYS = 2; // MYT(UTC+8)/UTC midnight skew — a "today" print can read +1d
function isDatePlausible(raw, opts = {}) {
  const iso = parseDateLoose(raw);
  if (!iso) return false;
  const maxAgeDays = opts.maxAgeDays != null ? opts.maxAgeDays : RECEIPT_MAX_AGE_DAYS;
  const futureGraceDays = opts.futureGraceDays != null ? opts.futureGraceDays : RECEIPT_FUTURE_GRACE_DAYS;
  const now = opts.now instanceof Date ? opts.now : new Date();
  // Compare at UTC-midnight granularity so a same-day time-of-day never tips the window.
  const day = 86400000;
  const t = Date.parse(iso + 'T00:00:00Z');
  if (!isFinite(t)) return false;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (t > today + futureGraceDays * day) return false;   // too far in the future
  if (t < today - maxAgeDays * day) return false;         // too old — likely a misread year
  return true;
}

module.exports = { CUR_SYM, curSym, fmtMoney, todayISO, normaliseDate, parseDateLoose, isDatePlausible, resolveReceiptDate };

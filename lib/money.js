'use strict';
// Pure money + date helpers. Moved verbatim from server.js (no behaviour change).

const CUR_SYM = { USD: '$', AUD: 'A$', NZD: 'NZ$', SGD: 'S$', MYR: 'RM', EUR: '€', GBP: '£', INR: '₹', JPY: '¥', CAD: 'C$' };
const curSym = c => CUR_SYM[String(c || '').toUpperCase()] || (String(c || '').toUpperCase() + ' ');
const fmtMoney = (v, c) => curSym(c) + (Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function todayISO() { return new Date().toISOString().slice(0, 10); }

// A receipt timestamp sometimes rides along with the date (e.g. a thermal print's
// "30/06/2026 12:46:53"). Strip a trailing HH:MM[:SS] (issue #149) so the date portion
// still matches below instead of falling through as unparseable.
function stripTrailingTime(s) {
  return s.replace(/[T\s]+\d{1,2}:\d{2}(:\d{2})?\s*$/, '');
}

// parseDateLoose(raw) -> 'YYYY-MM-DD' | null. Pure — unlike normaliseDate, this NEVER
// falls back to today; null means "this genuinely doesn't look like a date at all",
// which is exactly the signal lib/confidence.js needs (issue #149) to flag an
// unreadable date instead of silently trusting whatever normaliseDate() defaults to.
function parseDateLoose(raw) {
  const date = stripTrailingTime(String(raw || '').trim());
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const m = date.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  return m ? (m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0')) : null;
}

// Normalise a messy OCR date to ISO YYYY-MM-DD; assume DD/MM/YYYY; cap future to today;
// falls back to today only when parseDateLoose can't find a date at all.
function normaliseDate(raw) {
  let date = parseDateLoose(raw) || todayISO();
  if (date > todayISO()) date = todayISO();
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

module.exports = { CUR_SYM, curSym, fmtMoney, todayISO, normaliseDate, parseDateLoose, isDatePlausible };

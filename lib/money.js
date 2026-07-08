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

module.exports = { CUR_SYM, curSym, fmtMoney, todayISO, normaliseDate, parseDateLoose };

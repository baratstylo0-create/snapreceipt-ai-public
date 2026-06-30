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

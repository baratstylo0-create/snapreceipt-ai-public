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

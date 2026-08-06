'use strict';
// billing.js (2026-07-30) — the Free-tier 20-receipts/month cap, gating real (non-guest)
// personal owner accounts before an OCR read runs, mirroring lib/ocr.js's guest cap but
// for real billing rather than a trial.
// 2026-08-06 (Barat: "20 receipts per month for every user" — fixes a QA-caught bug):
// was scoped at the whole ACCOUNT level, so every real owner signup on one deployment
// shared one pool — a second signup's cap counted the first account's receipts too.
// Now scoped by expenses.created_by_user_id (lib/ocr.js/lib/bot.js/routes/upload.js all
// tag it on every owner capture), a column separate from owner_user_id (guest-only,
// untouched by this change).
const { sbSelect } = require('./supabase');

const FREE_TIER_MONTHLY_CAP = 20;
const FREE_TIER_CAP_MESSAGE = '🔒 *You\'ve used all 20 free receipts this month.*\n\nUpgrade to Pro for unlimited receipts — RM 12.90/month or RM 99/year. Your existing receipts stay right where they are.';

// getUserPlan(userId) -> 'free' | 'pro'. Fails safe to 'free' on any lookup error — never
// blocks capture entirely just because a plan lookup hiccuped (same fail-open reasoning as
// every other soft-gate in this codebase, e.g. detectAnomalies/categorizeLineItems).
async function getUserPlan(userId, deps = {}) {
  if (!userId) return 'free';
  const select = deps.sbSelect || sbSelect;
  try {
    const rows = await select('users', { eq: { id: userId }, limit: 1 });
    return (rows[0] && rows[0].plan === 'pro') ? 'pro' : 'free';
  } catch (e) {
    console.error('[billing] getUserPlan failed, defaulting to free:', e.message);
    return 'free';
  }
}

// countExpensesThisMonth(userId) -> how many real receipts THIS SPECIFIC owner has saved
// since the 1st of the current calendar month. Filters by created_by_user_id=userId (2026-08-06
// fix — was account-wide before). userId is required; a missing one returns 0 rather than
// accidentally counting every untagged historical row (which would include every expense
// captured before this column existed).
async function countExpensesThisMonth(userId, deps = {}) {
  if (!userId) return 0;
  const select = deps.sbSelect || sbSelect;
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const rows = await select('expenses', {
    eq: { created_by_user_id: userId },
    extra: 'deleted_at=is.null&created_at=gte.' + encodeURIComponent(monthStart.toISOString()),
  });
  return Array.isArray(rows) ? rows.length : 0;
}

// checkFreeTierCap(userId) -> { capped: boolean, used: number, limit: number }. Callers
// gate on `capped`; `used`/`limit` are exposed too (2026-08-06) so /api/config can show the
// real per-user count instead of the frontend's old hardcoded placeholder.
async function checkFreeTierCap(userId, deps = {}) {
  const plan = await getUserPlan(userId, deps);
  if (plan === 'pro') return { capped: false, used: 0, limit: FREE_TIER_MONTHLY_CAP };
  try {
    const used = await countExpensesThisMonth(userId, deps);
    return { capped: used >= FREE_TIER_MONTHLY_CAP, used, limit: FREE_TIER_MONTHLY_CAP };
  } catch (e) {
    console.error('[billing] countExpensesThisMonth failed, failing open (not capped):', e.message);
    return { capped: false, used: 0, limit: FREE_TIER_MONTHLY_CAP };
  }
}

module.exports = { FREE_TIER_MONTHLY_CAP, FREE_TIER_CAP_MESSAGE, getUserPlan, countExpensesThisMonth, checkFreeTierCap };

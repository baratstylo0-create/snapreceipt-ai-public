'use strict';
// billing.js (2026-07-30) — the Free-tier 20-receipts/month cap, gating real (non-guest)
// personal owner accounts before an OCR read runs, mirroring lib/ocr.js's guest cap but
// for real billing rather than a trial. Scoped at the ACCOUNT level (not per-owner-user),
// same "managed-silo: one account per instance" assumption the rest of this codebase
// already makes (lib/auth.js's scopeForUser comment) — this is a KNOWN, already-documented
// gap (see the plan file's "MAJOR PIVOT" section), not a new one introduced here. On a
// deployment with more than one real owner row (e.g. test accounts), the cap is shared
// across them, exactly like every other expenses view already is today.
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

// countExpensesThisMonth() -> how many real (non-guest) receipts this account has saved
// since the 1st of the current calendar month. owner_user_id=is.null excludes guest-tagged
// rows (Guest Mode's trial receipts are a separate, unrelated cap and must never count
// against — or be counted toward — a real account's billing).
async function countExpensesThisMonth(deps = {}) {
  const select = deps.sbSelect || sbSelect;
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const rows = await select('expenses', {
    extra: 'deleted_at=is.null&owner_user_id=is.null&created_at=gte.' + encodeURIComponent(monthStart.toISOString()),
  });
  return Array.isArray(rows) ? rows.length : 0;
}

// checkFreeTierCap(userId) -> { capped: boolean }. Callers only need to gate on `capped` —
// a 'pro' plan short-circuits to {capped:false} without even running the count query.
async function checkFreeTierCap(userId, deps = {}) {
  const plan = await getUserPlan(userId, deps);
  if (plan === 'pro') return { capped: false };
  try {
    const used = await countExpensesThisMonth(deps);
    return { capped: used >= FREE_TIER_MONTHLY_CAP };
  } catch (e) {
    console.error('[billing] countExpensesThisMonth failed, failing open (not capped):', e.message);
    return { capped: false };
  }
}

module.exports = { FREE_TIER_MONTHLY_CAP, FREE_TIER_CAP_MESSAGE, getUserPlan, countExpensesThisMonth, checkFreeTierCap };

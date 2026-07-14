'use strict';

// Automation-impact metrics (round-2 plan R2 / task C4 backend).
//
// PURE aggregator — takes plain arrays in, returns computed numbers. No DB, no
// I/O, no dependencies, so correctness is provable in unit tests (the whole point
// of splitting C4 into a testable backend + a thin Overview render). The route
// (routes/metrics.js) does the scoped fetch and hands the rows here.
//
// Every number is derived from columns that ALREADY exist — created_at,
// updated_at, status, confidence jsonb — plus the category_corrections table.
// No new capture, no migration (round-2 plan §R2). The ONE exception is
// "statements generated": nothing logs a statement export today, so it is
// returned as null and flagged unavailable rather than faked — see meta.

// Statuses that mean a human had to step in (vs. straight-through processing).
const ATTENTION_STATUSES = new Set(['needs_review', 'awaiting_category', 'rejected']);
// Statuses that indicate the review lifecycle actually touched the row, used for
// dwell time (created → resolved). A plain 'saved' row was never in a queue.
const REVIEWED_STATUSES = new Set(['approved', 'rejected', 'needs_review']);

const DEFAULT_MINUTES_PER_RECEIPT = 2.5;
const TOP_CATEGORIES = 5;

function round1(n) { return Math.round(n * 10) / 10; }

function isActive(e) { return e && e.deleted_at == null; }

// A row "needed no edit" when it never entered a human-attention status AND its
// OCR confidence carried no low-confidence field. Missing/blank confidence is
// treated as clean (nothing flagged it) — the attention-status check still
// catches rows a human actually reviewed.
function hasLowConfidence(e) {
  const c = e && e.confidence;
  if (!c || typeof c !== 'object') return false;
  for (const k of Object.keys(c)) {
    if (String(c[k]).toLowerCase() === 'low') return true;
  }
  return false;
}

function neededAttention(e) {
  return ATTENTION_STATUSES.has(String(e && e.status)) || hasLowConfidence(e);
}

// updated_at − created_at in minutes, or null if either timestamp is unusable.
function dwellMinutes(e) {
  const start = Date.parse(e && e.created_at);
  const end = Date.parse(e && e.updated_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / 60000;
}

// { field: count } of low-confidence occurrences → array sorted desc by count
// (ties fall back to field name for a stable order).
function lowConfidenceByField(expenses) {
  const tally = Object.create(null);
  for (const e of expenses) {
    const c = e && e.confidence;
    if (!c || typeof c !== 'object') continue;
    for (const k of Object.keys(c)) {
      if (String(c[k]).toLowerCase() === 'low') tally[k] = (tally[k] || 0) + 1;
    }
  }
  return Object.keys(tally)
    .map((field) => ({ field, count: tally[field] }))
    .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
}

// category_corrections rows → top-N categories by logged hit_count.
function mostCorrectedCategories(corrections) {
  const rows = Array.isArray(corrections) ? corrections : [];
  return rows
    .map((r) => ({ category: String(r && r.category), count: Number(r && r.hit_count) || 0 }))
    .filter((r) => r.category && r.category !== 'undefined')
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
    .slice(0, TOP_CATEGORIES);
}

// Main entry. `expenses` is expected to already be period-scoped by the caller.
function computeMetrics(expenses, opts = {}) {
  const rows = (Array.isArray(expenses) ? expenses : []).filter(isActive);
  const mmpr = Number.isFinite(Number(opts.manualMinutesPerReceipt))
    ? Number(opts.manualMinutesPerReceipt)
    : DEFAULT_MINUTES_PER_RECEIPT;

  const processed = rows.length;
  let attentionCount = 0;
  const dwells = [];
  for (const e of rows) {
    if (neededAttention(e)) attentionCount += 1;
    if (REVIEWED_STATUSES.has(String(e.status))) {
      const d = dwellMinutes(e);
      if (d != null) dwells.push(d);
    }
  }
  const noEditCount = processed - attentionCount;
  const pct = (n) => (processed ? round1((n / processed) * 100) : 0);
  const avgDwell = dwells.length
    ? round1(dwells.reduce((s, d) => s + d, 0) / dwells.length)
    : null;

  return {
    client: {
      receiptsProcessed: processed,
      noEditCount,
      noEditPct: pct(noEditCount),
      hoursSaved: round1((processed * mmpr) / 60),
      statementsGenerated: null, // no audit trail yet — see meta.statementsGeneratedAvailable
    },
    internal: {
      attentionCount,
      attentionRate: pct(attentionCount),
      avgDwellMinutes: avgDwell,
      lowConfidenceByField: lowConfidenceByField(rows),
      mostCorrectedCategories: mostCorrectedCategories(opts.corrections),
    },
    meta: {
      manualMinutesPerReceipt: mmpr,
      statementsGeneratedAvailable: false,
    },
  };
}

module.exports = {
  computeMetrics,
  // exported for focused unit tests / reuse
  neededAttention,
  hasLowConfidence,
  dwellMinutes,
  lowConfidenceByField,
  mostCorrectedCategories,
};

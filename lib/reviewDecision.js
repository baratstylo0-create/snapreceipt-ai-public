'use strict';
// #5 admin review queue — pure decision-machine guard, extracted out of routes/review.js
// (ADR-019 prep) so both the HTTP route and a future agent tool can reuse the exact same
// validation without duplicating it. No I/O here (no sbSelect/sbUpdate) — that stays in
// the caller. Every function here must never throw, even on garbage input.

const DECISION_STATUS = { approve: 'approved', reject: 'rejected' };

// resolveDecision('approve'|'reject') -> { ok:true, status } else { ok:false, error }
function resolveDecision(decision) {
  const status = DECISION_STATUS[decision];
  if (!status) return { ok: false, error: 'decision must be "approve" or "reject"' };
  return { ok: true, status };
}

// canDecide(currentRow) -> { ok:true } if the row is pending review, else a typed error.
// Status machine (saved → needs_review → approved|rejected): only a pending expense may be
// decided. Reject re-decision of an already-approved/rejected row or a never-flagged 'saved' one.
function canDecide(currentRow) {
  if (!currentRow) return { ok: false, code: 404, error: 'expense not found' };
  if (currentRow.status !== 'needs_review') {
    return { ok: false, code: 409, error: 'expense is not pending review (status=' + currentRow.status + ')' };
  }
  return { ok: true };
}

// buildReviewAudit(currentAnomaly, decision, note) -> merged anomaly object with `.review`
// set. Tolerant of a non-object currentAnomaly (falls back to {}), same as the route did.
function buildReviewAudit(currentAnomaly, decision, note) {
  const anomaly = (currentAnomaly && typeof currentAnomaly === 'object' && !Array.isArray(currentAnomaly))
    ? currentAnomaly : {};
  anomaly.review = { decision, note, at: new Date().toISOString() };
  return anomaly;
}

module.exports = { DECISION_STATUS, resolveDecision, canDecide, buildReviewAudit };

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

// buildReviewAudit(currentAnomaly, decision, note, who?) -> merged anomaly object with `.review`
// set. Tolerant of a non-object currentAnomaly (falls back to {}), same as the route did.
// `who` (Phase 4, optional): { role, override? } — records decided_by_role (clerk-first audit
// trail) and overrode:true when an admin re-decides. Personal callers pass nothing → old shape.
function buildReviewAudit(currentAnomaly, decision, note, who) {
  const anomaly = (currentAnomaly && typeof currentAnomaly === 'object' && !Array.isArray(currentAnomaly))
    ? currentAnomaly : {};
  anomaly.review = { decision, note, at: new Date().toISOString() };
  if (who && who.role) {
    anomaly.review.decided_by_role = who.role;
    if (who.override) anomaly.review.overrode = true;
  }
  return anomaly;
}

// ---- Phase 4 (ADR-021): the staff-first decision gate ------------------------
// canRoleDecide(row, scope, { valveDays, now }) -> { ok:true, override? } | { ok:false, code, error }.
//
// Personal mode (scope == null): exactly canDecide — any caller decides a pending row.
// Business mode:
//   clerk : own-branch pending rows only (clerk-first; cross-branch 403; no re-decide 409).
//   admin : may OVERRIDE an already-decided row any time (override:true in the result), but may
//           ORIGINATE a decision on a clerk's branch only after the row has waited `valveDays`
//           (the safety valve). Rows on the admin's OWN branch (Head Office — no clerk beneath)
//           and untagged rows are admin-first immediately. Never-flagged 'saved' rows stay 409.
// Pure, no I/O, never throws — `now` is injectable for tests.
const DECIDED = new Set(['approved', 'rejected']);

function canRoleDecide(row, scope, opts = {}) {
  if (!row) return { ok: false, code: 404, error: 'expense not found' };
  if (!scope || !scope.role) return canDecide(row); // personal mode — unchanged

  const valveDays = Number.isFinite(opts.valveDays) ? opts.valveDays : 7;
  const now = typeof opts.now === 'function' ? opts.now() : Date.now();

  if (scope.role === 'clerk') {
    if (String(row.branch_id == null ? '' : row.branch_id) !== String(scope.branch_id)) {
      return { ok: false, code: 403, error: 'not your branch' };
    }
    return canDecide(row); // pending-only; decided rows 409 (only the admin overrides)
  }

  // admin
  if (DECIDED.has(row.status)) return { ok: true, override: true };
  if (row.status !== 'needs_review') {
    return { ok: false, code: 409, error: 'expense is not pending review (status=' + row.status + ')' };
  }
  const adminFirst = row.branch_id == null || row.branch_id === ''
    || String(row.branch_id) === String(scope.branch_id);
  if (adminFirst) return { ok: true };
  const ageMs = now - Date.parse(row.created_at || '');
  if (Number.isFinite(ageMs) && ageMs >= valveDays * 86400000) return { ok: true }; // valve open
  return { ok: false, code: 403, error: 'the branch clerk decides first — the admin valve opens ' + valveDays + ' days after flagging' };
}

module.exports = { DECISION_STATUS, resolveDecision, canDecide, canRoleDecide, buildReviewAudit };

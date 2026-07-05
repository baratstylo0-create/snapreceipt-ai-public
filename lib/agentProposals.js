'use strict';
// ADR-019 — agentic write actions: the pending-proposal store.
//
// This is the security boundary between "the model wants to do X" and "X actually
// happens". A proposal is created when the model wants to make a write (edit a
// row, delete a row, resolve a review decision, add a template field). Some kinds
// may be auto-confirmed by an "auto mode" without a human in the loop; others
// (delete, add-template-field) must ALWAYS be explicitly confirmed by the user —
// that rule is encoded here, once, so it can't be bypassed by any caller upstream.
//
// Pure/in-memory/dependency-light on purpose: no network, no DB, no other repo
// imports. Only node built-ins.
const crypto = require('crypto');

// The 4 proposal kinds, frozen so nothing can mutate the set at runtime.
const KINDS = Object.freeze({
  EDIT: 'edit',
  DELETE: 'delete',
  REVIEW_DECISION: 'review-decision',
  ADD_TEMPLATE_FIELD: 'add-template-field',
});

const KNOWN_KINDS = new Set(Object.values(KINDS));

// Kinds that MAY be auto-confirmed by an auto-mode agent without an explicit
// user confirm. Everything else (notably 'delete' and 'add-template-field')
// must always go through an explicit confirm — that is a hard security
// invariant of this module, not a policy decision made by callers.
const AUTO_CONFIRMABLE = Object.freeze(new Set([KINDS.EDIT, KINDS.REVIEW_DECISION]));

function canAutoConfirm(kind) {
  return AUTO_CONFIRMABLE.has(kind);
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Module-level store: id -> proposal record (including expiresAt).
const store = new Map();

function createProposal(input, opts) {
  const { kind, args, summary, diff } = input || {};
  if (!KNOWN_KINDS.has(kind)) {
    return { error: 'unknown proposal kind' };
  }
  const now = (opts && typeof opts.now === 'function') ? opts.now : Date.now;
  const ttlMs = (opts && typeof opts.ttlMs === 'number' && Number.isFinite(opts.ttlMs))
    ? opts.ttlMs
    : DEFAULT_TTL_MS;

  const proposal = {
    id: 'p_' + crypto.randomUUID(),
    kind,
    args,
    summary,
    diff,
    expiresAt: now() + ttlMs,
  };

  store.set(proposal.id, proposal);
  return proposal;
}

function _isExpired(proposal, now) {
  return !proposal || typeof proposal.expiresAt !== 'number' || now() >= proposal.expiresAt;
}

function consumeProposal(id, opts) {
  const now = (opts && typeof opts.now === 'function') ? opts.now : Date.now;
  if (typeof id !== 'string' || !id) return null;

  let proposal;
  try {
    proposal = store.get(id);
  } catch (_e) {
    return null;
  }
  if (!proposal) return null;

  if (_isExpired(proposal, now)) {
    store.delete(id);
    return null;
  }

  // Single-use: remove on successful consume.
  store.delete(id);
  return proposal;
}

function peekProposal(id, opts) {
  const now = (opts && typeof opts.now === 'function') ? opts.now : Date.now;
  if (typeof id !== 'string' || !id) return null;

  let proposal;
  try {
    proposal = store.get(id);
  } catch (_e) {
    return null;
  }
  if (!proposal) return null;

  if (_isExpired(proposal, now)) {
    store.delete(id);
    return null;
  }

  return proposal;
}

// --- test-only helpers -------------------------------------------------
function _reset() {
  store.clear();
}

function _size() {
  return store.size;
}

module.exports = {
  KINDS,
  AUTO_CONFIRMABLE,
  canAutoConfirm,
  createProposal,
  consumeProposal,
  peekProposal,
  _reset,
  _size,
};

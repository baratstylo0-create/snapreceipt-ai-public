'use strict';
// #12 structured logging (Phase 1, SYSTEM_COMPLETENESS). Emits ONE JSON line per event to
// stderr so a host's log aggregator (Render/Fly platform logs, or a shipper) can parse,
// search, and alert on failures — instead of unstructured `console.error` prose.
//
// ADR-002 is the hard rule: this NEVER logs request bodies, receipt bytes, PII, or card data.
// Guardrails baked in: `msg` is length-capped, `where` is length-capped, and any NESTED-OBJECT
// value in `extra` is DROPPED (so a caller can't accidentally spread a request body / row into
// the log). Only scalar extras (status, method, path…) survive. No new dependency.
const MSG_MAX = 500;
const WHERE_MAX = 60;
const STR_EXTRA_MAX = 200;

function line(level, where, msg, extra) {
  const rec = { ts: new Date().toISOString(), level, where: String(where == null ? '' : where).slice(0, WHERE_MAX) };
  if (msg != null) rec.msg = String(msg).slice(0, MSG_MAX);
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) {
      const v = extra[k];
      if (v == null) continue;
      if (typeof v === 'object') continue;               // never serialize nested objects (PII/body guard)
      rec[k] = typeof v === 'string' ? v.slice(0, STR_EXTRA_MAX) : v;
    }
  }
  return JSON.stringify(rec);
}

// logError(where, err, extra?) — err may be an Error (uses .message) or a plain string.
function logError(where, err, extra) {
  const msg = err && typeof err === 'object' ? (err.message || String(err)) : err;
  console.error(line('error', where, msg, extra));
}

// logWarn(where, msg, extra?) — for degraded-but-not-failed conditions (e.g. a slow dep).
function logWarn(where, msg, extra) {
  console.warn(line('warn', where, msg, extra));
}

// logSecurity(event, fields?) — SEC-6 (ADR-025) security-event channel. `event` is the type
// (auth_fail / scope_deny / rate_limit / …) and lands in `where` so a log query can filter
// `level=security` and group by it. Inherits line()'s ADR-002 guards (caps + nested-object
// drop), so a body/token/PII in `fields` can never be serialized.
function logSecurity(event, fields) {
  console.warn(line('security', event, undefined, fields));
}

module.exports = { logError, logWarn, logSecurity };

'use strict';
const path = require('path');
const express = require('express');
const { cfg } = require('../lib/config');
const supabase = require('../lib/supabase');            // import-only (Barat's) — reachability probe
const storage = require('../lib/storage');              // storage reachability probe (ADR-018)
const { createRateLimiter } = require('../lib/ratelimit');
const { logWarn } = require('../lib/log');

// #13 monitoring: /ready touches the DB, so bound it with a generous limiter (SEC-7).
const readyLimiter = createRateLimiter({ max: Number(process.env.READY_RATE_MAX) || 60 });

// Bound the probe so /ready can never hang on a stuck dependency. unref so the timer
// never keeps the process alive.
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    if (t.unref) t.unref();
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

module.exports = function mountMisc(app) {
  // Liveness (cheap, no deps) — is the process up and serving?
  app.get('/health', (req, res) => res.json({ ok: true, service: 'receipt-saas', account: cfg.ACCOUNT_ID }));

  // Readiness (deep) — is the Supabase data plane reachable? Returns NO data (no PII), just a
  // dep verdict, so a monitor/load-balancer can tell "up but DB-down" from healthy. Groq is
  // deliberately NOT pinged here — polling it would burn AI quota / risk 429; AI failures
  // surface via the bot's own error paths + structured logs (#12).
  app.get('/ready', readyLimiter, async (req, res) => {
    let db = 'down';
    try {
      await withTimeout(supabase.sbSelect('voucher_counters', { limit: 1 }), 3000); // PII-free probe
      db = 'up';
    } catch (e) { logWarn('ready', 'db unreachable: ' + (e && e.message)); }

    // Storage reachability (ADR-018): receipts depend on Supabase Storage. Reported so a plain
    // `curl /ready` can tell "server up, DB up, but STORAGE unreachable" apart from healthy —
    // exactly the blind spot that made a VPS-side receipt-read 404 undiagnosable (2026-07-11).
    // Deliberately does NOT gate the 200/503 verdict (that stays on the DB, the hard dependency)
    // so a transient storage blip never pulls the instance out of rotation; the verdict is
    // informational. `storage_detail` carries a short PII-free reason when down.
    let storageVerdict = 'down';
    let storageDetail;
    try {
      const p = await withTimeout(storage.probeStorage(), 5500);
      storageVerdict = p && p.ok ? 'up' : 'down';
      if (!(p && p.ok)) storageDetail = (p && p.detail) || 'unreachable';
    } catch (e) { storageDetail = (e && e.message) || 'timeout'; }
    if (storageVerdict === 'down') logWarn('ready', 'storage unreachable: ' + (storageDetail || '?'));

    const ok = db === 'up';
    const body = { ok, deps: { db, storage: storageVerdict } };
    if (storageDetail) body.storage_detail = storageDetail;

    // Opt-in DEEP object-read check (`/ready?deep=object`): actually DOWNLOAD the newest stored
    // receipt object — the exact operation that serves a card's photo — and report whether THIS
    // server can do it. Gated behind the query param so normal readiness polling stays cheap and
    // never fetches image bytes. 2026-07-11: the decisive test for a live 404 where the object
    // exists + reads fine from a dev box; a green bucket-auth probe alone can't confirm downloads.
    if (req.query.deep === 'object') {
      let objectRead = 'down';
      let objectDetail;
      try {
        const rows = await withTimeout(
          supabase.sbSelect('expenses', { extra: 'receipt_url=not.is.null&order=created_at.desc', limit: 1 }), 3000);
        const path = rows && rows[0] && rows[0].receipt_url;
        if (!path) { objectRead = 'no-data'; objectDetail = 'no receipt with a stored image yet'; }
        else {
          const r = await withTimeout(storage.probeStorageObject(path), 9000);
          objectRead = r && r.ok ? 'up' : 'down';
          objectDetail = r && r.ok ? (r.bytes + ' bytes') : ('status ' + (r && r.status != null ? r.status : '?') + ': ' + (r && r.detail || 'unreadable'));
        }
      } catch (e) { objectDetail = (e && e.message) || 'timeout'; }
      body.deps.object_read = objectRead;
      body.object_read_detail = objectDetail;
      if (objectRead !== 'up') logWarn('ready', 'object read ' + objectRead + ': ' + (objectDetail || '?'));
    }

    res.status(ok ? 200 : 503).json(body);
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
};

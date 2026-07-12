'use strict';
/**
 * ADR-018 — durable receipt-image storage (Supabase Storage).
 * Upload receipt bytes to a PRIVATE `receipts` bucket at ingestion, and fetch them back
 * for the auth'd serve route (routes/receipt.js). This replaces the fragile live-proxy of
 * Telegram file_ids (which breaks on bot-token rotation and can't serve dashboard uploads
 * at all) with a self-hosted copy whose object path is stored in `expenses.receipt_url`.
 *
 * FAIL-SAFE: every function returns null on ANY error (never throws into the ingestion
 * flow) — a storage hiccup must never stop a receipt from being saved; the image is just
 * absent for that row. All I/O goes through an injectable `deps.hreq` so it's unit-testable
 * with no network.
 */
const crypto = require('crypto');
const { cfg } = require('./config');
const { hreq } = require('./http');

const BUCKET = 'receipts';

// Extension sniffed from magic bytes — NEVER trust a caller-supplied filename (SOP §7.3).
function extOf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return 'bin';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
  return 'bin';
}

function mimeOf(ext) {
  return { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' }[ext] || 'application/octet-stream';
}

/**
 * uploadReceiptImage(buffer, { accountId?, deps? }) -> object path string | null
 * Path scheme: `<account_id>/<uuid>.<ext>` — account-scoped (multi-tenant-forward),
 * uuid so the name is neither guessable nor PII-bearing, ext derived from the bytes.
 */
async function uploadReceiptImage(buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const req = (opts.deps && opts.deps.hreq) || hreq;
  const account = String(opts.accountId || cfg.ACCOUNT_ID || 'default');
  const ext = extOf(buffer);
  const path = account + '/' + crypto.randomUUID() + '.' + ext;
  try {
    const res = await req({
      method: 'POST',
      url: cfg.SB_URL + '/storage/v1/object/' + BUCKET + '/' + path,
      headers: { apikey: cfg.SB_KEY, Authorization: 'Bearer ' + cfg.SB_KEY, 'Content-Type': mimeOf(ext) },
      body: buffer,
      timeout: 20000,
    });
    // Success returns { Key: "receipts/<path>" }. hreq returns text by default, so accept
    // either a parsed object with .Key or a raw string containing "Key"; anything else
    // (error json, empty) is treated as failure -> null (fail-safe).
    const ok = res && (typeof res === 'string' ? /"Key"/.test(res) : res.Key);
    // A rejected upload used to return null SILENTLY — undiagnosable in production
    // (2026-07-12 root-cause fix). Log the response snippet: it's Supabase's own error
    // JSON (e.g. {"error":"Bucket not found"}), never receipt bytes, never a secret.
    if (!ok) console.error('[storage] upload rejected:', String(typeof res === 'string' ? res : JSON.stringify(res)).slice(0, 200));
    return ok ? path : null;
  } catch (e) {
    console.error('[storage] upload', e && e.message);
    return null;
  }
}

/**
 * fetchReceiptObject(path, { deps? }) -> Buffer | null
 * Reads the object back (service key) for the checkDash-gated serve route to stream to the
 * browser — the bucket stays fully private; the browser never sees a raw storage URL.
 */
async function fetchReceiptObject(path, opts = {}) {
  if (!path || typeof path !== 'string') return null;
  const req = (opts.deps && opts.deps.hreq) || hreq;
  try {
    const buf = await req({
      url: cfg.SB_URL + '/storage/v1/object/' + BUCKET + '/' + path,
      headers: { apikey: cfg.SB_KEY, Authorization: 'Bearer ' + cfg.SB_KEY },
      encoding: 'arraybuffer',
      timeout: 20000,
    });
    return (Buffer.isBuffer(buf) && buf.length) ? buf : null;
  } catch (e) {
    console.error('[storage] fetch', e && e.message);
    return null;
  }
}

module.exports = { uploadReceiptImage, fetchReceiptObject, extOf, mimeOf, BUCKET };

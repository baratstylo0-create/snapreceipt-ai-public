'use strict';
// Native fetch + timeout helper. Moved verbatim from server.js (no behaviour change).

async function hreq({ method = 'GET', url, headers = {}, body, json, timeout = 20000, encoding } = {}) {
  const opt = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeout) };
  if (body !== undefined) {
    // FormData (e.g. a Telegram setWebhook cert upload) must go through as-is —
    // fetch sets its own multipart boundary Content-Type; JSON.stringify would
    // wreck it. `json: true` still governs RESPONSE parsing below either way.
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    opt.body = (json && !isForm) ? JSON.stringify(body) : body;
    if (json && !isForm && !opt.headers['Content-Type']) opt.headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(url, opt);
  if (encoding === 'arraybuffer') return Buffer.from(await r.arrayBuffer());
  const text = await r.text();
  if (json) { try { return JSON.parse(text); } catch { return text; } }
  return text;
}

module.exports = { hreq };

'use strict';
// Native fetch + timeout helper. Moved verbatim from server.js (no behaviour change).

async function hreq({ method = 'GET', url, headers = {}, body, json, timeout = 20000, encoding } = {}) {
  const opt = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeout) };
  if (body !== undefined) {
    opt.body = json ? JSON.stringify(body) : body;
    if (json && !opt.headers['Content-Type']) opt.headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(url, opt);
  if (encoding === 'arraybuffer') return Buffer.from(await r.arrayBuffer());
  const text = await r.text();
  if (json) { try { return JSON.parse(text); } catch { return text; } }
  return text;
}

module.exports = { hreq };

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
  if (encoding === 'arraybuffer') {
    const buf = Buffer.from(await r.arrayBuffer());
    // Binary fetches (receipt images from Supabase Storage, Telegram file downloads) can NEVER
    // use an error body as bytes — a 4xx/5xx JSON error returned as a "Buffer" masquerades as a
    // valid image: a silently broken thumbnail with NO log line, and (worse) it hides the real
    // Storage/Telegram error from the caller's own catch (2026-07-11: this is exactly why a
    // failing receipt fetch produced no `[storage] fetch` log to diagnose from). So on a non-2xx,
    // throw with the status + a short body snippet — every arraybuffer caller already wraps this
    // in a try/catch that maps a throw to a clean failure (null / 404 / 502) AND logs the cause.
    // The text/json paths below are deliberately unchanged: many callers (Supabase REST, Telegram,
    // Groq) legitimately inspect non-2xx bodies themselves, so status-throwing there would be a
    // wide, breaking behaviour change — this narrows the fix to binary reads only.
    if (!r.ok) {
      const snippet = buf.toString('utf8', 0, 300).replace(/\s+/g, ' ').trim();
      const err = new Error('HTTP ' + r.status + (snippet ? ': ' + snippet : ''));
      err.status = r.status;
      throw err;
    }
    return buf;
  }
  const text = await r.text();
  if (json) { try { return JSON.parse(text); } catch { return text; } }
  return text;
}

module.exports = { hreq };

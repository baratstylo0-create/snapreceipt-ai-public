'use strict';
const { cfg } = require('./config');
const { hreq } = require('./http');
const { pickKey, nextKey } = require('./groqkeys');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// 2026-07-20 incident: callGroq's own 'throw new Error(\'429\')' (whole key pool exhausted
// this round, see below) was landing in the SAME generic catch as a genuinely unreadable
// photo, so a burst of receipts hitting the per-minute token ceiling got told "the PHOTO is
// too blurry, resend a sharper one" — false and unhelpful; the photo was fine, the account
// was just temporarily rate-limited. Callers (lib/ocr.js, lib/massupload.js) use this to give
// an honest "too many at once, please wait" message instead. Matches ONLY callGroq's own
// literal '429' throw (see below) — a network/timeout error has a different message and
// correctly keeps the existing generic message.
function isRateLimitError(e) { return !!(e && e.message === '429'); }

// Shared request runner with per-call Groq key rotation (ADR-016) + backoff.
//   body    : the chat-completions request body.
//   extract : (assistantMessage) -> the caller's return shape on success.
//   empty   : the value to return when the model gives a non-rate, non-choices reply,
//             or when all attempts are exhausted without a throw (today's behavior).
//
// Fall-through logic (ADR-016):
//   - Random start key (pickKey). On a 429/rate-limited reply, try a DIFFERENT untried
//     key with NO sleep — a fresh account has its own quota. Rotate until the whole pool
//     has 429'd THIS round.
//   - A full-pool exhaustion counts as ONE backoff attempt: sleep, reset `tried`, start
//     over with a fresh random key. Total attempts stay capped at 4 (unchanged from before),
//     so key-swaps never eat the backoff budget.
//   - A non-429 error (network/timeout throw) keeps today's behavior: backoff and retry.
//   - Single-key pool (or GROQ_KEYS unset) is byte-for-byte the old behavior: one key,
//     4 attempts, 1s/2s/3s backoff, throw on the 4th.
async function callGroq(body, extract, empty) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const tried = new Set();
    try {
      let key = pickKey() || cfg.GROQ_KEY; // fall back to the raw key if the pool is empty
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const r = await hreq({
          method: 'POST', url: GROQ_URL,
          headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
          body, json: true, timeout: 30000
        });
        if (r && r.choices && r.choices[0]) return extract(r.choices[0].message || { role: 'assistant', content: '' });
        const isRate = r && r.error && /rate|429|too many/i.test(JSON.stringify(r.error));
        if (!isRate) {
          // 2026-08-19 incident (Falc total outage, every question, all users): a non-rate
          // API error — including an outright auth failure like "Invalid API Key" — used to
          // be swallowed here with ZERO trace: no log, no thrown error, just the generic
          // `empty` fallback silently standing in as if the model had genuinely said nothing.
          // Every caller's own error handling (agent chat, categorizer, anomaly watchdog) is
          // deliberately soft-fail-safe for a real transient hiccup — but a HARD failure (bad
          // key, decommissioned model, malformed request) deserves a visible trace so it gets
          // fixed instead of silently degrading every AI-backed feature at once. message-only
          // (no body/prompt content) — never log user data.
          if (r && r.error) console.error('[groq] non-rate API error, not retried:', JSON.stringify(r.error).slice(0, 500));
          return empty; // a non-rate reply without choices: nothing to retry (unchanged)
        }
        // 429: swap to a fresh untried key with NO sleep; if the pool is exhausted this
        // round, throw to fall into the backoff below.
        tried.add(key);
        const k = nextKey(tried);
        if (!k) throw new Error('429');
        key = k;
      }
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(s => setTimeout(s, 1000 * (attempt + 1)));
    }
  }
  return empty;
}

// Chat with per-call key rotation + backoff. Returns the assistant message text.
// reasoning_effort (optional): passed through to the request body ONLY when a non-empty
// value is given, so existing callers are byte-for-byte unchanged. For a reasoning model
// like qwen3.6-27b, reasoning_effort:'none' disables the <think> pass entirely — which for
// pure field-extraction (OCR) removes the whole "<think> spiral exhausts the token budget
// and returns no JSON" failure class AND cuts token use (easing free-tier 429s).
async function groqChat(messages, { model = cfg.MODEL_ROUTES.visionDefault, max_tokens = 900, temperature = 0.1, reasoning_effort } = {}) {
  const body = { model, messages, max_tokens, temperature };
  if (reasoning_effort) body.reasoning_effort = reasoning_effort;
  return callGroq(body, m => (m && m.content) || '', '');
}

// Convenience wrapper for a single image + text prompt. Returns raw model text.
async function groqVision(imageUrl, promptText, { model = cfg.MODEL_ROUTES.visionDefault, max_tokens = 900 } = {}) {
  return groqChat([{
    role: 'user',
    content: [
      { type: 'text', text: promptText },
      { type: 'image_url', image_url: { url: imageUrl } }
    ]
  }], { model, max_tokens, temperature: 0.1 });
}

// Native tool-calling chat. ADDITIVE — same rotation/backoff as groqChat, but returns
// the FULL assistant message (incl. tool_calls), not just .content, so a caller can drive
// a tool-calling loop (#9 dashboard agent).
async function groqChatTools(messages, { model = cfg.MODEL_ROUTES.visionDefault, max_tokens = 1500, temperature = 0, tools, tool_choice } = {}) {
  const body = { model, messages, max_tokens, temperature };
  if (tools) body.tools = tools;
  if (tool_choice) body.tool_choice = tool_choice;
  return callGroq(body, m => m || { role: 'assistant', content: '' }, { role: 'assistant', content: '' });
}

module.exports = { groqChat, groqVision, groqChatTools, isRateLimitError, MODEL_ROUTES: cfg.MODEL_ROUTES };

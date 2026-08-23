'use strict';
// OpenRouter vision client (2026-07-21): Groq decommissioned llama-4-scout on 2026-07-17;
// the forced-emergency replacement (qwen/qwen3.6-27b on Groq) proved unreliable enough on
// real receipts that the Owner asked to move OFF it entirely, not just tune around it.
// OpenRouter still serves the original Scout model, so vision extraction moves here while
// Groq keeps serving the account's text-only routes (TEXT_MODEL/CLASSIFY_MODEL, Falc chat).
const { cfg } = require('./config');
const { hreq } = require('./http');
const { logError } = require('./log');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Mirrors lib/groq.js's callGroq contract byte-for-byte (4 attempts, 1s/2s/3s backoff,
// throws Error('429') on an unrecovered rate limit) so the existing isRateLimitError()
// check (lib/groq.js / lib/massupload.js's own duplicate, both a provider-agnostic
// e.message === '429' string match) keeps working unchanged for this provider too.
// No multi-key rotation (ADR-016 is Groq-specific) — a single OpenRouter key.
async function callOpenRouter(body, extract, empty) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await hreq({
        method: 'POST', url: OPENROUTER_URL,
        headers: { Authorization: 'Bearer ' + cfg.OPENROUTER_KEY, 'Content-Type': 'application/json' },
        body, json: true, timeout: 30000
      });
      if (r && r.choices && r.choices[0]) return extract(r.choices[0].message || { role: 'assistant', content: '' });
      const isRate = r && r.error && /rate|429|too many/i.test(JSON.stringify(r.error));
      if (!isRate) {
        // 2026-07-22 live incident: this used to silently `return empty` with zero trace —
        // a real batch of receipts failed with no error anywhere, not even the server logs.
        // Whatever the actual cause (bad model id, insufficient balance, access revoked),
        // it must be logged so a repeat is diagnosable instead of guessed at (ADR-002-safe:
        // lib/log.js caps + drops nested objects already, so no PII/body risk here).
        logError('openrouter.callOpenRouter', r && r.error && r.error.message ? r.error.message : JSON.stringify(r && r.error), { model: body.model });
        return empty;
      }
      throw new Error('429');
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(s => setTimeout(s, 1000 * (attempt + 1)));
    }
  }
  return empty;
}

// Chat call. Scout is NOT a reasoning model — no <think> pass, no reasoning_effort knob,
// so max_tokens stays at the original pre-qwen budget (900) rather than qwen's 6000.
async function orChat(messages, { model, max_tokens = 900, temperature = 0.1 } = {}) {
  const body = { model, messages, max_tokens, temperature };
  return callOpenRouter(body, m => (m && m.content) || '', '');
}

// 2026-08-19 (Falc outage — the account's only GROQ_KEY was invalid, a full outage for
// every user, every question): native tool-calling chat, mirroring lib/groq.js's
// groqChatTools() contract byte-for-byte (same call shape, same "return the FULL assistant
// message incl. tool_calls, default to a blank assistant stub on failure" behavior) so
// routes/agent.js can swap providers by changing one require, no lib/agent.js change needed.
// Confirmed live against meta-llama/llama-3.3-70b-instruct: real tool_calls come back
// correctly. That model is NOT a reasoning model (no <think> pass) — bonus side effect, the
// whole "<think> spiral eats the token budget, answer comes back empty" failure class
// lib/ocr.js's stripThink/lib/agent.js's cleanAnswer defend against doesn't apply to it at all.
//
// avoidProviders (optional array of OpenRouter provider names, e.g. ['DeepInfra']): live
// testing the SAME day turned up a provider-specific bug — with Falc's full SYSTEM_PROMPT
// (~5.3K chars) + all 7 tool specs in one request, OpenRouter's DeepInfra backend for this
// model returned a genuinely empty message (content:null, no tool_calls, finish_reason:null,
// yet 22 completion tokens billed — the model tried to say SOMETHING and it got lost) for a
// data question that should trigger getReport. The exact same request against every other
// backend that serves this model (CoreWeave, Together, Novita, tested individually) called
// the tool correctly every time. Rather than pin to one specific provider (fragile — that
// provider could go down or get slower), `ignore` just steers OpenRouter's own load-balancer
// away from the one confirmed-bad backend and leaves it free to pick any other.
async function orChatTools(messages, { model, max_tokens = 1500, temperature = 0, tools, tool_choice, avoidProviders } = {}) {
  const body = { model, messages, max_tokens, temperature };
  if (tools) body.tools = tools;
  if (tool_choice) body.tool_choice = tool_choice;
  if (Array.isArray(avoidProviders) && avoidProviders.length) body.provider = { ignore: avoidProviders };
  return callOpenRouter(body, m => m || { role: 'assistant', content: '' }, { role: 'assistant', content: '' });
}

module.exports = { orChat, orChatTools };

'use strict';
const express = require('express');
const { checkDash, dashOrigin } = require('./expenses');
const { runAgent: realRunAgent } = require('../lib/agent');
const { groqChatTools } = require('../lib/groq');
const { sbSelect } = require('../lib/supabase');
const { createRateLimiter } = require('../lib/ratelimit');

const MAX_MESSAGES = 20, MAX_CHARS = 12000;
const AGENT_MODEL = process.env.AGENT_MODEL || 'qwen/qwen3.6-27b';
const AGENT_MAX_TOKENS = Number(process.env.AGENT_MAX_TOKENS) || 1500;
const ALLOWED_ROLES = new Set(['user', 'assistant']);

// P6 abuse defense (§4.4): every agent turn is a Groq call (cost-drainable) — rate limit it.
// AGENT_RATE_MAX follows Barat's WEBHOOK_RATE_MAX naming convention; reuses the shared
// lib/ratelimit.js limiter, no second implementation.
const agentLimiter = createRateLimiter({ max: Number(process.env.AGENT_RATE_MAX) || 20 });

// deps injected in tests; default to the real modules in production.
module.exports = function mountAgent(app, deps = {}) {
  const runAgent = deps.runAgent || realRunAgent;
  // The chat adapter binds model/token config onto the tool-calling Groq client.
  const chat = deps.chat || ((messages, opts) => groqChatTools(messages, { model: AGENT_MODEL, max_tokens: AGENT_MAX_TOKENS, temperature: 0, ...opts }));

  app.post('/api/agent', agentLimiter, checkDash, express.json({ limit: '256kb' }), async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    try {
      const messages = req.body && req.body.messages;
      if (!Array.isArray(messages) || messages.some(m => !m || !ALLOWED_ROLES.has(m.role) || typeof m.content !== 'string')) {
        return res.status(400).json({ error: 'messages must be an array of {role:user|assistant, content:string}' });
      }
      if (messages.length > MAX_MESSAGES) return res.status(413).json({ error: 'conversation too long (max ' + MAX_MESSAGES + ' messages)' });
      const chars = messages.reduce((n, m) => n + m.content.length, 0);
      if (chars > MAX_CHARS) return res.status(413).json({ error: 'conversation too long (max ' + MAX_CHARS + ' chars)' });

      const out = await runAgent(messages, { chat, sbSelect });
      const answer = (out && out.answer) || '';
      const updated = messages.concat([{ role: 'assistant', content: answer }]);
      res.json({ answer, messages: updated, toolCalls: (out && out.toolCalls) || [] });
    } catch (e) {
      console.error('[api/agent]', e.message);
      res.status(502).json({ error: 'agent failed' });
    }
  });
};

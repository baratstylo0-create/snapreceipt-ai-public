'use strict';
const express = require('express');
const { checkDash, dashOrigin } = require('./expenses');
const { runAgent: realRunAgent, confirmProposal: realConfirmProposal } = require('../lib/agent');
const { groqChatTools } = require('../lib/groq');
const { sbSelect, sbUpdate, sbSoftDelete } = require('../lib/supabase');
const { saveTemplate, getFieldSpec } = require('../lib/templates');
const { createRateLimiter } = require('../lib/ratelimit');

const MAX_PROPOSAL_ID_LEN = 200; // proposal ids are short 'p_'+uuid strings; generous headroom

const MAX_MESSAGES = 20, MAX_CHARS = 12000;
const AGENT_MODEL = process.env.AGENT_MODEL || 'qwen/qwen3.6-27b';
const AGENT_MAX_TOKENS = Number(process.env.AGENT_MAX_TOKENS) || 1500;
const ALLOWED_ROLES = new Set(['user', 'assistant']);

// P6 abuse defense (§4.4): every agent turn is a Groq call (cost-drainable) — rate limit it.
// AGENT_RATE_MAX follows Barat's WEBHOOK_RATE_MAX naming convention; reuses the shared
// lib/ratelimit.js limiter, no second implementation.
// Owner directive (lenient): a human power-user peaks at ~10-20 questions/min, so 120/min
// is generous headroom that never trips real use. It's a RUNAWAY backstop (bug-loop /
// flood), not a throttle — the Groq key pool (ADR-016) is the cost backstop. Not unlimited
// on purpose: a runaway would otherwise drain every pooled key.
const agentLimiter = createRateLimiter({ max: Number(process.env.AGENT_RATE_MAX) || 120 });

// deps injected in tests; default to the real modules in production.
module.exports = function mountAgent(app, deps = {}) {
  const runAgent = deps.runAgent || realRunAgent;
  const confirmProposal = deps.confirmProposal || realConfirmProposal;
  // The chat adapter binds model/token config onto the tool-calling Groq client.
  const chat = deps.chat || ((messages, opts) => groqChatTools(messages, { model: AGENT_MODEL, max_tokens: AGENT_MAX_TOKENS, temperature: 0, ...opts }));
  // Write helpers + template helpers: overridable in tests, default to the real modules —
  // same override pattern as chat/sbSelect above. confirmProposal's auto-mode path (invoked
  // from inside runAgent) needs all of these on the deps object we pass down.
  const writeDeps = {
    sbSelect: deps.sbSelect || sbSelect,
    sbUpdate: deps.sbUpdate || sbUpdate,
    sbSoftDelete: deps.sbSoftDelete || sbSoftDelete,
    saveTemplate: deps.saveTemplate || saveTemplate,
    getFieldSpec: deps.getFieldSpec || getFieldSpec,
  };

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

      // Strict === true coercion: this flag gates real writes, so anything but the literal
      // boolean true (missing, "true" string, 1, etc.) must resolve to false.
      const autoMode = req.body && req.body.autoMode === true;

      const out = await runAgent(messages, { chat, ...writeDeps, autoMode });
      const answer = (out && out.answer) || '';
      const updated = messages.concat([{ role: 'assistant', content: answer }]);
      const response = { answer, messages: updated, toolCalls: (out && out.toolCalls) || [] };
      if (out && out.proposal) response.proposal = out.proposal; // omit key entirely, never null
      res.json(response);
    } catch (e) {
      console.error('[api/agent]', e.message);
      res.status(502).json({ error: 'agent failed' });
    }
  });

  // POST /api/agent/confirm { proposalId } — the EXECUTE step for a pending proposal a human
  // reviewed on the dashboard. Small body: just an id. confirmProposal() re-validates fresh
  // and never throws; this handler is pass-through plus the usual defense-in-depth try/catch.
  app.post('/api/agent/confirm', agentLimiter, checkDash, express.json({ limit: '8kb' }), async (req, res) => {
    res.set('Access-Control-Allow-Origin', dashOrigin());
    try {
      const raw = req.body && req.body.proposalId;
      if (typeof raw !== 'string' || !raw) {
        return res.status(400).json({ error: 'proposalId is required' });
      }
      const proposalId = raw.slice(0, MAX_PROPOSAL_ID_LEN);

      const result = await confirmProposal(proposalId, writeDeps);
      res.json(result);
    } catch (e) {
      console.error('[api/agent/confirm]', e.message);
      res.status(502).json({ error: 'agent failed' });
    }
  });
};

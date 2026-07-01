'use strict';
const { cfg } = require('./config');
const { hreq } = require('./http');

// Chat with exponential backoff for 429s. Moved verbatim from server.js (default model now from routing).
async function groqChat(messages, { model = cfg.MODEL_ROUTES.visionDefault, max_tokens = 900, temperature = 0.1 } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await hreq({
        method: 'POST', url: 'https://api.groq.com/openai/v1/chat/completions',
        headers: { Authorization: 'Bearer ' + cfg.GROQ_KEY, 'Content-Type': 'application/json' },
        body: { model, messages, max_tokens, temperature }, json: true, timeout: 30000
      });
      if (r && r.choices && r.choices[0]) return (r.choices[0].message && r.choices[0].message.content) || '';
      if (r && r.error && /rate|429|too many/i.test(JSON.stringify(r.error))) throw new Error('429');
      return '';
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(s => setTimeout(s, 1000 * (attempt + 1)));
    }
  }
  return '';
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

// Native tool-calling chat. ADDITIVE — does not change groqChat (ocr/bot/categorize
// depend on it unchanged). Returns the FULL assistant message (incl. tool_calls),
// not just .content, so a caller can drive a tool-calling loop (#9 dashboard agent).
async function groqChatTools(messages, { model = cfg.MODEL_ROUTES.visionDefault, max_tokens = 1500, temperature = 0, tools, tool_choice } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const body = { model, messages, max_tokens, temperature };
      if (tools) body.tools = tools;
      if (tool_choice) body.tool_choice = tool_choice;
      const r = await hreq({
        method: 'POST', url: 'https://api.groq.com/openai/v1/chat/completions',
        headers: { Authorization: 'Bearer ' + cfg.GROQ_KEY, 'Content-Type': 'application/json' },
        body, json: true, timeout: 30000
      });
      if (r && r.choices && r.choices[0]) return r.choices[0].message || { role: 'assistant', content: '' };
      if (r && r.error && /rate|429|too many/i.test(JSON.stringify(r.error))) throw new Error('429');
      return { role: 'assistant', content: '' };
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(s => setTimeout(s, 1000 * (attempt + 1)));
    }
  }
  return { role: 'assistant', content: '' };
}

module.exports = { groqChat, groqVision, groqChatTools, MODEL_ROUTES: cfg.MODEL_ROUTES };

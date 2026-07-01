'use strict';
const { cfg } = require('./config');
const { hreq } = require('./http');

const api = m => 'https://api.telegram.org/bot' + cfg.BOT_TOKEN + '/' + m;

async function tgSend(chatId, text, replyMarkup) {
  try {
    await hreq({ method: 'POST', url: api('sendMessage'), json: true,
      body: { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) } });
  } catch (e) { console.error('[tgSend]', e.message); }
}

// Resolve a Telegram file_id to a downloadable URL.
async function tgFileUrl(fileId) {
  const f = await hreq({ url: api('getFile?file_id=' + encodeURIComponent(fileId)), json: true, timeout: 8000 });
  const fp = f && f.result && f.result.file_path;
  if (!fp) return null;
  return { url: 'https://api.telegram.org/file/bot' + cfg.BOT_TOKEN + '/' + fp, path: fp };
}

async function registerWebhook() {
  if (!cfg.PUBLIC_URL) { console.log('[webhook] PUBLIC_URL not set — skipping auto-registration.'); return; }
  try {
    const url = cfg.PUBLIC_URL + '/webhook';
    const body = { url, allowed_updates: ['message', 'edited_message'], drop_pending_updates: false };
    if (cfg.WEBHOOK_SECRET) body.secret_token = cfg.WEBHOOK_SECRET;
    const r = await hreq({ method: 'POST', url: api('setWebhook'), json: true, body });
    console.log('[webhook]', r && r.ok ? ('registered → ' + url) : ('FAILED: ' + JSON.stringify(r)));
  } catch (e) { console.error('[webhook reg]', e.message); }
}

module.exports = { tgSend, tgFileUrl, registerWebhook, api };

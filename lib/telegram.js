'use strict';
const { cfg } = require('./config');
const { hreq } = require('./http');

const api = m => 'https://api.telegram.org/bot' + cfg.BOT_TOKEN + '/' + m;

// Send a Telegram message. We format with Markdown (`*bold*`), but merchant/category
// text is interpolated raw by callers, so a value containing an unbalanced *, _, [ or `
// makes Telegram REJECT the whole message with a 400 "can't parse entities". hreq does
// NOT throw on that (it returns { ok:false }), so the old code ignored it and the user
// got total silence. FIX: detect the rejection and RESEND as plain text — a formatting
// glitch must never swallow the reply. (Root cause of the "photo received, no reply" bug.)
async function tgSend(chatId, text, replyMarkup) {
  const base = { chat_id: chatId, disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) };
  try {
    const r = await hreq({ method: 'POST', url: api('sendMessage'), json: true, body: { ...base, text, parse_mode: 'Markdown' } });
    if (r && r.ok) return r;
    console.error('[tgSend] Markdown rejected, retrying as plain text:', r && r.description);
    const r2 = await hreq({ method: 'POST', url: api('sendMessage'), json: true, body: { ...base, text } });
    if (!(r2 && r2.ok)) console.error('[tgSend] plain-text retry also failed:', r2 && r2.description);
    return r2;
  } catch (e) { console.error('[tgSend]', e.message); }
}

// Edit an existing message in place (Owner request 2026-07-04): once a category-picker
// button is tapped, the prompt message should turn into a clean "Saved" note instead of
// leaving a wall of stale buttons in the chat history. `replyMarkup` is OPTIONAL — when
// omitted, the keyboard is explicitly CLEARED (Telegram does NOT remove an existing
// keyboard on its own unless told to); pass one to attach a NEW keyboard instead (e.g. the
// "✏️ Edit category" button re-opening the category-picker buttons on the same message).
// Same Markdown-rejection-retries-as-plain-text safety net as tgSend, same never-throws.
async function tgEditMessage(chatId, messageId, text, replyMarkup) {
  const base = { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup || { inline_keyboard: [] } };
  try {
    const r = await hreq({ method: 'POST', url: api('editMessageText'), json: true, body: { ...base, text, parse_mode: 'Markdown' } });
    if (r && r.ok) return r;
    console.error('[tgEditMessage] Markdown rejected, retrying as plain text:', r && r.description);
    const r2 = await hreq({ method: 'POST', url: api('editMessageText'), json: true, body: { ...base, text } });
    if (!(r2 && r2.ok)) console.error('[tgEditMessage] plain-text retry also failed:', r2 && r2.description);
    return r2;
  } catch (e) { console.error('[tgEditMessage]', e.message); }
}

// Resolve a Telegram file_id to a downloadable URL.
async function tgFileUrl(fileId) {
  const f = await hreq({ url: api('getFile?file_id=' + encodeURIComponent(fileId)), json: true, timeout: 8000 });
  const fp = f && f.result && f.result.file_path;
  if (!fp) return null;
  return { url: 'https://api.telegram.org/file/bot' + cfg.BOT_TOKEN + '/' + fp, path: fp };
}

// Ack an inline-keyboard button press. MUST be called for every callback_query (button
// stays in a spinning "loading" state on the user's phone otherwise). Best-effort/never
// throws, same style as tgSend — a failed ack must never break the reply that follows it.
async function tgAnswerCallback(callbackQueryId, opts = {}) {
  try {
    await hreq({ method: 'POST', url: api('answerCallbackQuery'), json: true, body: { callback_query_id: callbackQueryId, ...opts } });
  } catch (e) { console.error('[tgAnswerCallback]', e.message); }
}

async function registerWebhook() {
  if (!cfg.PUBLIC_URL) { console.log('[webhook] PUBLIC_URL not set — skipping auto-registration.'); return; }
  try {
    const url = cfg.PUBLIC_URL + '/webhook';
    // 'callback_query' added for the in-chat delete confirm/cancel buttons.
    const body = { url, allowed_updates: ['message', 'edited_message', 'callback_query'], drop_pending_updates: false };
    if (cfg.WEBHOOK_SECRET) body.secret_token = cfg.WEBHOOK_SECRET;
    const r = await hreq({ method: 'POST', url: api('setWebhook'), json: true, body });
    console.log('[webhook]', r && r.ok ? ('registered → ' + url) : ('FAILED: ' + JSON.stringify(r)));
  } catch (e) { console.error('[webhook reg]', e.message); }
}

module.exports = { tgSend, tgEditMessage, tgFileUrl, tgAnswerCallback, registerWebhook, api };

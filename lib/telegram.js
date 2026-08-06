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

// Issue #152 (per-photo failure feedback): resend a PHOTO the bot already received, by
// its own file_id — Telegram accepts a previously-seen file_id directly in `sendPhoto`,
// no re-download needed. Used so a skipped batch photo's own thumbnail rides along with
// its reason-specific ask ("this one was too blurry...") instead of a generic count.
// Same Markdown-rejection-retries-as-plain-text safety net as tgSend, same never-throws.
async function tgSendPhoto(chatId, fileId, caption, replyMarkup) {
  const base = { chat_id: chatId, photo: fileId, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) };
  try {
    const r = await hreq({ method: 'POST', url: api('sendPhoto'), json: true, body: { ...base, caption, parse_mode: 'Markdown' } });
    if (r && r.ok) return r;
    console.error('[tgSendPhoto] Markdown rejected, retrying as plain text:', r && r.description);
    const r2 = await hreq({ method: 'POST', url: api('sendPhoto'), json: true, body: { ...base, caption } });
    if (!(r2 && r2.ok)) console.error('[tgSendPhoto] plain-text retry also failed:', r2 && r2.description);
    return r2;
  } catch (e) { console.error('[tgSendPhoto]', e.message); }
}

// Resolve a Telegram file_id to a downloadable URL.
async function tgFileUrl(fileId) {
  const f = await hreq({ url: api('getFile?file_id=' + encodeURIComponent(fileId)), json: true, timeout: 8000 });
  const fp = f && f.result && f.result.file_path;
  if (!fp) return null;
  return { url: 'https://api.telegram.org/file/bot' + cfg.BOT_TOKEN + '/' + fp, path: fp };
}

// resolveBotUsername() -> the bot's public @handle (no leading @) via Telegram getMe, or
// null on any failure. Lets the server auto-fill cfg.BOT_USERNAME at boot when the env var
// isn't set, so the dashboard's t.me/<bot>?start=<token> deep link works without anyone
// having to configure the handle by hand. Fail-safe (never throws) — same contract as the
// other helpers here; a Telegram hiccup just returns null and nothing changes.
async function resolveBotUsername() {
  try {
    const r = await hreq({ url: api('getMe'), json: true, timeout: 8000 });
    const u = r && r.ok && r.result && r.result.username;
    if (!u || typeof u !== 'string') return null;
    const handle = u.trim().replace(/^@/, '').trim();
    return handle || null;
  } catch (e) {
    console.error('[resolveBotUsername]', e && e.message);
    return null;
  }
}

// Ack an inline-keyboard button press. MUST be called for every callback_query (button
// stays in a spinning "loading" state on the user's phone otherwise). Best-effort/never
// throws, same style as tgSend — a failed ack must never break the reply that follows it.
async function tgAnswerCallback(callbackQueryId, opts = {}) {
  try {
    await hreq({ method: 'POST', url: api('answerCallbackQuery'), json: true, body: { callback_query_id: callbackQueryId, ...opts } });
  } catch (e) { console.error('[tgAnswerCallback]', e.message); }
}

// certPath (optional, defaults to cfg.WEBHOOK_CERT_PATH): a self-signed VPS deploy
// needs the cert uploaded WITH setWebhook (multipart `certificate` field) or Telegram
// silently refuses to trust the host — a plain JSON setWebhook (the only path this
// function used to have) doesn't work there at all; a manual `curl -F certificate=@...`
// was the only workaround. When certPath is set, send multipart/form-data instead;
// hosts with a real CA-trusted cert (Render/Fly) leave it unset and get the old JSON path.
async function registerWebhook(certPath = cfg.WEBHOOK_CERT_PATH) {
  if (!cfg.PUBLIC_URL) { console.log('[webhook] PUBLIC_URL not set — skipping auto-registration.'); return; }
  try {
    const url = cfg.PUBLIC_URL + '/webhook';
    // 'callback_query' added for the in-chat delete confirm/cancel buttons.
    const allowed_updates = ['message', 'edited_message', 'callback_query'];
    let r;
    if (certPath) {
      const fs = require('fs');
      const form = new FormData();
      form.append('url', url);
      form.append('allowed_updates', JSON.stringify(allowed_updates));
      form.append('drop_pending_updates', 'false');
      if (cfg.WEBHOOK_SECRET) form.append('secret_token', cfg.WEBHOOK_SECRET);
      form.append('certificate', new Blob([fs.readFileSync(certPath)]), 'cert.pem');
      r = await hreq({ method: 'POST', url: api('setWebhook'), json: true, body: form });
    } else {
      const body = { url, allowed_updates, drop_pending_updates: false };
      if (cfg.WEBHOOK_SECRET) body.secret_token = cfg.WEBHOOK_SECRET;
      r = await hreq({ method: 'POST', url: api('setWebhook'), json: true, body });
    }
    console.log('[webhook]', r && r.ok ? ('registered → ' + url + (certPath ? ' (with cert)' : '')) : ('FAILED: ' + JSON.stringify(r)));
  } catch (e) { console.error('[webhook reg]', e.message); }
}

module.exports = { tgSend, tgSendPhoto, tgEditMessage, tgFileUrl, tgAnswerCallback, registerWebhook, resolveBotUsername, api };

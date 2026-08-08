'use strict';
// Email delivery for personal-mode password reset (2026-07-27). New dependency:
// `resend` — went through SendGrid (Barat hit account-verification friction
// signing up) before landing here: simple email+password signup, works
// immediately from 'onboarding@resend.dev' with zero domain verification needed
// to start (swap in a verified domain sender later for production, no code change).
//
// Degrades safely: if RESEND_API_KEY/RESEND_FROM_EMAIL aren't configured,
// sendResetEmail logs a warning and returns without throwing — mirrors
// routes/webhook.js's "warn once, don't crash in dev" pattern for WEBHOOK_SECRET —
// so a missing mail config never 500s /api/forgot-password, which must always
// respond identically either way, per its own no-enumeration contract.
const { Resend } = require('resend');
const { cfg } = require('./config');

let client = null;
let warnedNoMailConfig = false;

function getClient() {
  if (client) return client;
  if (!cfg.RESEND_API_KEY || !cfg.RESEND_FROM_EMAIL) return null;
  client = new Resend(cfg.RESEND_API_KEY);
  return client;
}

// sendResetEmail(toEmail, resetUrl) -> Promise<void>. Never throws — a delivery
// failure is logged and swallowed; the caller (routes/auth.js) already returns a
// generic "if that email has an account..." response regardless of outcome, so a
// thrown error here would only risk leaking timing/enumeration info for no benefit.
async function sendResetEmail(toEmail, resetUrl) {
  const c = getClient();
  if (!c) {
    if (!warnedNoMailConfig) {
      warnedNoMailConfig = true;
      console.warn('[mailer] RESEND_API_KEY/RESEND_FROM_EMAIL not set — password reset emails will not be sent. Set both in .env.personal.');
    }
    return;
  }
  try {
    const { error } = await c.emails.send({
      from: cfg.RESEND_FROM_EMAIL,
      to: toEmail,
      subject: 'Reset your SnapReceipt AI password',
      text: 'We received a request to reset your password.\n\n'
        + 'Click this link to set a new password (expires in 1 hour):\n' + resetUrl + '\n\n'
        + "If you didn't request this, you can safely ignore this email — your password won't change.",
      html: '<p>We received a request to reset your password.</p>'
        + '<p><a href="' + resetUrl + '">Click here to set a new password</a> (expires in 1 hour).</p>'
        + "<p>If you didn't request this, you can safely ignore this email — your password won't change.</p>",
    });
    if (error) console.error('[mailer] sendResetEmail failed:', error.message || JSON.stringify(error));
  } catch (e) {
    console.error('[mailer] sendResetEmail failed:', e.message);
  }
}

// sendVerificationCode(toEmail, code) -> Promise<void>. Never throws — same contract as
// sendResetEmail. Used by the in-bot "I already have one" / 30-day re-verify flow (lib/bot.js,
// 2026-08-08): proves the Telegram user actually owns the email before rebinding their chat.
async function sendVerificationCode(toEmail, code) {
  const c = getClient();
  if (!c) {
    if (!warnedNoMailConfig) {
      warnedNoMailConfig = true;
      console.warn('[mailer] RESEND_API_KEY/RESEND_FROM_EMAIL not set — verification code emails will not be sent. Set both in .env.personal.');
    }
    return;
  }
  try {
    const { error } = await c.emails.send({
      from: cfg.RESEND_FROM_EMAIL,
      to: toEmail,
      subject: 'Your SnapReceipt AI verification code',
      text: 'Your verification code is: ' + code + '\n\n'
        + 'Enter this in Telegram to connect your account (expires in 10 minutes).\n\n'
        + "If you didn't request this, you can safely ignore this email.",
      html: '<p>Your verification code is: <strong>' + code + '</strong></p>'
        + '<p>Enter this in Telegram to connect your account (expires in 10 minutes).</p>'
        + "<p>If you didn't request this, you can safely ignore this email.</p>",
    });
    if (error) console.error('[mailer] sendVerificationCode failed:', error.message || JSON.stringify(error));
  } catch (e) {
    console.error('[mailer] sendVerificationCode failed:', e.message);
  }
}

module.exports = { sendResetEmail, sendVerificationCode };

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

// sendFeedbackEmail(fromEmail, message) -> Promise<{ ok: boolean }>. Unlike the other
// senders here, the CALLER needs to know whether this actually sent (routes/feedback.js
// returns an error to the user rather than a false "sent!" if mail isn't configured or the
// send fails) — so this one does NOT swallow failures silently the way sendResetEmail/
// sendVerificationCode do (those protect against user-enumeration timing; feedback has no
// such concern). `to` is always the app owner's inbox (RESEND_FEEDBACK_TO, falling back to
// RESEND_FROM_EMAIL if unset) — never user-controlled, so this can't be used to relay mail
// to an arbitrary address. `reply_to` is the user's own email so the owner can just hit Reply.
async function sendFeedbackEmail(fromEmail, message) {
  const c = getClient();
  if (!c) {
    console.warn('[mailer] RESEND_API_KEY/RESEND_FROM_EMAIL not set — feedback email not sent.');
    return { ok: false };
  }
  const to = cfg.RESEND_FEEDBACK_TO || cfg.RESEND_FROM_EMAIL;
  try {
    const { error } = await c.emails.send({
      from: cfg.RESEND_FROM_EMAIL,
      to,
      reply_to: fromEmail,
      subject: 'SnapReceipt AI feedback from ' + fromEmail,
      text: 'From: ' + fromEmail + '\n\n' + message,
      html: '<p><strong>From:</strong> ' + fromEmail.replace(/[<>&]/g, '') + '</p><p>'
        + message.replace(/[<>&]/g, '').replace(/\n/g, '<br>') + '</p>',
    });
    if (error) { console.error('[mailer] sendFeedbackEmail failed:', error.message || JSON.stringify(error)); return { ok: false }; }
    return { ok: true };
  } catch (e) {
    console.error('[mailer] sendFeedbackEmail failed:', e.message);
    return { ok: false };
  }
}

// sendEmailVerification(toEmail, code, verifyUrl) -> Promise<void>. Never throws — same
// swallow-and-log contract as sendResetEmail, and for the same reason: POST
// /api/verify-email/request must answer identically whether or not the address has an
// account, so a delivery failure must not become a distinguishable error response.
//
// Carries BOTH proofs of the one challenge (P-01, lib/emailChallenge.js): the 6-digit
// code to type, and the link to tap. They consume the same single-use row, so whichever
// the user reaches for first invalidates the other.
//
// `verifyUrl` is built by the CALLER from cfg.PUBLIC_URL — deliberately NOT from the
// request's Host header. Deriving a mailed link from an attacker-controllable Host is
// exactly the reset-link-poisoning finding recorded against /api/forgot-password in
// docs/FULL_APP_GAP_AUDIT_2026-08-24.md; this path must not repeat it. When no absolute
// base is configured the caller passes null and the email ships code-only.
async function sendEmailVerification(toEmail, code, verifyUrl) {
  const c = getClient();
  if (!c) {
    if (!warnedNoMailConfig) {
      warnedNoMailConfig = true;
      console.warn('[mailer] RESEND_API_KEY/RESEND_FROM_EMAIL not set — email-verification messages will not be sent. Set both in .env.personal.');
    }
    return;
  }
  const mins = Math.max(1, Math.round((Number(process.env.EMAIL_VERIFY_TTL_MS) || 15 * 60 * 1000) / 60000));
  const linkText = verifyUrl ? '\n\nOr just tap this link:\n' + verifyUrl + '\n' : '';
  const linkHtml = verifyUrl ? '<p>Or just <a href="' + verifyUrl + '">tap here to confirm your email</a>.</p>' : '';
  try {
    const { error } = await c.emails.send({
      from: cfg.RESEND_FROM_EMAIL,
      to: toEmail,
      subject: 'Confirm your SnapReceipt AI email',
      text: 'Welcome to SnapReceipt AI.\n\n'
        + 'Your confirmation code is: ' + code + '\n\n'
        + 'Enter it in the app to finish setting up your account. It expires in '
        + mins + ' minutes and can only be used once.' + linkText + '\n'
        + "If you didn't create a SnapReceipt AI account, you can safely ignore this email.",
      html: '<p>Welcome to SnapReceipt AI.</p>'
        + '<p>Your confirmation code is: <strong>' + code + '</strong></p>'
        + '<p>Enter it in the app to finish setting up your account. It expires in '
        + mins + ' minutes and can only be used once.</p>' + linkHtml
        + "<p>If you didn't create a SnapReceipt AI account, you can safely ignore this email.</p>",
    });
    if (error) console.error('[mailer] sendEmailVerification failed:', error.message || JSON.stringify(error));
  } catch (e) {
    console.error('[mailer] sendEmailVerification failed:', e.message);
  }
}

module.exports = { sendResetEmail, sendVerificationCode, sendFeedbackEmail, sendEmailVerification };

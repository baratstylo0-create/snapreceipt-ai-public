'use strict';
// HitPay (2026-07-30) — the Free/Pro payment provider for personal (personalAuth) owner
// accounts, replacing the earlier Curlec choice (see plan file). Two responsibilities:
//   createCheckout()          — start a recurring-billing subscription, get back the
//                                hosted checkout URL to send the user to.
//   verifyWebhookSignature()  — confirm an incoming webhook actually came from HitPay
//                                before trusting it (HMAC-SHA256 over the raw JSON body,
//                                using the dashboard Salt value, per HitPay's docs).
// Degrade-safe throughout: every function checks cfg.HITPAY_API_KEY / HITPAY_SALT are set
// and returns a clear "not configured" result instead of throwing when they're not — same
// pattern as lib/mailer.js when RESEND_API_KEY is unset.
const crypto = require('node:crypto');
const { cfg } = require('./config');
const { hreq } = require('./http');

// Fixed tiers (confirmed 2026-07-25, unchanged by the provider switch) — created inline on
// HitPay per-checkout (plan_id: null) rather than pre-registered HitPay Plan objects, so
// there's no separate "create the plan once, store its ID" setup step to keep in sync.
const PLAN_PRICING = {
  monthly: { amount: '12.90', cycle: 'monthly', label: 'SnapReceipt AI Pro (Monthly)' },
  yearly: { amount: '99.00', cycle: 'yearly', label: 'SnapReceipt AI Pro (Yearly)' },
};

function isConfigured() {
  return !!(cfg.HITPAY_API_KEY && cfg.HITPAY_API_URL);
}

// createCheckout({ email, name, billingCycle, userId, redirectUrl }) -> the hosted checkout
// URL to redirect the browser to, or null if HitPay isn't configured yet (caller shows a
// "billing isn't set up yet" message instead of a broken checkout button).
async function createCheckout({ email, name, billingCycle, userId, redirectUrl }, deps = {}) {
  if (!isConfigured()) return { ok: false, error: 'HitPay is not configured yet.' };
  const tier = PLAN_PRICING[billingCycle];
  if (!tier) return { ok: false, error: 'Unknown billing cycle: ' + billingCycle };
  const req = deps.hreq || hreq;
  try {
    const res = await req({
      method: 'POST',
      url: cfg.HITPAY_API_URL + '/recurring-billing',
      headers: { 'X-BUSINESS-API-KEY': cfg.HITPAY_API_KEY },
      json: true,
      body: {
        plan_id: null,
        name: tier.label,
        cycle: tier.cycle,
        amount: tier.amount,
        currency: 'MYR',
        customer_email: email,
        customer_name: name || email,
        // start_date required as YYYY-MM-DD (SGT, per HitPay docs) — today, in Malaysia's
        // timezone (same as SGT, UTC+8), so a subscription started late at night doesn't
        // accidentally date to "yesterday" against HitPay's server-side date check.
        start_date: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10),
        redirect_url: redirectUrl,
        // reference (2026-07-30): our own user_id, echoed back on the webhook so
        // handleWebhook can find the right account without a separate lookup table.
        reference: userId,
        send_email: false,
      },
    });
    if (!res || !res.url) {
      return { ok: false, error: (res && res.message) || 'HitPay did not return a checkout URL.' };
    }
    return { ok: true, checkoutUrl: res.url, hitpaySubscriptionId: res.id || null };
  } catch (e) {
    console.error('[hitpay] createCheckout failed:', e.message);
    return { ok: false, error: 'Could not reach HitPay. Please try again.' };
  }
}

// verifyWebhookSignature(rawBody, signatureHeader) -> boolean. rawBody MUST be the exact
// raw request bytes/string HitPay sent (not a re-serialized JSON.stringify of the parsed
// object — re-serializing can reorder keys or change whitespace, breaking the HMAC match).
// Constant-time compare so this can't be timed to guess a valid signature byte-by-byte.
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!cfg.HITPAY_SALT || !signatureHeader || !rawBody) return false;
  const expected = crypto.createHmac('sha256', cfg.HITPAY_SALT).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signatureHeader), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { isConfigured, createCheckout, verifyWebhookSignature, PLAN_PRICING };

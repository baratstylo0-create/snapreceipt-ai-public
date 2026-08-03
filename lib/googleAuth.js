'use strict';
// Google Sign-In (2026-07-30) — "Continue with Google" for personal (personalAuth) owner
// accounts. Server-side authorization-code flow (no client-side Google JS SDK — keeps the
// existing strict CSP / no-inline-script setup untouched): routes/googleAuth.js sends the
// browser to Google, Google redirects back with a `code`, this module exchanges it for an
// id_token and verifies it. Degrade-safe like lib/hitpay.js: isConfigured() lets the route
// show "not set up yet" instead of throwing when the two env vars are unset.
const { cfg } = require('./config');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const TOKENINFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo';
const SCOPE = 'openid email profile';

function isConfigured() {
  return !!(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET);
}

// buildAuthUrl({redirectUri, state}) -> the URL to redirect the browser to. prompt=select_account
// so a user with multiple Google sessions in one browser always picks explicitly, rather than
// silently reusing whichever account Google last remembered.
function buildAuthUrl({ redirectUri, state }) {
  const qs = new URLSearchParams({
    client_id: cfg.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    state,
    prompt: 'select_account',
  });
  return AUTH_ENDPOINT + '?' + qs.toString();
}

// exchangeCode({code, redirectUri}) -> { idToken, accessToken }. Uses the token endpoint's
// documented application/x-www-form-urlencoded body directly (not lib/http.js's hreq — hreq's
// `json` flag couples request-body AND response-parsing together, which doesn't fit this one
// call: the request must be form-encoded but the response is still JSON).
async function exchangeCode({ code, redirectUri }, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const body = new URLSearchParams({
    code,
    client_id: cfg.GOOGLE_CLIENT_ID,
    client_secret: cfg.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const r = await doFetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || !data.id_token) {
    const msg = (data && (data.error_description || data.error)) || ('HTTP ' + r.status);
    throw new Error('Google token exchange failed: ' + msg);
  }
  return { idToken: data.id_token, accessToken: data.access_token || null };
}

// verifyIdToken(idToken) -> { email, name, sub } | throws. Uses Google's tokeninfo endpoint
// (validates signature/expiry server-side at Google) rather than pulling in a JWT-verification
// library for one call site — same "no new dependency where a plain HTTP call does the job"
// bias as the rest of this codebase (see lib/hitpay.js).
async function verifyIdToken(idToken, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const r = await doFetch(TOKENINFO_ENDPOINT + '?id_token=' + encodeURIComponent(idToken), {
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data) throw new Error('Google id_token verification failed');
  if (data.aud !== cfg.GOOGLE_CLIENT_ID) throw new Error('Google id_token was issued for a different client');
  if (data.email_verified !== 'true' && data.email_verified !== true) {
    throw new Error('Google account email is not verified');
  }
  if (!data.email) throw new Error('Google account has no email');
  return { email: String(data.email).toLowerCase(), name: data.name || '', sub: data.sub || '' };
}

module.exports = { isConfigured, buildAuthUrl, exchangeCode, verifyIdToken };

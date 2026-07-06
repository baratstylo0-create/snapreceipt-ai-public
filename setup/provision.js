'use strict';
// Bootstrap the first admin + a "Head Office" branch for a fresh managed-silo instance
// (ADR-021 Phase 2). Operator-run at deploy — `npm run setup-admin` — which fits our ADR-020
// hosting model ("we host it; the client just logs in"). This solves the chicken-and-egg: a
// brand-new instance has zero users, so login is impossible until one admin exists.
//
// What it does: reads ADMIN_USERNAME (default 'admin') from the environment, takes ADMIN_PASSWORD
// if given or auto-generates a strong one, then reuses lib/branches.createBranch with role:'admin'
// to create the admin `users` row (scrypt-hashed password — only the hash is stored), a "Head
// Office" branch (the admin captures HQ petty cash there), and a one-time `/start` bot-binding
// token. Credentials are printed to stdout EXACTLY ONCE — never stored or logged in plaintext.
//
// Safety: refuses if an admin already exists (unless --force), so a re-run can't silently mint a
// second admin. There is deliberately NO web-exposed setup route — an unauthenticated bootstrap
// endpoint would be a standing liability; provisioning is a local operator action only.
const { sbSelect } = require('../lib/supabase');
const { createBranch } = require('../lib/branches');
const { getCapabilities } = require('../lib/account');

const HEAD_OFFICE = 'Head Office';

// provisionAdmin({ force? }) -> { created:true, ...createBranch result } | { created:false, reason }.
// Pure of any stdout so it's unit-testable; the CLI wrapper below handles printing.
async function provisionAdmin({ force = false } = {}) {
  const username = (process.env.ADMIN_USERNAME || 'admin').trim();
  const password = process.env.ADMIN_PASSWORD ? String(process.env.ADMIN_PASSWORD) : null; // null -> auto-generate

  // Idempotency guard: an existing active admin means this instance is already bootstrapped.
  const existing = await sbSelect('users', { eq: { role: 'admin', active: true }, limit: 1 });
  if (existing.length && !force) {
    return { created: false, reason: 'an admin already exists — re-run with --force to add another' };
  }

  const result = await createBranch({ office: HEAD_OFFICE, role: 'admin', clerkName: username, username, password });
  return { created: true, ...result };
}

// Build the Telegram deep link the admin taps once to bind their chat (BOT_USERNAME optional —
// without it we still print the raw token so the operator can hand it over).
function bindingLink(bindToken) {
  const bot = (process.env.BOT_USERNAME || '').replace(/^@/, '').trim();
  return bot ? 'https://t.me/' + bot + '?start=' + bindToken : '(set BOT_USERNAME to render a t.me link) token=' + bindToken;
}

// --- CLI ---------------------------------------------------------------------
async function main() {
  if (!getCapabilities().multiUser) {
    console.error('setup-admin: this instance is not business-mode (capabilities.multiUser is OFF).');
    console.error('  Set ACCOUNT_TYPE=business (or CAP_MULTI_USER=true) before provisioning an admin.');
    process.exit(1);
  }
  const force = process.argv.includes('--force');
  let r;
  try {
    r = await provisionAdmin({ force });
  } catch (e) {
    console.error('setup-admin: failed —', e.message);
    process.exit(1);
  }
  if (!r.created) {
    console.error('setup-admin: ' + r.reason);
    process.exit(2);
  }
  // The ONE and only time the plaintext password is ever shown. Not logged anywhere.
  console.log('\n=== Admin provisioned (save these now — shown ONCE) ===');
  console.log('  Username : ' + r.credentials.username);
  console.log('  Password : ' + r.credentials.password);
  console.log('  Branch   : ' + HEAD_OFFICE + ' (id ' + r.branch.id + ')');
  console.log('  Bot link : ' + bindingLink(r.bindToken));
  console.log('========================================================\n');
}

if (require.main === module) main();

module.exports = { provisionAdmin, bindingLink };

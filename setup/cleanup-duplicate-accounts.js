'use strict';
// 2026-08-22 — cleanup for duplicate owner accounts caused by the unscoped-username-lookup
// bug (fixed same day in lib/personalAuth.js, routes/googleAuth.js, routes/auth.js — see
// lib/supabase.js's sbSelectGlobal doc comment). Each duplicate below was verified to have
// ZERO expenses and ZERO bound Telegram chat_id before being listed here — deleting them
// loses no real data, only an empty stray account shell.
//
// USAGE:
//   node setup/cleanup-duplicate-accounts.js          (DRY RUN — prints what would be deleted)
//   node setup/cleanup-duplicate-accounts.js --apply   (WRITES)
require('dotenv').config();
const { cfg } = require('../lib/config');
const { hreq } = require('../lib/http');

const enc = encodeURIComponent;

// { label, userId } — the EMPTY duplicate row to remove. The real/kept account is untouched.
const DUPLICATES = [
  { label: 'baratstylo0@gmail.com (empty duplicate, created 2026-08-22 05:12 UTC)', userId: '74a2a8d6-cd2c-49bd-9fb2-6278ef1680bb' },
  { label: 'jeevank1811@gmail.com (empty duplicate, created 2026-08-21 13:36 UTC)', userId: '4e1ca35a-c40b-4ed6-97a0-b47cd0e0fc38' },
  { label: 'brt928314@gmail.com (empty duplicate, created 2026-07-27 13:17 UTC)', userId: '7af4c17f-bf91-41fc-a63d-53121a53a5d8' },
];

async function sbGet(table, eq) {
  const qs = Object.entries(eq).map(([k, v]) => k + '=eq.' + enc(v)).join('&');
  return hreq({ url: cfg.SB_REST + '/' + table + '?' + qs, headers: cfg.sbH, json: true });
}

async function sbDel(table, eq) {
  const qs = Object.entries(eq).map(([k, v]) => k + '=eq.' + enc(v)).join('&');
  return hreq({ method: 'DELETE', url: cfg.SB_REST + '/' + table + '?' + qs,
    headers: { ...cfg.sbH, Prefer: 'return=representation' }, json: true });
}

async function main() {
  const apply = process.argv.includes('--apply');

  console.log((apply ? 'APPLYING' : 'DRY RUN') + ' — ' + DUPLICATES.length + ' duplicate accounts\n');

  for (const dup of DUPLICATES) {
    const exp = await sbGet('expenses', { account_id: (await sbGet('users', { id: dup.userId }))[0]?.account_id || '__none__' });
    const expCount = Array.isArray(exp) ? exp.length : -1;
    console.log(dup.label);
    console.log('  user_id: ' + dup.userId);
    console.log('  expense count on this account: ' + expCount + (expCount > 0 ? '  *** NOT EMPTY, SKIPPING ***' : ''));

    if (expCount !== 0) {
      console.log('  SKIPPED — this account is not empty, refusing to delete.\n');
      continue;
    }

    if (!apply) {
      console.log('  would delete: bot_bindings, sessions, users row\n');
      continue;
    }

    const b = await sbDel('bot_bindings', { user_id: dup.userId });
    console.log('  bot_bindings deleted: ' + (Array.isArray(b) ? b.length : b));
    const s = await sbDel('sessions', { user_id: dup.userId });
    console.log('  sessions deleted: ' + (Array.isArray(s) ? s.length : s));
    const u = await sbDel('users', { id: dup.userId });
    console.log('  user row deleted: ' + (Array.isArray(u) && u.length === 1 ? 'OK' : JSON.stringify(u)));
    console.log('');
  }

  if (apply) {
    const all = await hreq({ url: cfg.SB_REST + '/users?role=eq.owner&select=id,username', headers: cfg.sbH, json: true });
    const byUsername = {};
    for (const u of all) byUsername[u.username] = (byUsername[u.username] || 0) + 1;
    const dups = Object.entries(byUsername).filter(([, c]) => c > 1);
    console.log('=== VERIFY ===');
    console.log('Remaining duplicate usernames: ' + dups.length);
    if (dups.length) dups.forEach(([name, c]) => console.log('  ' + name + ' (' + c + ' rows)'));
    else console.log('PASS - no duplicate owner accounts remain');
  } else {
    console.log('Re-run with --apply to execute.');
  }
}

main().catch(e => { console.error('FATAL:', e.stack); process.exit(1); });

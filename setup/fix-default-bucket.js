'use strict';
// 2026-08-21 — isolate the 4 old test/demo owner accounts still sharing account_id='default'.
// These are all pre-deployment test accounts (chrometest, old brt928314 dup, ux walkthrough, demo video).
// No real user data at risk, but cleaning up so zero owners share any account_id.
require('dotenv').config();
const crypto = require('node:crypto');
const { cfg } = require('../lib/config');
const { hreq } = require('../lib/http');

const enc = encodeURIComponent;

async function sbPatch(table, eqFilter, body) {
  const qs = Object.entries(eqFilter).map(([k, v]) => k + '=eq.' + enc(v)).join('&');
  return hreq({ method: 'PATCH', url: cfg.SB_REST + '/' + table + '?' + qs,
    headers: { ...cfg.sbH, Prefer: 'return=representation' }, body, json: true });
}

async function main() {
  const apply = process.argv.includes('--apply');
  const owners = await hreq({ url: cfg.SB_REST + '/users?account_id=eq.default&role=eq.owner&select=id,username',
    headers: cfg.sbH, json: true });

  if (!Array.isArray(owners) || !owners.length) {
    console.log('No owners on account_id=default. Already clean.');
    return;
  }

  console.log(owners.length + ' test owners on default bucket:');
  owners.forEach(u => console.log('  ' + u.username + ' (' + u.id.slice(0, 8) + ')'));

  if (!apply) {
    console.log('\nDRY RUN — re-run with --apply to isolate these test accounts.');
    return;
  }

  console.log('\n=== APPLYING ===');
  for (const u of owners) {
    const newAcc = 'p_' + crypto.randomUUID();
    const r = await sbPatch('users', { id: u.id }, { account_id: newAcc });
    console.log((Array.isArray(r) && r.length ? 'OK' : 'FAIL') + ' ' + u.username + ' -> ' + newAcc.slice(0, 16));

    // Move their sessions
    const s = await sbPatch('sessions', { account_id: 'default', user_id: u.id }, { account_id: newAcc });
    if (Array.isArray(s) && s.length) console.log('  ' + s.length + ' sessions migrated');

    // Move their bot_bindings
    const b = await sbPatch('bot_bindings', { account_id: 'default', user_id: u.id }, { account_id: newAcc });
    if (Array.isArray(b) && b.length) console.log('  ' + b.length + ' bot_bindings migrated');
  }

  // Verify
  const remaining = await hreq({ url: cfg.SB_REST + '/users?account_id=eq.default&role=eq.owner&select=id,username',
    headers: cfg.sbH, json: true });
  console.log('\nOwners still on default: ' + (Array.isArray(remaining) ? remaining.length : '?'));

  // Full clash check
  const allOwners = await hreq({ url: cfg.SB_REST + '/users?role=eq.owner&select=id,username,account_id',
    headers: cfg.sbH, json: true });
  const accMap = {};
  for (const u of allOwners) {
    if (!accMap[u.account_id]) accMap[u.account_id] = [];
    accMap[u.account_id].push(u.username);
  }
  const clashes = Object.entries(accMap).filter(([, users]) => users.length > 1);
  console.log('Clashes remaining: ' + clashes.length);
  if (clashes.length) clashes.forEach(([acc, users]) => console.log('  ' + acc.slice(0, 16) + ': ' + users.join(', ')));
  else console.log('PASS - zero owner clashes across ALL accounts');
}

main().catch(e => { console.error('FATAL:', e.stack); process.exit(1); });

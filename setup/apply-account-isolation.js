'use strict';
// 2026-08-21 — targeted migration for the 7 owners sharing account_id='snapreceiptai'.
// Gives each owner a unique p_<uuid> account_id and moves their data rows accordingly.
//
// USAGE:
//   node setup/apply-account-isolation.js              (DRY RUN)
//   node setup/apply-account-isolation.js --apply      (WRITES)
require('dotenv').config();
const crypto = require('node:crypto');
const { cfg } = require('../lib/config');
const { hreq } = require('../lib/http');

const enc = encodeURIComponent;
const OLD = cfg.ACCOUNT_ID; // 'snapreceiptai'

const BARAT_USER_ID  = 'b5d76504-6d51-4220-872e-7fa3b8b839f2';
const BARAT_CHAT     = '1376793145';
const JEEVAN_USER_ID = 'de1c82dd-65a6-4d59-a5ee-691843d47df6';
const JEEVAN_EXPENSE = 'a182ff58-08e3-475a-89fe-7f95d731b053';
const BARAT_EXPENSES = [
  'a238b304-ede6-40bc-bce5-b8b3b2ad4f56',
  'a1d4e290-c049-4445-a18d-4f9d3a72f82d',
  'ad2a5152-c6ec-475d-aee8-2887a37d36ed',
  '5e0f8011-3532-41aa-aa02-4f2abcb836d7',
];

async function sbPatch(table, eqFilter, body) {
  const qs = Object.entries(eqFilter).map(([k, v]) => k + '=eq.' + enc(v)).join('&');
  const url = cfg.SB_REST + '/' + table + '?' + qs;
  return hreq({ method: 'PATCH', url, headers: { ...cfg.sbH, Prefer: 'return=representation' }, body, json: true });
}

async function sbGet(table, eqFilter, select) {
  const qs = Object.entries(eqFilter).map(([k, v]) => k + '=eq.' + enc(v)).join('&');
  const s = select ? '&select=' + enc(select) : '';
  const url = cfg.SB_REST + '/' + table + '?' + qs + s + '&limit=1000';
  return hreq({ url, headers: cfg.sbH, json: true });
}

async function main() {
  const apply = process.argv.includes('--apply');

  // Confirm precondition: owners sharing the old account_id
  const owners = await sbGet('users', { account_id: OLD, role: 'owner' }, 'id,username,account_id');
  if (!Array.isArray(owners) || owners.length === 0) {
    console.log('No owners on account_id=' + OLD + '. Already migrated?');
    return;
  }
  console.log(owners.length + ' owners currently sharing account_id=' + OLD + ':');
  owners.forEach(u => console.log('  ' + u.username + ' (' + u.id.slice(0, 8) + ')'));

  // Generate deterministic-for-this-run unique account_ids
  const newAccIds = {};
  for (const u of owners) newAccIds[u.id] = 'p_' + crypto.randomUUID();

  const baratAcc  = newAccIds[BARAT_USER_ID];
  const jeevanAcc = newAccIds[JEEVAN_USER_ID];

  if (!apply) {
    console.log('\n=== DRY RUN ===');
    console.log('Would assign:');
    for (const u of owners) console.log('  ' + u.username + ' -> ' + newAccIds[u.id]);
    console.log('Would move ' + BARAT_EXPENSES.length + ' Barat expenses + bot_binding + sessions');
    console.log('Would move Jeevan Hostinger expense ' + JEEVAN_EXPENSE.slice(0, 8));
    console.log('\nRe-run with --apply to execute.');
    return;
  }

  console.log('\n=== APPLYING ===');
  let ok = 0, fail = 0;

  // Step 1: Give all 7 owners their own unique account_id
  for (const u of owners) {
    const r = await sbPatch('users', { id: u.id, account_id: OLD }, { account_id: newAccIds[u.id] });
    if (Array.isArray(r) && r.length === 1) {
      ok++;
      console.log('OK user ' + u.username + ' -> ' + newAccIds[u.id].slice(0, 12) + '...');
    } else {
      fail++;
      console.error('FAIL user ' + u.username + ': ' + JSON.stringify(r).slice(0, 200));
    }
  }
  console.log('Step 1: ' + ok + '/' + owners.length + ' users migrated\n');

  // Step 2: Move Barat's 4 Telegram expenses
  let expOk = 0;
  for (const eid of BARAT_EXPENSES) {
    const r = await sbPatch('expenses', { id: eid, account_id: OLD }, { account_id: baratAcc });
    if (Array.isArray(r) && r.length === 1) {
      expOk++;
      console.log('OK expense ' + (r[0].merchant || eid.slice(0, 8)) + ' -> Barat');
    } else {
      console.error('FAIL expense ' + eid + ': ' + JSON.stringify(r).slice(0, 200));
    }
  }
  console.log('Step 2: ' + expOk + '/4 Barat expenses migrated');

  // Step 2b: Move Barat's bot_binding
  const bb = await sbPatch('bot_bindings', { account_id: OLD, chat_id: BARAT_CHAT }, { account_id: baratAcc });
  console.log('Bot binding: ' + (Array.isArray(bb) && bb.length ? 'OK' : 'FAIL ' + JSON.stringify(bb).slice(0, 100)));

  // Step 2c: Move Barat's sessions
  const bSess = await sbPatch('sessions', { account_id: OLD, user_id: BARAT_USER_ID }, { account_id: baratAcc });
  console.log('Barat sessions: ' + (Array.isArray(bSess) ? bSess.length + ' migrated' : 'none/fail'));

  // Step 3: Move Jeevan's Hostinger expense
  const host = await sbPatch('expenses', { id: JEEVAN_EXPENSE, account_id: OLD }, { account_id: jeevanAcc });
  console.log('Hostinger -> Jeevan: ' + (Array.isArray(host) && host.length === 1 ? 'OK' : 'FAIL'));

  // Step 3b: Move Jeevan's sessions
  const jSess = await sbPatch('sessions', { account_id: OLD, user_id: JEEVAN_USER_ID }, { account_id: jeevanAcc });
  console.log('Jeevan sessions: ' + (Array.isArray(jSess) ? jSess.length + ' migrated' : 'none/fail'));

  // Step 4: Move remaining users' sessions
  for (const u of owners) {
    if (u.id === BARAT_USER_ID || u.id === JEEVAN_USER_ID) continue;
    const s = await sbPatch('sessions', { account_id: OLD, user_id: u.id }, { account_id: newAccIds[u.id] });
    if (Array.isArray(s) && s.length) console.log('Sessions for ' + u.username + ': ' + s.length + ' migrated');
  }

  // Verify: no owners left on old account_id
  console.log('\n=== VERIFY ===');
  const remaining = await sbGet('users', { account_id: OLD, role: 'owner' }, 'id,username');
  if (Array.isArray(remaining)) {
    console.log(remaining.length + ' owners still on old account_id');
    remaining.forEach(u => console.log('  STILL SHARED: ' + u.username));
  }

  // Show Barat's new account_id for reference
  console.log('\nBarat new account_id: ' + baratAcc);
  console.log('Jeevan new account_id: ' + jeevanAcc);
  console.log('\nDone. Users will pick up new account_id on next login (session refresh).');
}

main().catch(e => { console.error('FATAL:', e.stack); process.exit(1); });

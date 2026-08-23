'use strict';
// 2026-08-14 SECURITY FIX — one-time backfill for existing accounts created BEFORE
// mintSession/signupOwner/googleAuth stamped a unique account_id per owner.
//
// WHY THIS EXISTS: every personal ("owner") account created before today's fix shares the
// literal account_id 'default' — the DB column's own default, never overridden. Two such
// accounts can read/edit/delete each other's receipts (see lib/auth.js scopeForUser + the
// schema.sql Guest Mode migration comment, which flagged this exact gap). The code fix stops
// any NEW signup from landing in that shared bucket; this script is what actually separates
// whatever ALREADY landed there.
//
// SAFE BY CONSTRUCTION, NOT BY ASSUMPTION:
//   - Exactly ONE owner under the shared account_id -> fully automatic. There is no other
//     owner to confuse their rows with, so every 'default'-account_id row across every
//     account-scoped table unambiguously belongs to them.
//   - TWO OR MORE owners under the shared account_id -> this script REFUSES to guess. A
//     dashboard-uploaded receipt (routes/upload.js) carries no chat_id linking it to a
//     specific owner if the account_id-based split is gone (rep_chat_id would only reliably
//     separate BOT-captured rows). Silently attributing financial records on a heuristic
//     is not an acceptable risk here. Instead it prints a per-owner report (bound Telegram
//     chat_id, bot-capturable row count via rep_chat_id, and the ambiguous leftover count)
//     for a human to review before anyone hand-writes a resolution.
//
// USAGE:
//   node setup/backfill-account-isolation.js            (DRY RUN — prints the plan, writes nothing)
//   node setup/backfill-account-isolation.js --apply     (actually performs the safe single-owner case)
//
// Tables touched (every one that carries account_id and can be owner-specific):
//   users, bot_bindings, expenses, category_corrections, subscriptions
const { sbSelect, sbUpdate } = require('../lib/supabase');
const { cfg } = require('../lib/config');

function genAccountId() { return 'p_' + require('node:crypto').randomUUID(); }

async function main() {
  const apply = process.argv.includes('--apply');
  const sharedId = cfg.ACCOUNT_ID; // 'default' unless ACCOUNT_ID is set in .env

  const owners = (await sbSelect('users', { eq: { role: 'owner' }, limit: 1000 }))
    .filter((u) => u.account_id === sharedId);

  if (owners.length === 0) {
    console.log('No owner accounts found under account_id="' + sharedId + '". Nothing to do.');
    return;
  }

  if (owners.length === 1) {
    const owner = owners[0];
    const newId = genAccountId();
    console.log('Single owner account found under the shared account_id — safe to migrate automatically.');
    console.log('  user id:      ' + owner.id);
    console.log('  username:     ' + owner.username);
    console.log('  new account_id: ' + newId);

    const tables = ['expenses', 'bot_bindings', 'category_corrections', 'subscriptions'];
    if (!apply) {
      console.log('\nDRY RUN — no changes written. Re-run with --apply to perform this migration.');
      for (const t of tables) {
        const rows = await sbSelect(t, { eq: { account_id: sharedId }, limit: 10000 });
        console.log('  would move ' + rows.length + ' row(s) in "' + t + '" to the new account_id');
      }
      console.log('  would then set users.account_id -> new value for user ' + owner.id);
      return;
    }

    for (const t of tables) {
      const rows = await sbSelect(t, { eq: { account_id: sharedId }, limit: 10000 });
      for (const row of rows) {
        await sbUpdate(t, { id: row.id }, { account_id: newId });
      }
      console.log('  moved ' + rows.length + ' row(s) in "' + t + '"');
    }
    // users row last — once it moves, a fresh sbSelect no longer matches sharedId for this user,
    // so this MUST run after every data table above, not before.
    await sbUpdate('users', { id: owner.id }, { account_id: newId });
    console.log('  updated users.account_id for ' + owner.id);
    console.log('\nDone. This user must log out and log back in (or their session naturally expires within 12h) to pick up the new account_id.');
    return;
  }

  // Multiple owners sharing the same account_id — do NOT guess. Print a report only.
  console.log(owners.length + ' owner accounts found sharing account_id="' + sharedId + '".');
  console.log('This script will NOT auto-migrate a multi-owner bucket — a wrong guess here means');
  console.log('showing (or deleting) the wrong person\'s financial records. Manual review required.\n');

  const bindings = await sbSelect('bot_bindings', { eq: { account_id: sharedId }, limit: 1000 });
  const allExpenses = await sbSelect('expenses', { eq: { account_id: sharedId }, limit: 10000 });

  for (const owner of owners) {
    const binding = bindings.find((b) => b.user_id === owner.id);
    const chatId = binding && binding.chat_id;
    const attributable = chatId ? allExpenses.filter((e) => e.rep_chat_id === String(chatId)).length : 0;
    console.log('- ' + owner.username + '  (user id ' + owner.id + ')');
    console.log('    bound Telegram chat_id: ' + (chatId || '(not bound)'));
    console.log('    bot-captured rows attributable via rep_chat_id: ' + attributable);
  }
  const linked = new Set(bindings.filter((b) => b.chat_id).map((b) => String(b.chat_id)));
  const ambiguous = allExpenses.filter((e) => !linked.has(e.rep_chat_id)).length;
  console.log('\n  rows NOT attributable to any bound chat_id (dashboard uploads / unbound sends): ' + ambiguous);
  console.log('\nNext step: decide with each affected user which of the ambiguous rows are theirs before');
  console.log('writing a targeted per-row migration. Do not run this automatically.');
}

main().catch((e) => { console.error('backfill failed:', e.message); process.exit(1); });

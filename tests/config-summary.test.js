'use strict';
// configSummary() exists so the ACTIVE runtime config (esp. DEFAULT_CURRENCY) is printed
// loudly on every boot. Root cause of the "all receipts saved as USD" incident: a live
// .env was edited to DEFAULT_CURRENCY=MYR mid-session, but the already-running process
// kept its old USD snapshot (dotenv loads .env into process.env ONCE at startup, so a file
// edit never reaches a running process — a restart is the only fix). A silent snapshot made
// that invisible; a boot banner turns "forgot to restart / stale config" into something an
// operator SEES on the next start, instead of discovering it in the data weeks later.
//
// NB: this is intentionally NOT a "live getter" (cf. AUTH_REQUIRED). A getter reading
// process.env would return the SAME stale value, because the staleness lives in process.env
// (dotenv-loaded once), not in the cfg snapshot — so a getter would not have prevented the
// incident. Visibility-at-boot is the honest, effective mitigation.
process.env.DEFAULT_CURRENCY = 'SGD'; // set BEFORE requiring config so the snapshot picks it up
process.env.ACCOUNT_ID = 'acme';
const test = require('node:test');
const assert = require('node:assert');
const { configSummary, cfg } = require('../lib/config');

test('configSummary() surfaces the ACTIVE default currency (the thing the incident hid)', () => {
  const s = configSummary();
  assert.match(s, /currency=SGD/, 'the live currency must be visible in the boot banner');
});

test('configSummary() also surfaces the account so a wrong tenant is obvious at boot', () => {
  assert.match(configSummary(), /account=acme/);
});

test('configSummary() reflects cfg exactly (no second, driftable copy of the values)', () => {
  const s = configSummary();
  assert.match(s, new RegExp('currency=' + cfg.DEFAULT_CURRENCY));
  assert.match(s, new RegExp('account=' + cfg.ACCOUNT_ID));
});

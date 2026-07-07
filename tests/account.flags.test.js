'use strict';
// lib/account.js getCapabilities — the ADR-022 per-client profile flags (Phase 7).
// Defaults must equal the GENERAL product (merge ON, grid ON, submission OFF) so no
// existing deployment's behaviour shifts; each is individually env-overridable, which
// is exactly how a client profile (e.g. Premala) is expressed — config, never a fork.
const test = require('node:test');
const assert = require('node:assert');
const { getCapabilities } = require('../lib/account');

const KEYS = ['CAP_LIVE_MASTER_MERGE', 'CAP_EXCEL_LITE_GRID', 'CAP_BRANCH_SUBMISSION', 'CAP_MULTI_USER', 'CAP_COMPANY_DIMENSION', 'CAP_PETTY_CASH', 'ACCOUNT_TYPE'];

function withEnv(vars, fn) {
  const saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('defaults (no env): liveMasterMerge ON, excelLiteGrid ON, branchSubmission OFF', () => {
  withEnv({}, () => {
    const caps = getCapabilities();
    assert.strictEqual(caps.liveMasterMerge, true);
    assert.strictEqual(caps.excelLiteGrid, true);
    assert.strictEqual(caps.branchSubmission, false);
  });
});

test('defaults hold even for ACCOUNT_TYPE=business (profile flags are per-client, not per-type)', () => {
  withEnv({ ACCOUNT_TYPE: 'business' }, () => {
    const caps = getCapabilities();
    assert.strictEqual(caps.multiUser, true, 'business default flips multiUser');
    assert.strictEqual(caps.liveMasterMerge, true, 'merge stays ON unless the profile turns it off');
    assert.strictEqual(caps.excelLiteGrid, true);
    assert.strictEqual(caps.branchSubmission, false);
  });
});

test('the Premala profile combo resolves as specified (ADR-022)', () => {
  withEnv({
    CAP_MULTI_USER: 'true',
    CAP_LIVE_MASTER_MERGE: 'false',
    CAP_EXCEL_LITE_GRID: 'false',
    CAP_BRANCH_SUBMISSION: 'true',
  }, () => {
    const caps = getCapabilities();
    assert.strictEqual(caps.multiUser, true);
    assert.strictEqual(caps.liveMasterMerge, false);
    assert.strictEqual(caps.excelLiteGrid, false);
    assert.strictEqual(caps.branchSubmission, true);
  });
});

// ADR-023 Phase 8: the company dimension (Group→Company→Branch→Staff). OFF by default so the
// single-company product is byte-for-byte unchanged; a client with multiple legal entities flips
// it on via config (never a fork).
test('companyDimension defaults OFF and is env-overridable (ADR-023)', () => {
  withEnv({}, () => {
    assert.strictEqual(getCapabilities().companyDimension, false, 'default OFF (single-company)');
  });
  withEnv({ CAP_COMPANY_DIMENSION: 'true' }, () => {
    assert.strictEqual(getCapabilities().companyDimension, true);
  });
});

test('companyDimension stays OFF even for ACCOUNT_TYPE=business (per-client, not per-type)', () => {
  withEnv({ ACCOUNT_TYPE: 'business' }, () => {
    assert.strictEqual(getCapabilities().companyDimension, false, 'not implied by the business default');
  });
});

// ADR-023 Phase 9: petty-cash floats + claim engine. OFF by default so the product without
// petty-cash reimbursement is byte-for-byte unchanged; a client that runs branch floats (Premala)
// flips it on via config. Not implied by the business default — a per-client choice.
test('pettyCash defaults OFF and is env-overridable (ADR-023 Phase 9)', () => {
  withEnv({}, () => {
    assert.strictEqual(getCapabilities().pettyCash, false, 'default OFF (no petty-cash engine)');
  });
  withEnv({ CAP_PETTY_CASH: 'true' }, () => {
    assert.strictEqual(getCapabilities().pettyCash, true);
  });
});

test('pettyCash stays OFF even for ACCOUNT_TYPE=business (per-client, not per-type)', () => {
  withEnv({ ACCOUNT_TYPE: 'business' }, () => {
    assert.strictEqual(getCapabilities().pettyCash, false, 'not implied by the business default');
  });
});

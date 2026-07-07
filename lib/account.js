'use strict';
// Account capabilities — the single source of truth for what an account can do (ADR-010).
// One codebase, capability flags (NOT a personal/business fork). Default = PERSONAL: every
// business capability OFF, so the personal product is the simple baseline. A solopreneur flips
// on businessProfile + claimsTax; a full company also flips on multiUser (roles/admin queue).
//
// v1 is single-account, so capabilities are env-driven here. Forward-compatible: swap this to read
// a per-account settings row from Supabase later WITHOUT changing any caller (they call getCapabilities()).

function bool(v, def = false) {
  if (v == null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}

// getCapabilities() -> { account_type, businessProfile, claimsTax, bankReconciliation, multiUser,
//                         liveMasterMerge, excelLiteGrid, branchSubmission, businessType }
function getCapabilities() {
  const business = String(process.env.ACCOUNT_TYPE || 'personal').toLowerCase() === 'business';
  return {
    account_type: business ? 'business' : 'personal',
    // each capability defaults to the account_type default, but can be individually overridden
    businessProfile: bool(process.env.CAP_BUSINESS_PROFILE, business),
    claimsTax: bool(process.env.CAP_CLAIMS_TAX, business),
    bankReconciliation: bool(process.env.CAP_BANK_RECONCILIATION, business),
    multiUser: bool(process.env.CAP_MULTI_USER, business),
    // Per-client profile flags (ADR-022, Phase 7). Defaults = the GENERAL product:
    //   liveMasterMerge  — the live all-branch master surface; ON by default.
    //   excelLiteGrid    — the in-dashboard editable "Ledger" grid; ON by default.
    //   branchSubmission — the "Send to Admin" hand-off; OFF unless the client wants it.
    // Premala's profile (docs/clients/premala.md): merge OFF, grid OFF, submission ON.
    liveMasterMerge: bool(process.env.CAP_LIVE_MASTER_MERGE, true),
    excelLiteGrid: bool(process.env.CAP_EXCEL_LITE_GRID, true),
    branchSubmission: bool(process.env.CAP_BRANCH_SUBMISSION, false),
    businessType: process.env.BUSINESS_TYPE || '',
  };
}

module.exports = { getCapabilities };

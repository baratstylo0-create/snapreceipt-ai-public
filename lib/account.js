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

// getCapabilities() -> { account_type, businessProfile, claimsTax, bankReconciliation, multiUser, businessType }
function getCapabilities() {
  const business = String(process.env.ACCOUNT_TYPE || 'personal').toLowerCase() === 'business';
  return {
    account_type: business ? 'business' : 'personal',
    // each capability defaults to the account_type default, but can be individually overridden
    businessProfile: bool(process.env.CAP_BUSINESS_PROFILE, business),
    claimsTax: bool(process.env.CAP_CLAIMS_TAX, business),
    bankReconciliation: bool(process.env.CAP_BANK_RECONCILIATION, business),
    multiUser: bool(process.env.CAP_MULTI_USER, business),
    businessType: process.env.BUSINESS_TYPE || '',
  };
}

module.exports = { getCapabilities };

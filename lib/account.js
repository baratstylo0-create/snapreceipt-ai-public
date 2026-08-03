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
//                         personalAuth, liveMasterMerge, excelLiteGrid, branchSubmission,
//                         companyDimension, pettyCash, businessType }
function getCapabilities() {
  const business = String(process.env.ACCOUNT_TYPE || 'personal').toLowerCase() === 'business';
  return {
    account_type: business ? 'business' : 'personal',
    // each capability defaults to the account_type default, but can be individually overridden
    businessProfile: bool(process.env.CAP_BUSINESS_PROFILE, business),
    claimsTax: bool(process.env.CAP_CLAIMS_TAX, business),
    bankReconciliation: bool(process.env.CAP_BANK_RECONCILIATION, business),
    multiUser: bool(process.env.CAP_MULTI_USER, business),
    // personalAuth (2026-07-25): real email+password login for a PERSONAL (single-user)
    // deployment. Independent of multiUser/business — turns on session-based checkDash
    // WITHOUT opening the business route/UI surface (those routes keep checking multiUser
    // only, untouched). Deliberately does NOT default off of `business` like every other
    // flag above — it's orthogonal to ACCOUNT_TYPE, not a business sub-flag. Defaults false
    // so every existing personal deployment (DASHBOARD_TOKEN path) is byte-for-byte
    // unchanged unless an operator opts in.
    personalAuth: bool(process.env.CAP_PERSONAL_AUTH, false),
    // guestMode (2026-07-28): "Continue as Guest" trial accounts on Landing — no email/
    // password, capped at 4 receipts, data deleted on tab-close (best-effort) or within 24h
    // (safety net). Independent flag, same reasoning/default as personalAuth above — defaults
    // false so no existing deployment gets a Guest button until explicitly opted in. Routes
    // that create/use guest sessions also require personalAuth to be on (guest signup reuses
    // the same session/bot-binding machinery real accounts use).
    guestMode: bool(process.env.CAP_GUEST_MODE, false),
    // Per-client profile flags (ADR-022, Phase 7). Defaults = the GENERAL product:
    //   liveMasterMerge  — the live all-branch master surface; ON by default.
    //   excelLiteGrid    — the in-dashboard editable "Ledger" grid; ON by default.
    //   branchSubmission — the "Send to Admin" hand-off; OFF unless the client wants it.
    // Premala's profile (docs/clients/premala.md): merge OFF, grid OFF, submission ON.
    liveMasterMerge: bool(process.env.CAP_LIVE_MASTER_MERGE, true),
    excelLiteGrid: bool(process.env.CAP_EXCEL_LITE_GRID, true),
    branchSubmission: bool(process.env.CAP_BRANCH_SUBMISSION, false),
    // companyDimension (ADR-023, Phase 8) — the Group→Company→Branch→Staff layer. OFF by default so
    // the single-company product is byte-for-byte unchanged; a client with multiple legal entities
    // (e.g. Premala) flips it on. Not implied by the business default — it's a per-client choice.
    companyDimension: bool(process.env.CAP_COMPANY_DIMENSION, false),
    // pettyCash (ADR-023, Phase 9) — branch petty-cash floats + the claim engine (running-balance
    // maths, reimbursement claims). OFF by default so the product without petty-cash is byte-for-byte
    // unchanged; a client that runs branch floats (e.g. Premala) flips it on. A per-client choice,
    // not implied by the business default.
    pettyCash: bool(process.env.CAP_PETTY_CASH, false),
    businessType: process.env.BUSINESS_TYPE || '',
  };
}

module.exports = { getCapabilities };

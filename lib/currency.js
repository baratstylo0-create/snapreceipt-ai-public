'use strict';
/**
 * Currency conversion (#10) — convert a foreign expense amount into the account's
 * local currency using real, up-to-date FX rates. NOT an LLM task (DECISIONS ADR-005).
 *
 * - Rates come from a live FX API (Frankfurter/ECB by default — free, no key, daily).
 * - Rates are cached briefly so the app is fast and doesn't hammer the provider.
 * - Uses the rate for the receipt's own date when a date is given (most accurate),
 *   otherwise the latest rate.
 * - Fails SAFE: unknown currency or provider down → keep the original amount and
 *   return ok:false (never invent a rate, never throw into the caller's flow).
 *
 * Integration (wired by Barat in lib/ocr.js at ingestion — see PR notes):
 *   const { convertCurrency } = require('./currency');
 *   const fx = await convertCurrency(total, cur, cfg.DEFAULT_CURRENCY, date);
 *   if (fx.ok && fx.rate !== 1) { amount = fx.amount; currency = fx.to;
 *     amount_original = total; currency_original = cur; fx_rate = fx.rate; }
 */
const { cfg } = require('./config');
const { hreq } = require('./http');

const FX_API_URL    = (process.env.FX_API_URL || 'https://api.frankfurter.app').replace(/\/$/, '');
const FX_CACHE_HOURS = Number(process.env.FX_CACHE_HOURS || '24') || 24;

// In-memory rate cache: key `${date}|${FROM}|${TO}` -> { rate, at }
const _cache = new Map();

const isCode = c => /^[A-Za-z]{3}$/.test(String(c || '').trim());
const round2 = v => Math.round(((Number(v) || 0) + Number.EPSILON) * 100) / 100;

async function _fetchRate(from, to, date) {
  const path = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : 'latest';
  const url = FX_API_URL + '/' + path + '?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
  const res = await hreq({ url, json: true, timeout: 8000 });
  const rate = res && res.rates && Number(res.rates[to]);
  if (!rate || !isFinite(rate)) throw new Error('no rate for ' + from + '->' + to);
  return rate;
}

/** Get the FROM→TO rate (cached). Throws if the provider can't supply it. */
async function getRate(from, to, date) {
  from = String(from).toUpperCase();
  to = String(to).toUpperCase();
  if (from === to) return 1;
  const key = (date || 'latest') + '|' + from + '|' + to;
  const hit = _cache.get(key);
  if (hit && (Date.now() - hit.at) < FX_CACHE_HOURS * 3600 * 1000) return hit.rate;
  const rate = await _fetchRate(from, to, date);
  _cache.set(key, { rate, at: Date.now() });
  return rate;
}

/**
 * Convert `amount` from `from` currency to `to` (default = account DEFAULT_CURRENCY).
 * `date` (optional 'YYYY-MM-DD') uses the historical rate for that day.
 * Returns { amount, rate, from, to, ok, reason? } — always resolves, never rejects.
 */
async function convertCurrency(amount, from, to, date) {
  const n = Number(amount) || 0;
  const F = String(from || '').trim().toUpperCase();
  const T = String(to || cfg.DEFAULT_CURRENCY || 'USD').trim().toUpperCase();

  if (!isCode(F) || !isCode(T)) return { amount: n, rate: null, from: F, to: T, ok: false, reason: 'invalid_currency' };
  if (F === T) return { amount: round2(n), rate: 1, from: F, to: T, ok: true };

  try {
    const rate = await getRate(F, T, date);
    return { amount: round2(n * rate), rate, from: F, to: T, ok: true };
  } catch (e) {
    console.error('[currency]', e.message);
    return { amount: n, rate: null, from: F, to: T, ok: false, reason: 'fx_unavailable' };
  }
}

module.exports = { convertCurrency, getRate, _resetCache: () => _cache.clear() };

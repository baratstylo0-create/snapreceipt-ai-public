'use strict';
// Issue #53 fix: a browser sends an OPTIONS "preflight" before any cross-origin request
// that carries a custom header (Authorization) or a JSON body — PATCH/DELETE/POST to
// /api/*, and any Authorization-bearing GET to /receipt. Express has no built-in OPTIONS
// handling, so a preflight was falling through to the 404/error handler with NO CORS
// headers, causing the browser to abort the real request — meaning DASHBOARD_ORIGIN
// (cross-origin deploy) silently never worked. This middleware answers every OPTIONS
// preflight on the data-bearing surface directly, BEFORE any route/auth runs (a preflight
// carries no credentials, so it must never reach checkDash — Finder A #4).
const { cfg } = require('./config');

function dashOrigin() { return cfg.DASHBOARD_ORIGIN || '*'; }

function corsPreflight(req, res, next) {
  const p = (req && req.path) || '';
  const isDataBearing = p.indexOf('/api/') === 0 || p.indexOf('/receipt') === 0;
  if (req.method !== 'OPTIONS' || !isDataBearing) return next();
  res.set('Access-Control-Allow-Origin', dashOrigin());
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  return res.status(204).end();
}

module.exports = corsPreflight;

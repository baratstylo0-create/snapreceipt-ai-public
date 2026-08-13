'use strict';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '10.0.2.2']);

function parseServerUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    if (!url.hostname || url.pathname !== '/' && url.pathname !== '') return null;
    return url;
  } catch {
    return null;
  }
}

function isProductionServerUrl(value) {
  const url = parseServerUrl(value);
  return !!url && url.protocol === 'https:';
}

function isAllowedServerUrl(value) {
  const url = parseServerUrl(value);
  if (!url) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
}

function requireProductionServerUrl(value) {
  const clean = typeof value === 'string' ? value.trim().replace(/\/$/, '') : '';
  if (!isProductionServerUrl(clean)) {
    throw new Error('CAPACITOR_SERVER_URL must be an HTTPS production URL for a release build');
  }
  return clean;
}

module.exports = {
  isAllowedServerUrl,
  isProductionServerUrl,
  requireProductionServerUrl,
};

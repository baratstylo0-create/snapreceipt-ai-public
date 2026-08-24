'use strict';

const { cfg } = require('./config');

let client = null;
let enabled = false;

const SECRET_KEY_RE = /authorization|cookie|token|secret|password|api[-_]?key|dsn|session|credential/i;
const FINANCIAL_OR_PII_KEY_RE = /receipt|merchant|amount|total|subtotal|tax|card|email|phone|address|name|ocr|ai_raw|image|file|body|payload|query/i;
const SAFE_CONTEXT_KEYS = new Set(['status', 'method', 'route', 'path']);
const REDACTED_EXCEPTION_VALUE = '[redacted exception message]';

function safeScalar(value) {
  if (value == null) return undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 200);
  return undefined;
}

function scrubPathForSentry(input) {
  if (!input) return '';
  let path = String(input);
  try {
    path = new URL(path, 'http://local.invalid').pathname;
  } catch (_) {
    path = path.split('?')[0];
  }
  return path
    .split('/')
    .map((part) => {
      if (!part) return part;
      if (/^\d+$/.test(part)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part)) return ':id';
      if (part.length > 24) return ':id';
      return part;
    })
    .join('/') || '/';
}

function safeExtra(extra) {
  const out = {};
  if (!extra || typeof extra !== 'object') return out;
  for (const key of Object.keys(extra)) {
    if (!SAFE_CONTEXT_KEYS.has(key)) continue;
    if (SECRET_KEY_RE.test(key) || FINANCIAL_OR_PII_KEY_RE.test(key)) continue;
    const value = safeScalar(extra[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function scrubExceptionForSentry(exception) {
  if (!exception || typeof exception !== 'object') return exception;
  if (!Array.isArray(exception.values)) return exception;

  exception.values = exception.values.map((value) => {
    if (!value || typeof value !== 'object') return value;
    return {
      ...value,
      type: safeScalar(value.type),
      value: REDACTED_EXCEPTION_VALUE,
    };
  });
  return exception;
}

function scrubEventForSentry(event) {
  if (!event || typeof event !== 'object') return event;

  delete event.user;
  delete event.breadcrumbs;

  if (event.message) {
    event.message = REDACTED_EXCEPTION_VALUE;
  }

  if (event.exception && typeof event.exception === 'object') {
    event.exception = scrubExceptionForSentry(event.exception);
  }

  if (event.request && typeof event.request === 'object') {
    event.request = {
      method: safeScalar(event.request.method),
      url: scrubPathForSentry(event.request.url),
    };
  }

  if (event.extra && typeof event.extra === 'object') {
    event.extra = safeExtra(event.extra);
  }

  if (event.tags && typeof event.tags === 'object') {
    const tags = {};
    for (const key of Object.keys(event.tags)) {
      if (SECRET_KEY_RE.test(key) || FINANCIAL_OR_PII_KEY_RE.test(key)) continue;
      const value = safeScalar(event.tags[key]);
      if (value !== undefined) tags[key] = value;
    }
    event.tags = tags;
  }

  if (event.transaction) {
    event.transaction = scrubPathForSentry(event.transaction);
  }

  return event;
}

function initSentry() {
  if (enabled) return true;
  if (!cfg.SENTRY_DSN || cfg.SENTRY_ENABLED === 'false') return false;

  client = require('@sentry/node');
  client.init({
    dsn: cfg.SENTRY_DSN,
    environment: cfg.SENTRY_ENVIRONMENT,
    release: cfg.SENTRY_RELEASE || undefined,
    sendDefaultPii: false,
    tracesSampleRate: cfg.SENTRY_TRACES_SAMPLE_RATE,
    beforeSend: scrubEventForSentry,
  });
  enabled = true;
  return true;
}

function captureException(err, req, extra) {
  if (!enabled || !client) return;
  client.captureException(err, {
    tags: {
      method: req && req.method,
      route: req && scrubPathForSentry(req.path || req.url),
    },
    extra: safeExtra(extra),
  });
}

module.exports = {
  initSentry,
  captureException,
  scrubEventForSentry,
  scrubPathForSentry,
  safeExtra,
  scrubExceptionForSentry,
};

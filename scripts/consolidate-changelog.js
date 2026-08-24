#!/usr/bin/env node
'use strict';
// Consolidates pending WORKLOG/schema fragments into the canonical files. Run on `main`,
// after a merge, before the next one lands. See docs/worklog/pending/README.md and
// db/migrations/pending/README.md for the convention this implements.
//
// WHY THIS EXISTS: every WORKLOG entry and every schema migration used to be written
// directly into docs/WORKLOG.md / schema.sql, prepended/appended at one shared insertion
// point. Two PRs touching that same point around the same time conflict on merge, even when
// their actual code changes never overlap -- this hit every platform PR merged today, more
// than once as `main` moved. Writing new entries as separate, uniquely-named fragment files
// instead means two PRs can never collide there; this script is the one, occasional,
// single-actor step that folds them back into the canonical files.
//
// Deliberately NOT run automatically on every request/commit -- it is a merge-time
// housekeeping step run by whoever just merged, against a `main` nobody else is mid-edit on,
// so it never itself needs a conflict resolution.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKLOG_PENDING = path.join(ROOT, 'docs', 'worklog', 'pending');
const WORKLOG_FILE = path.join(ROOT, 'docs', 'WORKLOG.md');
const MIGRATIONS_PENDING = path.join(ROOT, 'db', 'migrations', 'pending');
const SCHEMA_FILE = path.join(ROOT, 'schema.sql');

// Fragments are named "<number>-<slug>.<ext>" or "<number>_<slug>.<ext>"; sort numerically
// by the leading number so consolidation order matches PR/issue order, not filesystem order.
function leadingNumber(filename) {
  const m = /^(\d+)[-_]/.exec(filename);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY; // unnumbered files sort last, never silently dropped
}

function listFragments(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(ext) && f.toLowerCase() !== 'readme.md')
    .sort((a, b) => leadingNumber(a) - leadingNumber(b) || a.localeCompare(b));
}

// detectEol(content) -> '\r\n' | '\n'. Every file this script touches in this repo is CRLF
// (Windows checkout) except fragment files a contributor may have saved with LF -- normalise
// fragment content to whatever the CANONICAL file already uses, never the other way round,
// so consolidation can never introduce mixed line endings (a real bug hit twice by hand
// during today's manual conflict resolutions, before this script existed).
function detectEol(content) {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function normaliseEol(content, eol) {
  return content.replace(/\r\n|\n/g, eol);
}

function consolidateWorklog() {
  const fragments = listFragments(WORKLOG_PENDING, '.md');
  if (fragments.length === 0) { console.log('WORKLOG: no pending fragments.'); return; }

  const canonical = fs.readFileSync(WORKLOG_FILE, 'utf8');
  const eol = detectEol(canonical);
  const header = '# WORKLOG — Receipt Analyser SaaS' + eol + eol;
  if (!canonical.startsWith(header)) {
    throw new Error('WORKLOG.md does not start with the expected header — refusing to guess where to insert; resolve by hand.');
  }
  const rest = canonical.slice(header.length);

  // Newest-first convention: fragments are numbered by PR/issue, and higher numbers were
  // opened later -- so insert in DESCENDING number order (highest/newest first) right after
  // the header, ahead of whatever was already there.
  const inserts = fragments.slice().reverse().map((f) => {
    const raw = fs.readFileSync(path.join(WORKLOG_PENDING, f), 'utf8').trim();
    return normaliseEol(raw, eol);
  });

  const out = header + inserts.join(eol + eol) + eol + eol + rest;
  fs.writeFileSync(WORKLOG_FILE, out);
  for (const f of fragments) fs.unlinkSync(path.join(WORKLOG_PENDING, f));
  console.log('WORKLOG: consolidated ' + fragments.length + ' fragment(s): ' + fragments.join(', '));
}

function consolidateSchema() {
  const fragments = listFragments(MIGRATIONS_PENDING, '.sql');
  if (fragments.length === 0) { console.log('SCHEMA: no pending fragments.'); return; }

  const canonical = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const eol = detectEol(canonical);

  // Ascending number order: migrations apply in the order they were authored, and schema.sql
  // is read top-to-bottom as one script, so later migrations must come after earlier ones.
  const appends = fragments.map((f) => {
    const raw = fs.readFileSync(path.join(MIGRATIONS_PENDING, f), 'utf8').trim();
    return normaliseEol(raw, eol);
  });

  const trimmedCanonical = canonical.replace(/\s+$/, '');
  const out = trimmedCanonical + eol + eol + appends.join(eol + eol) + eol;
  fs.writeFileSync(SCHEMA_FILE, out);
  for (const f of fragments) fs.unlinkSync(path.join(MIGRATIONS_PENDING, f));
  console.log('SCHEMA: consolidated ' + fragments.length + ' fragment(s): ' + fragments.join(', '));
}

function main() {
  consolidateWorklog();
  consolidateSchema();
  console.log('\nDone. Review the diff, run the test suite, then commit:');
  console.log('  git add docs/WORKLOG.md schema.sql docs/worklog/pending db/migrations/pending');
  console.log('  git commit -m "chore: consolidate pending changelog/migration fragments"');
}

if (require.main === module) main();

module.exports = { consolidateWorklog, consolidateSchema, leadingNumber };

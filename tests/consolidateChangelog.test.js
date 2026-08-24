'use strict';
// scripts/consolidate-changelog.js — the fix for today's recurring WORKLOG.md/schema.sql
// merge conflicts. Runs entirely against a throwaway temp directory that mimics the repo
// layout; never touches the real docs/WORKLOG.md or schema.sql. A script that fixes a
// merge-conflict problem had better not corrupt a file itself -- same "verify actual bytes,
// never trust the script's own report" discipline used on today's manual conflict
// resolutions, now automated instead of repeated by hand every time.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Loading the script as a module under a DIFFERENT __dirname than the real repo would break
// its ROOT-relative paths, so each test spins up a temp directory laid out exactly like the
// real repo, copies the script in, and requires it FROM THERE -- exercising the real
// path-resolution logic, not a mocked version of it.
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-test-'));
  fs.mkdirSync(path.join(root, 'docs', 'worklog', 'pending'), { recursive: true });
  fs.mkdirSync(path.join(root, 'db', 'migrations', 'pending'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, '..', 'scripts', 'consolidate-changelog.js'),
    path.join(root, 'scripts', 'consolidate-changelog.js')
  );
  return root;
}

// write(root, ...dirParts) -> (filename, content) => void. dirParts is the directory ONLY
// (e.g. 'docs', 'worklog', 'pending') -- the returned function's own first argument is the
// filename, so nothing here should be popped off dirParts as if it were one.
function write(root, ...dirParts) {
  const dir = path.join(root, ...dirParts);
  return (name, content) => fs.writeFileSync(path.join(dir, name), content);
}

function requireFresh(root) {
  const file = path.join(root, 'scripts', 'consolidate-changelog.js');
  delete require.cache[require.resolve(file)];
  return require(file);
}

test('leadingNumber: sorts by the leading number, unnumbered files sort last (never silently dropped)', () => {
  const root = makeRepo();
  const { leadingNumber } = requireFresh(root);
  assert.strictEqual(leadingNumber('048-p02a.md'), 48);
  assert.strictEqual(leadingNumber('007_x.sql'), 7);
  assert.strictEqual(leadingNumber('no-number.md'), Infinity);
});

test('WORKLOG: consolidates fragments newest-first and deletes them', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'docs', 'WORKLOG.md'),
    '# WORKLOG — Receipt Analyser SaaS\r\n\r\n## 2026-08-01 · old entry\r\n\r\n- pre-existing.\r\n');
  const wf = write(root, 'docs', 'worklog', 'pending');
  wf('046-p01.md', '## 2026-08-24 · P-01\r\n\r\n- issue #46 content.');
  wf('048-p02a.md', '## 2026-08-24 · P-02a\r\n\r\n- issue #48 content.');

  const { consolidateWorklog } = requireFresh(root);
  consolidateWorklog();

  const out = fs.readFileSync(path.join(root, 'docs', 'WORKLOG.md'), 'utf8');
  const idx48 = out.indexOf('#48 content');
  const idx46 = out.indexOf('#46 content');
  const idxOld = out.indexOf('pre-existing');
  assert.ok(idx48 > -1 && idx46 > -1 && idxOld > -1, 'all three sections must be present');
  assert.ok(idx48 < idx46, 'higher-numbered (newer) fragment must sort above the lower-numbered one');
  assert.ok(idx46 < idxOld, 'both new fragments must sit above the pre-existing entry, not replace it');

  const remaining = fs.readdirSync(path.join(root, 'docs', 'worklog', 'pending'));
  assert.deepStrictEqual(remaining, [], 'consolidated fragments must be deleted');
});

test('WORKLOG: a run with zero pending fragments is a safe no-op', () => {
  const root = makeRepo();
  const original = '# WORKLOG — Receipt Analyser SaaS\r\n\r\n## 2026-08-01 · old entry\r\n\r\n- pre-existing.\r\n';
  fs.writeFileSync(path.join(root, 'docs', 'WORKLOG.md'), original);
  const { consolidateWorklog } = requireFresh(root);
  consolidateWorklog();
  assert.strictEqual(fs.readFileSync(path.join(root, 'docs', 'WORKLOG.md'), 'utf8'), original,
    'the canonical file must be byte-identical when there was nothing to consolidate');
});

test('WORKLOG: README.md in the pending directory is never consolidated or deleted', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'docs', 'WORKLOG.md'), '# WORKLOG — Receipt Analyser SaaS\r\n\r\n');
  const wf = write(root, 'docs', 'worklog', 'pending');
  wf('README.md', 'convention doc, not a real entry');
  wf('046-p01.md', '## 2026-08-24 · P-01\r\n\r\n- content.');

  const { consolidateWorklog } = requireFresh(root);
  consolidateWorklog();

  const out = fs.readFileSync(path.join(root, 'docs', 'WORKLOG.md'), 'utf8');
  assert.ok(!out.includes('convention doc'), 'README content must never be folded into WORKLOG.md');
  const remaining = fs.readdirSync(path.join(root, 'docs', 'worklog', 'pending'));
  assert.deepStrictEqual(remaining, ['README.md'], 'README.md must survive; only real fragments are deleted');
});

test('SCHEMA: consolidates fragments in ascending (authorship) order, appended after existing content', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'schema.sql'), 'create table foo (id uuid primary key);\r\n');
  const mf = write(root, 'db', 'migrations', 'pending');
  mf('037-p04a.sql', 'create table rate_limits (bucket_key text);');
  mf('034-p01.sql', 'create table email_challenges (id uuid);');

  const { consolidateSchema } = requireFresh(root);
  consolidateSchema();

  const out = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
  const idxFoo = out.indexOf('create table foo');
  const idx34 = out.indexOf('email_challenges');
  const idx37 = out.indexOf('rate_limits');
  assert.ok(idxFoo < idx34, 'existing schema content must stay first');
  assert.ok(idx34 < idx37, 'lower-numbered (earlier) migration must be applied before the later one');

  const remaining = fs.readdirSync(path.join(root, 'db', 'migrations', 'pending'));
  assert.deepStrictEqual(remaining, [], 'consolidated migration fragments must be deleted');
});

test('SCHEMA: never drops or duplicates the pre-existing schema content', () => {
  const root = makeRepo();
  const existing = 'create table foo (id uuid);\r\ncreate table bar (id uuid);\r\n';
  fs.writeFileSync(path.join(root, 'schema.sql'), existing);
  write(root, 'db', 'migrations', 'pending')('001-new.sql', 'create table baz (id uuid);');

  const { consolidateSchema } = requireFresh(root);
  consolidateSchema();

  const out = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
  assert.strictEqual((out.match(/create table foo/g) || []).length, 1);
  assert.strictEqual((out.match(/create table bar/g) || []).length, 1);
  assert.ok(out.includes('create table baz'));
});

test('EOL: LF fragment content is normalised to the canonical file\'s CRLF, never mixed', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'docs', 'WORKLOG.md'), '# WORKLOG — Receipt Analyser SaaS\r\n\r\n');
  // Deliberately write the fragment with bare LF, simulating a contributor on a non-Windows
  // editor -- exactly the mismatch that corrupted a manual conflict resolution earlier today.
  fs.writeFileSync(path.join(root, 'docs', 'worklog', 'pending', '046-p01.md'),
    '## 2026-08-24 · P-01\n\n- line one.\n- line two.\n');

  const { consolidateWorklog } = requireFresh(root);
  consolidateWorklog();

  const out = fs.readFileSync(path.join(root, 'docs', 'WORKLOG.md'), 'utf8');
  const bareLf = (out.match(/(?<!\r)\n/g) || []).length;
  assert.strictEqual(bareLf, 0, 'no bare LF may survive consolidation into a CRLF canonical file');
});

test('a malformed WORKLOG.md header aborts loudly rather than guessing where to insert', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'docs', 'WORKLOG.md'), 'not the expected header at all\r\n');
  write(root, 'docs', 'worklog', 'pending')('046-p01.md', '## entry\r\n');

  const { consolidateWorklog } = requireFresh(root);
  assert.throws(() => consolidateWorklog(), /does not start with the expected header/);
  // And nothing was deleted, since it never got that far.
  const remaining = fs.readdirSync(path.join(root, 'docs', 'worklog', 'pending'));
  assert.deepStrictEqual(remaining, ['046-p01.md']);
});

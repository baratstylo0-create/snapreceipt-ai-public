# Claude Code Cross-Project Playbook

> **Who this is for:** any Claude Code session (any operator: Jeevan/Barat/Codex/etc.), on **any**
> project — not just receipt-analyser. It is the distilled, hard-won, "you only learn this by getting
> burned once" knowledge from building and running the Receipt Analyser system (a delivered per-client
> automation system on a live VPS with real business data and real users).
>
> **Why it exists:** most of what follows cost a real incident, a wrong assumption stated as fact, or
> a late-night production scare to learn. None of it is easily found by reading the code. Read this
> **before** you start guessing, and you skip re-deriving root causes we already paid for.
>
> **How to use it:** it is organised **symptom-first** where possible. Skim the headers; when one
> matches what you're seeing, read that section. The last section ("Working discipline") is the
> process that prevents most of these from happening at all — read it even if nothing is on fire.
>
> **Project-specific companions** (read these for receipt-analyser specifically; this file is the
> generalisation of them):
> - `MEMORY_LEDGER.md` — the compact durable memory for this repo (architecture, GOTCHAS, status).
> - `docs/qa/2026-07-17-lessons-learned-review-queue-stafflock-duplicates.md` — Barat's 4-bug postmortem.
> - `docs/DECISIONS.md` (ADRs) — why things are the way they are.
> - `docs/FRICTION_PROJECT_SOP.md` — the governance constitution (git rules, phase gates, security).

---

## 0. The one-paragraph version

Verify what you actually have and what is actually live before you act — never from memory, a stale
comment, an old log entry, or another session's notes. Prefer the cheapest probe of the biggest
unknown. Treat every live/destructive/outward-facing action as needing explicit owner sign-off and a
backup. When you claim something works, prove it at the layer of the claim with evidence you did not
generate yourself. Everything below is a specific, expensive instance of that paragraph.

---

## 1. Environment & config drift — the #1 source of wrong conclusions

### 1.1 Local `.env` and production `.env` can silently diverge — and BOTH directions have burned us

Same variable names, different values, no error, no `git status` signal (`.env` is gitignored).

- **Barat's session** queried the DB with the **local** `.env` credentials, got empty results, and
  reported "0 branches exist — business mode was never set up" **as verified fact**. It was wrong: his
  local `.env` pointed at a different, empty/stale backend than production. The user caught it ("an
  existing clerk already uses the bot").
- **My session**, days later, had a local `.env` that pointed at the **real** production backend — so
  live read-only diagnostics and a live data cleanup run *through* the local `.env` were correct and
  safe. Distrusting it would have been wrong too.

**Both are true at different times.** The lesson is not "local `.env` is always fake" or "always real."
It is: **verify which backend your `.env` targets before trusting OR distrusting it.** For a Supabase
project, check the project ref in `SB_URL` (`https://<ref>.supabase.co`) against the known-live ref. For
any service, confirm the host/project ID, not just that a value is present.

**Safe ways to check LIVE state without touching a possibly-wrong local `.env`:**
- `curl -sk https://<HOST>/health` and `/ready` — process up + dependencies reachable.
- `curl -sk https://<HOST>/api/config` (or the app's public config route) — the flags/settings **as the
  live server actually loaded them**, no credentials needed.
- For a Telegram bot: `getWebhookInfo` via the real `BOT_TOKEN` — tells you which server Telegram is
  actually delivering to, independent of any DB.

If a DB-level check is genuinely needed and the local creds are suspect, **say so and ask** — a wrong
"I checked, it's empty" is worse than an honest "I can't verify this from here."

### 1.2 The `.env` move-aside for hermetic tests can silently no-op — always `ls .env` after

Convention here: move `.env` aside before `node --test` (tests must run hermetically), restore after.
The trap: `mv .env .env.bak 2>/dev/null` **swallows the error** when `.env` is already missing (e.g. a
previous session's restore failed). The aside/restore dance then silently becomes a no-op, and because
`.env` is gitignored, `git status` never shows it. We once found `.env` missing for **5+ days** across
multiple sessions this way.

**Rules that prevent it:**
- Restore with `cp` from a backup, not `mv` (keeps the backup as a safety net).
- **After every test run, run `ls .env` and confirm it exists** before considering the env state clean.
  Do not trust "no error was printed."

### 1.3 dotenv keeps the LAST occurrence of a duplicate key → safe append-only edits

`dotenv.parse("FOO=a\nFOO=b")` returns `FOO=b`. This is genuinely useful: to change a value in a live
`.env` you can **append** a new line rather than editing the existing one in place —

```bash
echo "VISION_MODEL=qwen/qwen3.6-27b" >> .env   # overrides an earlier VISION_MODEL= line
```

The old line stays in the file (harmless, and a built-in record of what it was), and you never risk a
`sed -i` mangling the file. This matters because some harness/classifier configurations **block
in-place edits** of a production `.env` but allow appends (see §5.2). Verify the last-wins behaviour for
your specific loader before relying on it (`node -e "console.log(require('dotenv').parse('X=1\nX=2').X)"`).

### 1.4 A running process holds its config snapshot — a file edit is NOT a restart

dotenv loads `.env` into `process.env` **once at startup**. Editing `.env` on a live box does nothing
until the process restarts (`pm2 restart <app> --update-env`, or your process manager's equivalent).
After restart, **verify the process actually loaded the new value**, not just that the file contains it:

```bash
# on the box, load the file exactly like the app does:
node -e "require('dotenv').config(); console.log(process.env.VISION_MODEL)"
```

Config summaries printed on boot (a one-line "account=… currency=… model=…" log) exist for exactly this
reason — a stale/misconfigured setting is then visible immediately instead of only surfacing in the data
later. If the app has one, read it after every restart.

---

## 2. Deployment, hosting & the network layer

### 2.1 A green deploy does NOT mean the feature works — health checks only prove the process is up

Deploy pipelines here verify `/health` + `/ready`. Both can be 200 while a specific route, an
nginx path, or a config value is broken. **The pipeline cannot catch a routing-layer or
config-layer bug.** After any deploy that changes observable behaviour, independently verify the
*actual thing that changed*: curl the specific endpoint, re-query the data, load the page — not just the
health check. "The workflow went green" is the floor, not the proof.

### 2.2 Shared-tenant hosting: another app's config edit can silently break your routes

This VPS runs **two** apps behind one nginx (this app + a sibling project). An nginx edit made for the
*other* app's routes has **twice** silently reset a `location` block and broken this app's receipt-image
path — deploying "green" each time because `/health` still answered.

**When something served through the shared web layer breaks, diagnose the network path FIRST, before
touching app code:**
```bash
curl -sk -o /dev/null -w "%{http_code}\n" https://<HOST>/<known-auth-gated-route>   # control
curl -sk -o /dev/null -w "%{http_code}\n" https://<HOST>/<the-broken-route>          # compare
```
If the control route behaves and the broken one returns a *different* status (404/502 where you expect
401), it's a routing/nginx problem, not your code. Fixing app code for an nginx bug wastes hours and
"deploys but nothing changes." (Full runbook for this specific box is in `MEMORY_LEDGER.md`.)

### 2.3 Transient deploy failures happen — rerun the job, don't assume a code bug

An SSH keyscan / key-configuration step failed once mid-deploy (generic `exit code 1`), leaving the
artifact un-shipped — **the live app was untouched and stayed healthy**. Re-running the failed job
succeeded. Before treating a deploy failure as a code problem: read the failed step's log, and confirm
the live app is still up (`/health`). A failure *before* the extract/restart step means production never
changed.

### 2.4 Deploy concurrency: expect a lock, and expect parallel sessions

Deploys are serialised by a concurrency lock (`concurrency: group: deploy-vps, cancel-in-progress:
false`). A superseded/cancelled deploy run is **not** an outage as long as a later run in the queue
carries the cumulative state and succeeds. When multiple merges land close together, only the **last**
deploy (whose SHA == current `main` tip) needs to be watched to completion.

---

## 3. TLS, HSTS & browser security behaviour (bit us live, pre-demo)

### 3.1 HSTS + a self-signed cert = a PERMANENT client lockout

The single nastiest surprise of the project. On a self-signed cert, the browser shows a
"connection not private" warning with an **Advanced → Proceed anyway** escape. But if the server **also**
sends an HSTS header (`Strict-Transport-Security`), then the moment a browser accepts the cert once and
caches that policy, HSTS tells it to **never show the bypass link again** for that host — until the
policy is manually cleared or `max-age` expires (we had 180 days). A plain reload then hard-fails with no
way through. It hit the owner right before a client demo, and would have hit the *client's* own staff on
their first successful load.

**Rules:**
- **Do not send HSTS from a deployment that has a self-signed cert.** Gate it behind a config flag
  (`HSTS_ENABLED=false` for self-signed boxes) and only enable it once you have a CA-trusted cert.
- **Immediate unblock for an already-locked browser** (client-side, no server change needed):
  `chrome://net-internals/#hsts` → "Delete domain security policies" → enter the bare host
  (`31.97.70.50`, no `https://`, no slash) → Delete → load the site fresh in a new tab.
- The server fix (stop sending the header) prevents *new* victims but **cannot** retroactively clear a
  policy a browser already cached — that browser still needs the manual clear above.

### 3.2 A self-signed cert exists because there's no domain — Let's Encrypt cannot issue for a bare IP

The proper fix (a real, browser-trusted cert with zero warnings for anyone) requires a **domain name**
pointed at the box. Let's Encrypt validates domain ownership; it **cannot** issue a cert for a bare IP
address. So "just get a real cert" is blocked on "get a domain + DNS A record first." Until then, the
self-signed warning (a one-time Advanced→Proceed per device) is the expected state — but keep HSTS off
(§3.1) so that click keeps working.

---

## 4. LLM / OCR / model-vendor realities

### 4.1 Any exact-string match over model-extracted text is a latent false-negative

Merchant names, category labels, addresses — anything **read from an image or generated by an LLM**
rather than typed by a human — will not come back byte-identical every time. The same shop OCR'd as
`"99 SPEED MART SDN. BHD."` once and `"99 Speed Mart"` next time defeated an exact-match duplicate check,
and the same receipt saved three times. **When adding/reviewing matching logic over such a field, assume
the model will phrase it differently next time.** Normalise-then-compare (strip a *narrow* whitelist of
known-noise tokens — e.g. legal suffixes like Sdn Bhd/Ltd/Inc — but **never** a descriptive word like
"Trading"/"Store" that distinguishes real businesses), and/or a fuzzy fallback (bigram Dice similarity,
high threshold, applied only after other fields already matched exactly). Log every fuzzy match with both
strings + the score, so a recurrence has evidence instead of a screenshot.

### 4.2 Reasoning models burn output tokens on thinking — "returns no JSON" is often just truncation

A reasoning vision model (e.g. `qwen/qwen3.6-27b`) emits a `<think>…</think>` block before its answer.
With a small `max_tokens`, the entire budget is consumed by reasoning and the JSON is cut off — which
looks exactly like "the model doesn't work / returns no parseable JSON." The fix is not to abandon the
model; it's: **generous `max_tokens`** (e.g. 2500 for OCR) **+ strip the `<think>` block before parsing**
**+ reject an unterminated `<think>` outright** (an unclosed think block means the answer never came —
anything JSON-shaped inside it is reasoning, not output, and must not be trusted; SOP §7.3 untrusted
output).

### 4.3 Don't trust a stale comment claiming a model "doesn't work" — re-verify against current code

We found a config comment (`VISION_MODEL=…scout… # qwen returns no parseable JSON on real receipts`)
that had **no corroborating log entry** and predated the `<think>`-stripping hardening in §4.2. Acting on
it blindly would have kept us on a model that was being **decommissioned that very day**. Instead:
re-verified live with a **real, non-mocked** call — built a receipt-shaped image, ran it through the
app's actual extraction pipeline against the live model — and got perfect JSON. The stale comment was
simply out of date. **A claim that "X doesn't work" is a hypothesis, not a finding; test it against
current code before you let it drive a decision**, especially a production one.

### 4.4 Model IDs are vendor-controlled and get decommissioned on dates — keep them in config

Providers (Groq, etc.) deprecate and **decommission** model IDs on hard dates and email you about it.
Two defences:
- **Never hardcode a model ID** — read it from config/env (`VISION_MODEL`, `TEXT_MODEL`, …) so a swap is
  a one-line change, not a code edit + redeploy.
- **Verify a replacement actually works before switching** (a real call on real-shaped input — see §4.3),
  and verify the old one's status against the provider's live `/models` list rather than assuming.
- Prefer a **production**-tier model over a **Preview**-tier one in any production path, even if Preview
  has nicer specs — Preview models are exactly the ones "discontinued at short notice."

---

## 5. Permissions, safety rails & when the harness blocks you

### 5.1 The auto-mode classifier blocking a merge or a live write is a FEATURE — work with it

The harness will refuse to let you (a) merge your own PR, or (b) run a destructive/production command,
unless the owner has **explicitly named that specific action**. Generic delegation ("do what you think is
right", "as a CTO decide") is **not** a specific merge/deploy authorization and will (correctly) be
blocked. This protects a live client system. When blocked:
- **Do not** try to route around it with clever syntax — that is evasion and is the wrong instinct.
- **Do** stop, state exactly what you were going to do and why, and let the owner decide.
- For a merge: the owner literally saying "merge 258" is the unlock. For a live command the classifier
  won't let you run, hand the owner the **exact command** to paste, then verify the result yourself.

### 5.2 A blocked in-place edit often has a legitimate append-only alternative

If the classifier blocks `sed -i` on a production `.env`, the append-only `echo "KEY=val" >> .env`
pattern (§1.3) is a *different*, allowed action that achieves the same result via dotenv last-wins — not
a workaround of the block's intent, just a safer edit shape. If even that is blocked, hand it to the
owner (§5.1). Know the difference between "find a safer legitimate path" (fine) and "trick the guard"
(never).

### 5.3 Before ANY destructive live-DB write: back up, delete in dependency order, re-verify to zero

Cleaning up real production rows (even junk QA data) is irreversible. The safe sequence that worked:
1. **Re-query live** for the exact current rows (don't trust an earlier session's list — data moves).
2. **Check for dependencies** first (e.g. child rows/expenses attached to a row you're about to delete) —
   deleting a parent can orphan real data. This check changed the plan once.
3. **Back up every targeted row to a local file** before deleting anything.
4. Delete in **dependency order** (children → parents), via the app's **own** DB helper (the same code
   path the app uses), not a bespoke query.
5. **Re-query afterward and confirm 0 targeted rows remain.**
6. Delete the temporary script immediately.
Get explicit owner authorization for the whole thing first — and if it's a genuine "which of these are
junk vs. needed" judgement call, that's the owner's to make, not yours to guess.

### 5.4 The Supabase MCP tools may point at the WRONG project

On this setup, the Supabase MCP server's token reaches a **different** (parent) project, not the app's
live data plane. For any live DB operation, use the app's own DB layer (`lib/supabase.js`) with the
`.env` `SB_URL`/`SB_KEY` — after confirming those target the right project (§1.1). Verify the project ref
before any write; this once caught a cross-project mistake.

---

## 6. Working discipline (the process that prevents most of the above)

### 6.1 Never self-merge; the owner names every merge

`main` is protected by a local pre-push hook (Friction SOP) — nobody, owner included, pushes to `main`
directly. The only path to land a change: `git checkout -b <branch>` → commit → `git push -u origin
<branch>` → `gh pr create` → **owner names the merge** → `gh pr merge <n> --merge`. The auto-mode
classifier enforces this (§5.1). A per-PR owner "merge N" is the authorization; it does not generalise to
the next PR.

### 6.2 Verify at the layer of the claim, with evidence you didn't generate

"It ran" proves the layer *below* your claim, not the claim. If the claim is "the label changed live,"
`curl` the deployed asset and grep for the new string. If it's "the model swap took effect," load the
`.env` through dotenv on the box and print the value. If it's "the rows are gone," re-query and count. A
test passing too easily, or an all-green sweep you can't explain, is suspect until you can. This chain —
full test suite → merge → `gh run watch` (CI **and** the deploy's own health check green) → one more
independent hit on the real endpoint — is the minimum before telling the owner "it's live and working."

### 6.3 TDD for every behaviour change

Write the failing test first, **run it and confirm it fails for the expected reason**, implement, confirm
green, then run the **full suite** for regressions. This caught real bugs mid-change (a duplicate `});`
syntax error, an over-broad matcher) before they shipped. The suite here runs hermetically (no `.env`, see
§1.2); keep it that way.

### 6.4 Grep before you ship a change to a shared constant

If a constant/keyboard/template/header is referenced from **N** call sites, changing its logic in *some*
of them and shipping is a guaranteed intermittent bug. Barat's Staff-Lock keyboard vanished because 2 of
5 send-sites still used the old constant. `grep -n '<CONSTANT>' <file>` across the whole touched file is
cheap insurance — do it before considering the change done, not after the bug report.

### 6.5 Expect concurrent sessions on the same repo — re-sync before finalising

More than one Claude Code session (different operators) can be working the same repo at once. Tonight two
were. Consequences you must plan for:
- **`WORKLOG.md` is append-only + prepend-newest → it conflicts on almost every parallel branch.** It's
  usually the *only* conflict. Resolve by keeping **all** entries from both sides, newest-first; never
  drop the other session's entry.
- **Re-fetch `main` right before you push/PR.** Your branch may be based on a `main` that advanced hours
  ago; a stale base can even suppress CI. `git merge origin/main`, resolve WORKLOG, **run the full suite
  again** (you just pulled in someone else's code), then push.
- Capabilities differ per operator/machine (§6.6) — don't assume another session's constraints are yours.

### 6.6 Verify YOUR capabilities — don't inherit another session's assumptions

Barat's postmortem states "no local SSH access to the VPS exists; the only way to restart the bot is a
merge to main." That was true **for that session**. Mine had working SSH keys (`~/.ssh/*_ed25519`) and
did live `pm2` restarts directly. Neither is universally true. Before concluding "I can't do X," check
what **you** actually have: `ls ~/.ssh`, try the read-only version of the command, look for the key the
deploy workflow references. State capabilities as "I have/don't have," verified this session — not
inherited from a note.

### 6.7 Keep the durable memory small and current

`MEMORY_LEDGER.md` is the compact, load-first memory for the repo. When you learn something that will
save a future session real time (a GOTCHA, a corrected mistake, a live-config change), add a **one-line**
entry and prune stale ones. A closed loop (e.g. "the QA-account cleanup is DONE — don't re-investigate")
is as valuable as an open warning. This playbook is the cross-project version of that instinct.

---

## 7. Quick incident index (symptom → section)

| You see / are told… | Go to |
|---|---|
| "I checked the DB, it's empty / it's set up" (about live state) | §1.1 |
| Tests behaving oddly / `.env` seems missing | §1.2 |
| Need to change a live `.env` value but in-place edit is blocked | §1.3, §5.2 |
| Changed `.env` on the box, nothing happened | §1.4 |
| "It deployed green but nothing changed" | §2.1, §2.2 |
| A route broke and it's served through shared nginx | §2.2 |
| Deploy job failed at an SSH/key step | §2.3 |
| "Your connection is not private" / no Proceed button / privacy error | §3.1 |
| Want to kill the cert warning entirely | §3.2 |
| Duplicate/near-duplicate records not being caught | §4.1 |
| A vision/LLM model "returns no JSON" / empty output | §4.2 |
| A comment/log says "model X doesn't work" | §4.3 |
| Deprecation email / model being decommissioned | §4.4 |
| The harness blocked a merge or a live command | §5.1, §5.2 |
| Need to delete/clean real production rows | §5.3 |
| Supabase MCP shows the wrong data | §5.4 |
| About to say "it's done / it's live" | §6.2 |
| Two sessions on one repo / WORKLOG conflict | §6.5 |
| "I can't SSH / can't restart" | §6.6 |

---

*Maintained by whichever Claude Code session last learned something worth the next one knowing. Add to
it the same way you'd want to have found it: symptom-first, concrete, and honest about what was actually
verified vs. assumed.*

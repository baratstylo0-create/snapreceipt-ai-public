# Docker isolation plan — shared VPS (31.97.70.50)

> Status: PROPOSED, not executed. Review before I touch the live box.

## Why
The VPS currently runs 4 pm2 processes as root, side by side, no isolation:
`receipt-analyser` (Jeevan) and `frictionai` + `quote-server` + `health-monitor`
(Barat). pm2 already isolates *process crashes* (one Node process dying doesn't
kill another), but there's no isolation on: filesystem access, dependency
versions, resource limits, or a bad `rm -rf`/`apt` command run in the wrong
directory. A container boundary fixes all of that, and is also the honest fix
for "tell Barat's Claude not to touch it" — a written README is a request, a
container a different agent literally cannot write into is a boundary.

## Target shape
- Docker + Docker Compose installed on the host (fresh install, ~15 min, no
  reboot required).
- One container per project: `receipt-analyser`, `frictionai` (its own
  internal 3 processes can stay as pm2-inside-the-container, or split further
  later — not required for this pass).
- Each container: its own `node_modules`/deps, a memory limit
  (`mem_limit`, e.g. 512m each — current usage is ~80-90MB per process, so
  generous headroom), `restart: unless-stopped`.
- nginx **stays on the host** (not containerized) as the reverse proxy —
  it already terminates TLS and knows both domains/paths; it just proxies to
  `localhost:<container-port>` instead of `localhost:3005` directly. Lowest
  blast-radius option: nginx config doesn't change shape, only the upstream
  port per app.
- `.env` files stay outside the image (bind-mounted or `env_file:`), same as
  today — never baked into the container.

## Migration order (one project at a time, never both same day)
1. **Dry run on receipt-analyser only**, since I already have a clean
   deploy/rollback pattern for it (git worktree → tar → extract, pm2 restart).
   Build the image, run it alongside the existing pm2 process on a spare port,
   smoke-test `/health` + `/ready` + a real login, THEN flip nginx's upstream
   and stop the old pm2 process. Old pm2 process stays stopped-not-deleted for
   24h as an instant rollback.
2. Only after that's stable for a few days, propose the same for
   `frictionai`/`quote-server`/`health-monitor` — **with Barat's sign-off**,
   since it's his project and his call whether/when.

## Rollback
At every step there's a non-containerized fallback still on disk
(`pm2 start` the old way) until the new container has been stable for 24h+.
Never delete the old path same-day as the cutover.

## Open questions for Owner before I execute step 1
- OK to install Docker on this shared box (affects nothing running today,
  but it's a new system-level package)?
- OK with the nginx-stays-on-host approach vs. fully containerizing nginx too
  (more isolation, more moving parts, bigger blast radius — not recommended
  for a first pass)?

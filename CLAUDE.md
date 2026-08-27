# SnapReceipt AI — Project Rules

## Backend delegation

This session is **frontend-only**. Any task involving backend code (routes/,
lib/, server.js, database migrations, .env, pm2, Node server logic,
API endpoint changes, Google Auth routes, Telegram bot logic) must NOT be
done here. Instead, write a complete task prompt and tell the user to paste
it into the **snaprcpt backend** session (visible in their Recents sidebar).

The backend session cannot be reached via cross-session messaging (separate
containers), so the user must open it and paste the prompt manually.

## Push target

Even though this session's working directory is the public mirror,
all real commits/branches/PRs go to
**https://github.com/baratstylo0-create/snapreceipt-ai** — that is the
primary repo. This public repo is a mirror only; do not treat pushes here
as the final destination unless the user explicitly asks for the public
mirror specifically.

## VPS / deploy facts (for writing backend-session prompts)

- Live site: https://snapreceiptai.friction.com.my/
- VPS: 31.97.70.50 (Hostinger), SSH key: ~/.ssh/snapreceipt_vps
- App directory on server: /home/deploy/receipt-analyser-saas
- App runs as the `deploy` user under PM2 (process name: `snapreceipt-ai`)
- Deploy flow: merge PR to main -> ssh in -> `su - deploy` -> `cd
  ~/receipt-analyser-saas` -> `git pull origin main` -> `pm2 restart
  snapreceipt-ai --update-env`
- Never run pm2 as root; never touch `.env` on the server unless the user
  explicitly says to.

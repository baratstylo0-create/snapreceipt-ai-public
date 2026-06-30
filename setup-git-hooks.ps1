# ============================================================================
# Friction SOP §4.5 — run this ONCE after cloning the repo.
# Activates the local git hooks (core.hooksPath) so direct pushes to
# main/develop are blocked on YOUR machine. This is a *local* setting and
# cannot be committed for you — every teammate must run it once.
# ============================================================================
git config core.hooksPath .githooks

# Make the hook executable (matters on macOS/Linux; harmless on Windows).
if (Get-Command git -ErrorAction SilentlyContinue) {
    try { git update-index --chmod=+x .githooks/pre-push 2>$null } catch {}
}

Write-Host ""
Write-Host "[OK] core.hooksPath -> .githooks" -ForegroundColor Green
Write-Host "Direct pushes to 'main' and 'develop' are now blocked locally." -ForegroundColor Green
Write-Host "Push feature branches and open PRs instead. (Override: git push --no-verify, then log in docs/WORKLOG.md)"
Write-Host ""

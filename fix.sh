#!/bin/bash
# SnapReceipt AI — Full frontend sync: replace ALL frontend files with latest from repo
set -e
APP=/opt/snapreceipt-ai/public
BASE=https://raw.githubusercontent.com/baratstylo0-create/snapreceipt-ai-public/deploy-script

echo "=== SnapReceipt AI — Full Frontend Sync ==="
echo ""

# Core JS files
echo "[1/4] Syncing core JS files..."
for f in app.js api.js authgate.js escape.js exportGuards.js format.js render.js i18n.js legal-theme.js native-security.js; do
  curl -sL "$BASE/public/js/$f" -o "$APP/js/$f"
  echo "  $f OK"
done

# JS Components (ALL of them)
echo "[2/4] Syncing all JS components..."
for f in accountPanel.js activity.js agent.js emailverify.js falc.js grid.js landing.js legal.js login.js manage.js nav.js onboarding.js overview.js payments.js ratemeter.js reports.js resetpassword.js settings.js team.js templates.js tour.js upload.js; do
  curl -sL "$BASE/public/js/components/$f" -o "$APP/js/components/$f"
  echo "  $f OK"
done

# CSS files
echo "[3/4] Syncing CSS files..."
for f in app.css landing.css onboarding.css tour.css; do
  curl -sL "$BASE/public/css/$f" -o "$APP/css/$f"
  echo "  $f OK"
done

# index.html
curl -sL "$BASE/public/index.html" -o "$APP/index.html"
echo "  index.html OK"

# Syntax check critical files
echo ""
echo "[4/4] Syntax verification..."
node -c "$APP/js/app.js" 2>&1 && echo "  app.js OK" || echo "  app.js FAIL"
node -c "$APP/js/components/nav.js" 2>&1 && echo "  nav.js OK" || echo "  nav.js FAIL"
node -c "$APP/js/components/settings.js" 2>&1 && echo "  settings.js OK" || echo "  settings.js FAIL"

echo ""
echo "Restarting pm2..."
pm2 restart snapreceipt-ai --update-env
echo ""
echo "=== Full sync complete! Hard-refresh (Ctrl+Shift+R) the site. ==="

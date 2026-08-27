#!/bin/bash
# SnapReceipt AI — Full frontend sync: replace ALL frontend files with latest from repo
APP=/opt/snapreceipt-ai/public
BASE=https://raw.githubusercontent.com/baratstylo0-create/snapreceipt-ai-public/deploy-script
FAIL=0

echo "=== SnapReceipt AI — Full Frontend Sync ==="
echo ""

# Core JS files
echo "[1/4] Syncing core JS files..."
for f in app.js api.js authgate.js escape.js exportGuards.js format.js render.js i18n.js legal-theme.js native-security.js; do
  if curl -sfL "$BASE/public/js/$f" -o "$APP/js/$f" 2>/dev/null; then
    echo "  $f OK"
  else
    echo "  $f FAILED (curl error or file missing)"
    FAIL=$((FAIL+1))
  fi
done

# JS Components (ALL of them)
echo "[2/4] Syncing all JS components..."
for f in accountPanel.js activity.js agent.js emailverify.js falc.js grid.js landing.js legal.js login.js manage.js nav.js onboarding.js overview.js payments.js ratemeter.js reports.js resetpassword.js settings.js team.js templates.js tour.js upload.js; do
  if curl -sfL "$BASE/public/js/components/$f" -o "$APP/js/components/$f" 2>/dev/null; then
    echo "  $f OK"
  else
    echo "  $f FAILED"
    FAIL=$((FAIL+1))
  fi
done

# CSS files
echo "[3/4] Syncing CSS files..."
for f in app.css landing.css onboarding.css tour.css; do
  if curl -sfL "$BASE/public/css/$f" -o "$APP/css/$f" 2>/dev/null; then
    echo "  $f OK"
  else
    echo "  $f FAILED"
    FAIL=$((FAIL+1))
  fi
done

# index.html
if curl -sfL "$BASE/public/index.html" -o "$APP/index.html" 2>/dev/null; then
  echo "  index.html OK"
else
  echo "  index.html FAILED"
  FAIL=$((FAIL+1))
fi

# Syntax check critical files
echo ""
echo "[4/4] Syntax verification..."
node -c "$APP/js/app.js" 2>&1 && echo "  app.js syntax OK" || echo "  app.js syntax FAIL"
node -c "$APP/js/components/nav.js" 2>&1 && echo "  nav.js syntax OK" || echo "  nav.js syntax FAIL"

echo ""
if [ "$FAIL" -gt 0 ]; then
  echo "WARNING: $FAIL file(s) failed to download."
else
  echo "All files synced successfully."
fi

echo ""
echo "Restarting pm2..."
pm2 restart snapreceipt-ai --update-env
echo ""
echo "=== Done! Hard-refresh (Ctrl+Shift+R) the site. ==="

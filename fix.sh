#!/bin/bash
# SnapReceipt AI — Emergency fix: replace corrupted files with correct versions
set -e
APP=/opt/snapreceipt-ai/public
BASE=https://raw.githubusercontent.com/baratstylo0-create/snapreceipt-ai-public/deploy-script

echo "=== SnapReceipt AI — Emergency Fix ==="
echo ""

echo "[1/5] Replacing app.js (was corrupted at line 868)..."
curl -sL "$BASE/public/js/app.js" -o "$APP/js/app.js"
node -c "$APP/js/app.js" 2>&1 && echo "  OK — syntax valid" || { echo "  FAIL"; exit 1; }

echo "[2/5] Replacing accountPanel.js..."
curl -sL "$BASE/public/js/components/accountPanel.js" -o "$APP/js/components/accountPanel.js"
node -c "$APP/js/components/accountPanel.js" 2>&1 && echo "  OK" || echo "  WARN"

echo "[3/5] Replacing settings.js..."
curl -sL "$BASE/public/js/components/settings.js" -o "$APP/js/components/settings.js"
node -c "$APP/js/components/settings.js" 2>&1 && echo "  OK" || echo "  WARN"

echo "[4/5] Replacing index.html..."
curl -sL "$BASE/public/index.html" -o "$APP/index.html"
echo "  OK"

echo "[5/5] Replacing app.css..."
curl -sL "$BASE/public/css/app.css" -o "$APP/css/app.css"
echo "  OK"

echo ""
echo "Restarting pm2..."
pm2 restart snapreceipt-ai --update-env
echo ""
echo "=== Fix complete! Hard-refresh (Ctrl+Shift+R) the site. ==="

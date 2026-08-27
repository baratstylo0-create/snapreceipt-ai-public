#!/bin/bash
# Patch the 3 files that failed in the previous sync attempt
APP=/opt/snapreceipt-ai/public
BASE=https://raw.githubusercontent.com/baratstylo0-create/snapreceipt-ai-public/deploy-script

echo "=== Patching remaining files ==="
for i in 1 2 3; do
  ok=1
  curl -sfL "$BASE/public/js/legal-theme.js" -o "$APP/js/legal-theme.js" || ok=0
  curl -sfL "$BASE/public/js/components/emailverify.js" -o "$APP/js/components/emailverify.js" || ok=0
  curl -sfL "$BASE/public/js/components/legal.js" -o "$APP/js/components/legal.js" || ok=0
  if [ "$ok" -eq 1 ]; then break; fi
  echo "  retrying ($i)..."
  sleep 2
done

echo "legal-theme.js: $(wc -c < $APP/js/legal-theme.js) bytes"
echo "emailverify.js: $(wc -c < $APP/js/components/emailverify.js) bytes"
echo "legal.js: $(wc -c < $APP/js/components/legal.js) bytes"

node -c "$APP/js/legal-theme.js" && echo "legal-theme.js syntax OK" || echo "legal-theme.js syntax FAIL"
node -c "$APP/js/components/emailverify.js" && echo "emailverify.js syntax OK" || echo "emailverify.js syntax FAIL"
node -c "$APP/js/components/legal.js" && echo "legal.js syntax OK" || echo "legal.js syntax FAIL"

echo ""
echo "Restarting pm2..."
pm2 restart snapreceipt-ai --update-env
echo "=== Done ==="

#!/bin/bash
# Pinned-commit fix for emailverify.js (branch-name raw URL was serving a stale CDN copy)
APP=/opt/snapreceipt-ai/public
SHA=db6221e481795136f962bd986ac473a0da29da40

echo "=== Fixing emailverify.js (pinned to commit $SHA) ==="
curl -sL "https://raw.githubusercontent.com/baratstylo0-create/snapreceipt-ai-public/$SHA/public/js/components/emailverify.js" -o "$APP/js/components/emailverify.js"

echo "Size: $(wc -c < $APP/js/components/emailverify.js) bytes (expected 8976)"
node -c "$APP/js/components/emailverify.js" && echo "Syntax OK" || echo "Syntax FAIL"

echo ""
echo "Restarting pm2..."
pm2 restart snapreceipt-ai --update-env
echo "=== Done ==="

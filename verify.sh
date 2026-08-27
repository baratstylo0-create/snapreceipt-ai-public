#!/bin/bash
# Verify every frontend file on the VPS matches expected size + has valid syntax
APP=/opt/snapreceipt-ai/public

echo "=== Verifying all frontend files ==="
echo ""

declare -A EXPECTED=(
  ["js/api.js"]=8757
  ["js/app.js"]=84404
  ["js/authgate.js"]=2670
  ["js/components/accountPanel.js"]=13467
  ["js/components/activity.js"]=106128
  ["js/components/agent.js"]=22323
  ["js/components/emailverify.js"]=8976
  ["js/components/falc.js"]=8078
  ["js/components/grid.js"]=38467
  ["js/components/landing.js"]=12895
  ["js/components/legal.js"]=21874
  ["js/components/login.js"]=12025
  ["js/components/manage.js"]=9018
  ["js/components/nav.js"]=16650
  ["js/components/onboarding.js"]=22687
  ["js/components/overview.js"]=59995
  ["js/components/payments.js"]=25603
  ["js/components/ratemeter.js"]=4100
  ["js/components/reports.js"]=40112
  ["js/components/resetpassword.js"]=10332
  ["js/components/settings.js"]=31962
  ["js/components/team.js"]=32802
  ["js/components/templates.js"]=44844
  ["js/components/tour.js"]=20775
  ["js/components/upload.js"]=42394
  ["js/escape.js"]=2466
  ["js/exportGuards.js"]=10291
  ["js/format.js"]=2067
  ["js/i18n.js"]=72963
  ["js/legal-theme.js"]=1119
  ["js/native-security.js"]=1480
  ["js/render.js"]=5023
)

MISMATCH=0
for path in "${!EXPECTED[@]}"; do
  full="$APP/$path"
  exp="${EXPECTED[$path]}"
  if [ ! -f "$full" ]; then
    echo "MISSING: $path"
    MISMATCH=$((MISMATCH+1))
    continue
  fi
  actual=$(wc -c < "$full" | tr -d ' ')
  if [ "$actual" != "$exp" ]; then
    echo "SIZE MISMATCH: $path (expected $exp, got $actual)"
    MISMATCH=$((MISMATCH+1))
  fi
  syntaxerr=$(node -c "$full" 2>&1)
  if [ -n "$syntaxerr" ]; then
    echo "SYNTAX ERROR: $path"
    echo "$syntaxerr" | head -5
    MISMATCH=$((MISMATCH+1))
  fi
done

echo ""
if [ "$MISMATCH" -eq 0 ]; then
  echo "ALL FILES OK — sizes match and syntax is valid."
else
  echo "$MISMATCH issue(s) found above."
fi

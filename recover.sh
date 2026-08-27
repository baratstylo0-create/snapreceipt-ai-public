#!/bin/bash
set -e
APP=/opt/snapreceipt-ai/public

echo "=== SnapReceipt AI — Recovery Script ==="
echo ""

# Step 0: Check pm2 status
echo "[0] PM2 status:"
pm2 describe snapreceipt-ai 2>/dev/null | head -5 || echo "  pm2 process not found"
echo ""

# Step 1: Syntax check all JS files
echo "[1] Syntax-checking critical JS files..."
BROKEN=""
for f in "$APP/js/app.js" "$APP/js/components/accountPanel.js" "$APP/js/components/settings.js"; do
  echo -n "  $f: "
  if node -c "$f" 2>&1; then
    echo ""
  else
    BROKEN="$BROKEN $f"
  fi
done
echo ""

if [ -z "$BROKEN" ]; then
  echo "  All JS files pass syntax check."
  echo ""
  echo "[2] Checking for other issues..."
  echo "  index.html script tags for accountPanel:"
  grep -c "accountPanel" "$APP/index.html" 2>/dev/null || echo "  0"
  echo "  app.js AccountPanel references:"
  grep -c "AccountPanel" "$APP/js/app.js" 2>/dev/null || echo "  0"
  echo ""
  echo "  No syntax errors found. The issue may be a browser cache problem."
  echo "  Try: Ctrl+Shift+R (hard refresh), or open in incognito/private window."
  echo ""
  echo "  Or check the browser console (F12 > Console) for errors."
  echo ""
  echo "  Restarting pm2 just in case..."
  pm2 restart snapreceipt-ai --update-env 2>/dev/null || echo "  pm2 restart failed"
  echo ""
  echo "=== Done ==="
  exit 0
fi

echo "  BROKEN FILES:$BROKEN"
echo ""

# Step 2: Backup broken files
echo "[2] Creating backups..."
for f in $BROKEN; do
  cp "$f" "${f}.broken.bak" 2>/dev/null && echo "  Backed up: $f" || true
done
echo ""

# Step 3: Fix app.js if broken
if echo "$BROKEN" | grep -q "app.js"; then
  echo "[3] Fixing app.js..."
  node << 'FIXEOF'
var fs = require("fs");
var f = "/opt/snapreceipt-ai/public/js/app.js";
var s = fs.readFileSync(f, "utf8");
var original = s;

// Strategy: remove ALL injected AccountPanel code, then re-add it correctly.

// Remove dep() line(s) — may have been inserted multiple times
s = s.replace(/\s*if \(name === 'AccountPanel'\) return require\('\.\//g, '');
// More targeted removal
var lines = s.split('\n');
var cleaned = [];
for (var i = 0; i < lines.length; i++) {
  if (lines[i].indexOf("AccountPanel") !== -1 && lines[i].indexOf("require") !== -1) continue;
  if (lines[i].indexOf("AccountPanel") !== -1 && lines[i].indexOf("dep(") !== -1) continue;
  if (lines[i].indexOf("acctChip") !== -1) continue;
  if (lines[i].indexOf("var AccountPanel") !== -1) continue;
  cleaned.push(lines[i]);
}
s = cleaned.join('\n');

// Remove dangling else-if blocks
s = s.replace(/\} else if \(rateMeterHost && deps\.config && deps\.config\.personal_auth[\s\S]*?\n\s*\}/g, '}');

// Check syntax after stripping
var syntaxOK = false;
try { new Function(s); syntaxOK = true; } catch(e) {
  console.log("  After stripping: still has error: " + e.message);
}

if (!syntaxOK) {
  console.log("  Trying line-by-line brace fix...");
  var opens = (s.match(/\{/g) || []).length;
  var closes = (s.match(/\}/g) || []).length;
  console.log("  Braces: " + opens + " open, " + closes + " close");
}

if (syntaxOK) {
  // Now re-apply the patch correctly
  if (s.indexOf("AccountPanel") === -1) {
    // A) Add dep() line
    s = s.replace(
      /([ \t]*\} catch \(e\) \{ return null; \})/,
      "        if (name === 'AccountPanel') return require('./components/accountPanel');\n$1"
    );

    // B) Add the personal-mode chip branch
    var marker = "rateMeterHost.appendChild(out);";
    var idx = s.lastIndexOf(marker);
    if (idx !== -1) {
      var afterLine = s.indexOf("\n", idx);
      if (afterLine !== -1) {
        var rest = s.slice(afterLine);
        var braceMatch = rest.match(/^(\s*)\}/);
        if (braceMatch) {
          var bracePos = afterLine + braceMatch.index + braceMatch[0].length;
          var replacement = " else if (rateMeterHost && deps.config && deps.config.personal_auth\n"
            + "               && deps.config.account_info && dep('AccountPanel')) {\n"
            + "      var AccountPanel = dep('AccountPanel');\n"
            + "      var acctChip = AccountPanel.buildChip(deps);\n"
            + "      if (acctChip) rateMeterHost.appendChild(acctChip);\n"
            + "    }";
          s = s.slice(0, bracePos) + replacement + s.slice(bracePos);
        }
      }
    }

    // Final syntax check
    try {
      new Function(s);
      console.log("  Re-patched app.js — syntax OK!");
    } catch(e) {
      console.log("  Re-patch failed: " + e.message);
      console.log("  Using stripped (no AccountPanel) version instead.");
      s = original;
      // Just strip all AccountPanel lines
      var lines2 = s.split('\n');
      var cleaned2 = [];
      for (var j = 0; j < lines2.length; j++) {
        if (lines2[j].indexOf("AccountPanel") !== -1) continue;
        if (lines2[j].indexOf("acctChip") !== -1) continue;
        cleaned2.push(lines2[j]);
      }
      s = cleaned2.join('\n');
    }
  } else {
    console.log("  AccountPanel code already present and syntax OK — leaving as-is.");
  }

  fs.writeFileSync(f, s);
  console.log("  app.js saved.");
} else {
  console.log("  CRITICAL: Could not fix app.js automatically.");
  console.log("  Manual fix needed.");
  process.exit(1);
}
FIXEOF
  echo ""
fi

# Step 4: Fix accountPanel.js — always rewrite with the correct version
echo "[4] Rewriting accountPanel.js with correct version..."
rm -f "$APP/js/components/accountPanel.js"
curl -sL "https://raw.githubusercontent.com/baratstylo0-create/snapreceipt-ai-public/deploy-script/public/js/components/accountPanel.js" -o "$APP/js/components/accountPanel.js"
if [ -f "$APP/js/components/accountPanel.js" ] && [ -s "$APP/js/components/accountPanel.js" ]; then
  echo "  Downloaded and verified."
else
  echo "  ERROR: Could not download accountPanel.js."
fi
echo ""

# Step 5: Verify index.html has the script tag (exactly once)
echo "[5] Checking index.html..."
PANEL_COUNT=$(grep -c "accountPanel" "$APP/index.html" 2>/dev/null || echo "0")
echo "  accountPanel.js script tags found: $PANEL_COUNT"
if [ "$PANEL_COUNT" -gt "1" ]; then
  echo "  Removing duplicates..."
  node << 'HTMLEOF'
var fs = require("fs");
var f = "/opt/snapreceipt-ai/public/index.html";
var s = fs.readFileSync(f, "utf8");
s = s.replace(/\s*<script src="js\/components\/accountPanel\.js[^"]*"><\/script>\n?/g, '\n');
s = s.replace(
  /(\s*<script src="js\/app\.js)/,
  '\n  <script src="js/components/accountPanel.js?v=recovery"></script>$1'
);
fs.writeFileSync(f, s);
console.log("  Fixed: exactly one accountPanel.js script tag.");
HTMLEOF
elif [ "$PANEL_COUNT" -eq "0" ]; then
  echo "  Adding accountPanel.js script tag..."
  node << 'HTMLEOF'
var fs = require("fs");
var f = "/opt/snapreceipt-ai/public/index.html";
var s = fs.readFileSync(f, "utf8");
s = s.replace(
  /(<script src="js\/app\.js)/,
  '<script src="js/components/accountPanel.js?v=recovery"></script>\n  $1'
);
fs.writeFileSync(f, s);
console.log("  Added accountPanel.js script tag.");
HTMLEOF
else
  echo "  OK — exactly one script tag."
fi
echo ""

# Step 6: Verify settings.js export
echo "[6] Checking settings.js export..."
if grep -q "openDeleteAccountModal: openDeleteAccountModal" "$APP/js/components/settings.js" 2>/dev/null; then
  echo "  Already exports openDeleteAccountModal."
else
  echo "  Adding export..."
  node << 'SETEOF'
var fs = require("fs");
var f = "/opt/snapreceipt-ai/public/js/components/settings.js";
var s = fs.readFileSync(f, "utf8");
s = s.replace(
  /(mount: mount,)/,
  "$1\n    openDeleteAccountModal: openDeleteAccountModal,"
);
fs.writeFileSync(f, s);
console.log("  Added openDeleteAccountModal export.");
SETEOF
fi
echo ""

# Step 7: Final syntax check
echo "[7] Final syntax verification..."
ALL_OK=true
for f in "$APP/js/app.js" "$APP/js/components/accountPanel.js" "$APP/js/components/settings.js"; do
  echo -n "  $f: "
  if node -c "$f" 2>&1; then
    echo ""
  else
    ALL_OK=false
  fi
done
echo ""

if $ALL_OK; then
  echo "[8] Restarting pm2..."
  pm2 restart snapreceipt-ai --update-env
  echo ""
  echo "=== Recovery complete! ==="
  echo "Hard-refresh (Ctrl+Shift+R) the site to verify."
else
  echo "=== RECOVERY INCOMPLETE — some files still have errors ==="
  echo "Please screenshot this output and share it."
fi

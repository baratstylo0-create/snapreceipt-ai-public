#!/bin/bash
# Fix the actual root-cause bug: nav.js's buildBrandHeader() never read
# opts.nativeApp into a local var, so the bare `nativeApp` reference on
# line 180/183 threw "ReferenceError: nativeApp is not defined" and crashed
# app boot before anything could render (hence blank page + footer only).
APP=/opt/snapreceipt-ai/public

echo "=== Fixing nav.js (nativeApp ReferenceError) via GitHub API ==="

node -e "
var https = require('https');
var fs = require('fs');
var options = {
  hostname: 'api.github.com',
  path: '/repos/baratstylo0-create/snapreceipt-ai-public/contents/public/js/components/nav.js?ref=deploy-script',
  headers: { 'User-Agent': 'snapreceipt-fix-script', 'Accept': 'application/vnd.github.v3+json' }
};
https.get(options, function(res) {
  var data = '';
  res.on('data', function(c) { data += c; });
  res.on('end', function() {
    var json = JSON.parse(data);
    var buf = Buffer.from(json.content, 'base64');
    fs.writeFileSync('$APP/js/components/nav.js', buf);
    console.log('Wrote ' + buf.length + ' bytes (expected 16688)');
  });
}).on('error', function(e) { console.error('ERROR: ' + e.message); process.exit(1); });
"

grep -q "var nativeApp = !!opts.nativeApp;" "$APP/js/components/nav.js" && echo "Fix confirmed present" || echo "WARNING: fix not found in file"
node -c "$APP/js/components/nav.js" && echo "Syntax OK" || echo "Syntax FAIL"

echo ""
echo "Restarting pm2..."
pm2 restart snapreceipt-ai --update-env
echo "=== Done ==="

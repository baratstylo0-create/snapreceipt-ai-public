#!/bin/bash
# Fix emailverify.js using the GitHub API (bypasses raw.githubusercontent.com's
# edge CDN cache, which was serving a stale copy to this VPS's region).
APP=/opt/snapreceipt-ai/public

echo "=== Fixing emailverify.js via GitHub API (bypass CDN) ==="

node -e "
var https = require('https');
var fs = require('fs');
var options = {
  hostname: 'api.github.com',
  path: '/repos/baratstylo0-create/snapreceipt-ai-public/contents/public/js/components/emailverify.js?ref=deploy-script',
  headers: { 'User-Agent': 'snapreceipt-fix-script', 'Accept': 'application/vnd.github.v3+json' }
};
https.get(options, function(res) {
  var data = '';
  res.on('data', function(c) { data += c; });
  res.on('end', function() {
    var json = JSON.parse(data);
    var buf = Buffer.from(json.content, 'base64');
    fs.writeFileSync('$APP/js/components/emailverify.js', buf);
    console.log('Wrote ' + buf.length + ' bytes (expected 8976)');
  });
}).on('error', function(e) { console.error('ERROR: ' + e.message); process.exit(1); });
"

node -c "$APP/js/components/emailverify.js" && echo "Syntax OK" || echo "Syntax FAIL"

echo ""
echo "Restarting pm2..."
pm2 restart snapreceipt-ai --update-env
echo "=== Done ==="

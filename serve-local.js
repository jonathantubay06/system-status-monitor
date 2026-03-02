// Quick local server for previewing the dashboard
// Usage: node serve-local.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3456;
const DASHBOARD = path.join(__dirname, 'dashboard');

const MIME = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
};

http.createServer((req, res) => {
  let filePath = path.join(DASHBOARD, req.url === '/' ? 'index.html' : req.url.split('?')[0]);

  // Rewrite GitHub raw URLs to local files
  if (!fs.existsSync(filePath)) {
    res.writeHead(404); res.end('Not found'); return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(filePath));
}).listen(PORT, () => {
  console.log(`\n  Dashboard preview: http://localhost:${PORT}\n`);
  console.log(`  Serving from: ${DASHBOARD}`);
  console.log(`  Press Ctrl+C to stop\n`);
});

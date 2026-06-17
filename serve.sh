#!/bin/bash
# OpenCode Web GUI - Start Script
# Starts the OpenCode server and serves the web interface

set -e

PORT=${1:-7899}
WEB_PORT=${2:-8080}
HOSTNAME="127.0.0.1"

echo "Starting OpenCode server..."
opencode serve --port "$PORT" --hostname "$HOSTNAME" --cors "*" &
OPENCODE_PID=$!

# Wait for server
sleep 2

echo "Starting Web GUI on http://$HOSTNAME:$WEB_PORT"
echo "OpenCode API at http://$HOSTNAME:$PORT"

# Serve the web-ui directory with a simple HTTP server
# This server adds proper CORS headers
node -e "
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB_DIR = __dirname;
const OPENCODE_PORT = $PORT;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(WEB_DIR, filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(WEB_DIR, 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}).listen($WEB_PORT, '127.0.0.1', () => {
  console.log('Web GUI: http://127.0.0.1:' + $WEB_PORT);
  console.log('PID: ' + process.pid);
});

process.on('SIGTERM', () => { process.exit(0); });
process.on('SIGINT', () => { process.exit(0); });
" &
HTTP_PID=$!

# Trap to clean up
trap "kill $OPENCODE_PID $HTTP_PID 2>/dev/null; exit 0" SIGINT SIGTERM

echo ""
echo "OpenCode Web GUI is running!"
echo "  Web UI:     http://127.0.0.1:$WEB_PORT"
echo "  API Server: http://127.0.0.1:$PORT"
echo ""
echo "Press Ctrl+C to stop."

# Open browser
sleep 1
open "http://127.0.0.1:$WEB_PORT" 2>/dev/null || true

# Wait for processes
wait

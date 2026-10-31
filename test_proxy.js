const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = 8766;

// Helper to fetch with custom headers
function proxyRequest(targetUrl, clientReq, clientRes) {
  const parsed = new URL(targetUrl);
  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;

  const headers = {
    'Origin': 'https://www.visionplus.id',
    'Referer': 'https://www.visionplus.id/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
  };

  if (clientReq.headers['content-type']) {
    headers['Content-Type'] = clientReq.headers['content-type'];
  }

  const options = {
    method: clientReq.method,
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    headers: headers
  };

  const req = transport.request(options, (res) => {
    // Add CORS headers
    const resHeaders = { ...res.headers };
    resHeaders['access-control-allow-origin'] = '*';
    resHeaders['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    resHeaders['access-control-allow-headers'] = '*';
    delete resHeaders['content-security-policy'];

    clientRes.writeHead(res.statusCode, resHeaders);
    res.pipe(clientRes);
  });

  req.on('error', (err) => {
    console.error('Proxy error:', err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      clientRes.end('Proxy error: ' + err.message);
    }
  });

  clientReq.pipe(req);
}

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  // 1. Proxy endpoint: /proxy?url=...
  if (parsedUrl.pathname === '/proxy') {
    const target = parsedUrl.searchParams.get('url');
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing url param');
      return;
    }
    proxyRequest(target, req, res);
    return;
  }

  // 2. Fresh playlist from worker: /api/playlist
  if (parsedUrl.pathname === '/api/playlist') {
    try {
      const resp = await fetch('https://visionplus.drmiontv.workers.dev/playlist.m3u');
      if (!resp.ok) throw new Error('Worker returned ' + resp.status);
      const text = await resp.text();
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(text);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Failed to fetch playlist: ' + e.message);
    }
    return;
  }

  // Default: 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`Test Proxy Server running on http://localhost:${PORT}`);
});

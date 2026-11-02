#!/bin/bash
set -e

mkdir -p /root/vidio-proxy
cd /root/vidio-proxy

cat << 'EOF' > /root/vidio-proxy/server.js
const http = require('http');
const { URL } = require('url');

const PORT = 8765;
const vidioTokenCache = {};

async function getVidioStream(channelId) {
  const now = Date.now();
  if (vidioTokenCache[channelId] && vidioTokenCache[channelId].expiresAt > now) {
    return vidioTokenCache[channelId];
  }

  const cookie = 'ahoy_visitor=45d2c1a3-9a34-4c1f-9ef1-147139cd2b5a; country_id=ID; _vidio=true; x_user_token=prNQvxNZ3onTPjBTM3sU; access_token=eyJhbGciOiJIUzI1NiJ9.eyJkYXRhIjp7InR5cGUiOiJhY2Nlc3NfdG9rZW4iLCJ1aWQiOjc4OTQzMTA3fSwiZXhwIjoxNzkzNzA1MjM1fQ.3i72uOcqRosBX1_nsopzwUAmaRsImDWUJEW3DoAJ8j8;';
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

  let clientId = '';
  let signature = '';
  try {
    const pageRes = await fetch(`https://www.vidio.com/live/${channelId}`, {
      headers: { 'User-Agent': userAgent, 'Referer': 'https://www.vidio.com/', 'Cookie': cookie }
    });
    if (pageRes.ok) {
      const html = await pageRes.text();
      const matchClient = html.match(/clientId[^0-9]+([0-9.]+)/);
      const matchSig = html.match(/signature[^a-f0-9]+([a-f0-9]{32,64})/i);
      if (matchClient) clientId = matchClient[1];
      if (matchSig) signature = matchSig[1];
    }
  } catch (err) {}

  const apiHeaders = {
    'Origin': 'https://www.vidio.com',
    'Referer': 'https://www.vidio.com/',
    'User-Agent': userAgent,
    'X-Api-Key': 'CH1ZFsN4N/MIfAds1DL9mP151CNqIpWHqZGRr+LkvUyiq3FRPuP1Kt6aK+pG3nEC1FXt0ZAAJ5FKP8QU8CZ5/liRgivOu0XPxx95b+n9Ep50u+1xM8A+e8Aqqr0ELvoLqbPbciOC95byhupdN9IjfKcQl/qXFNXJnLsvn5L5hM8=',
    'X-API-Platform': 'web-desktop',
    'X-Secure-Level': '2',
    'X-User-Email': 'mikhaelyuli13@gmail.com',
    'X-User-Id': '78943107',
    'Cookie': cookie
  };

  if (clientId) apiHeaders['X-Client'] = clientId;
  if (signature) apiHeaders['X-Signature'] = signature;

  const apiRes = await fetch(`https://api.vidio.com/livestreamings/${channelId}/stream?initialize=true`, {
    headers: apiHeaders
  });

  if (!apiRes.ok) throw new Error(`Vidio API error: ${apiRes.status}`);

  const json = await apiRes.json();
  const attrs = json.data?.attributes;
  if (!attrs || !attrs.hls) throw new Error('No stream URLs');

  const expiresIn = attrs.expires_in || 7200;
  vidioTokenCache[channelId] = {
    hls: attrs.hls,
    expiresAt: now + ((expiresIn - 300) * 1000)
  };
  return vidioTokenCache[channelId];
}

function rewriteM3u8(content, manifestUrl, host, proto = 'http') {
  const origin = new URL(manifestUrl).origin;
  const baseDir = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
  return content.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#EXT-X-MAP') && trimmed.includes('URI="')) {
      return trimmed.replace(/URI="([^"]+)"/, (m, uri) => {
        const abs = uri.startsWith('http') ? uri : (uri.startsWith('/') ? origin + uri : baseDir + uri);
        return `URI="${proto}://${host}/stream/${abs}"`;
      });
    }
    if (trimmed.startsWith('#EXT-X-MEDIA') && trimmed.includes('URI="')) {
      return trimmed.replace(/URI="([^"]+)"/, (m, uri) => {
        const abs = uri.startsWith('http') ? uri : (uri.startsWith('/') ? origin + uri : baseDir + uri);
        return `URI="${proto}://${host}/stream/${abs}"`;
      });
    }
    if (trimmed.startsWith('#')) return line;
    const abs = trimmed.startsWith('http') ? trimmed : (trimmed.startsWith('/') ? origin + trimmed : baseDir + trimmed);
    return `${proto}://${host}/stream/${abs}`;
  }).join('\n');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const host = req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const rawUrl = req.url;

  // Web Player for browser
  if (rawUrl === '/' || rawUrl === '/index.html' || rawUrl.startsWith('/player')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>Vidio TV Web Player</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    body { background: #0f172a; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
    video { width: 100%; max-width: 900px; border-radius: 12px; background: #000; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    .channels { display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap; justify-content: center; }
    button { background: #2563eb; color: #fff; border: none; padding: 10px 18px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.2s; }
    button:hover { background: #1d4ed8; transform: translateY(-2px); }
  </style>
</head>
<body>
  <h2>📺 Vidio Live Stream Web Player</h2>
  <video id="video" controls autoplay></video>
  <div class="channels">
    <button onclick="playChannel('1561')">RTV</button>
    <button onclick="playChannel('205')">Indosiar</button>
    <button onclick="playChannel('204')">SCTV</button>
    <button onclick="playChannel('8237')">Mentari TV</button>
    <button onclick="playChannel('206')">Moji</button>
    <button onclick="playChannel('733')">Trans TV</button>
    <button onclick="playChannel('734')">Trans 7</button>
  </div>
  <script>
    const video = document.getElementById('video');
    let hls = null;
    function playChannel(id) {
      const url = '/vidio/' + id + '.m3u8';
      if (Hls.isSupported()) {
        if (hls) hls.destroy();
        hls = new Hls();
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => video.play());
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.play();
      }
    }
    playChannel('1561');
  </script>
</body>
</html>`);
    return;
  }

  const vidioMatch = rawUrl.match(/^\/(?:tv\/|live\/)?vidio\/([a-zA-Z0-9_\-]+)(?:\.m3u8)?/);
  if (vidioMatch) {
    const channelId = vidioMatch[1];
    try {
      const streamData = await getVidioStream(channelId);
      const remoteRes = await fetch(streamData.hls, {
        headers: {
          'Origin': 'https://www.vidio.com',
          'Referer': 'https://www.vidio.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      const m3u8Text = await remoteRes.text();
      const rewritten = rewriteM3u8(m3u8Text, streamData.hls, host, proto);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store'
      });
      res.end(rewritten);
      return;
    } catch (err) {
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Error: ' + err.message); }
      return;
    }
  }

  if (rawUrl.startsWith('/stream/')) {
    let targetUrl = rawUrl.substring('/stream/'.length);
    if (targetUrl.startsWith('https:/') && !targetUrl.startsWith('https://')) targetUrl = 'https://' + targetUrl.substring(7);
    else if (targetUrl.startsWith('http:/') && !targetUrl.startsWith('http://')) targetUrl = 'http://' + targetUrl.substring(6);

    try {
      const fetchHeaders = {
        'Origin': 'https://www.vidio.com',
        'Referer': 'https://www.vidio.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      };
      if (req.headers['range']) fetchHeaders['Range'] = req.headers['range'];

      const remoteRes = await fetch(targetUrl, { headers: fetchHeaders });
      const isM3u8 = new URL(targetUrl).pathname.endsWith('.m3u8') || (remoteRes.headers.get('content-type') || '').includes('mpegurl');
      if (isM3u8) {
        const text = await remoteRes.text();
        const rewritten = rewriteM3u8(text, targetUrl, host, proto);
        res.writeHead(remoteRes.status, { 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(rewritten);
        return;
      }

      res.writeHead(remoteRes.status, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': remoteRes.headers.get('content-type') || 'application/octet-stream'
      });
      const reader = remoteRes.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); break; }
            res.write(Buffer.from(value));
          }
        } catch (e) { res.end(); }
      };
      pump();
      return;
    } catch (e) {
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Proxy Error'); }
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found\n');
});

server.listen(PORT, '0.0.0.0', () => console.log('Listening on ' + PORT));
EOF

pm2 restart vidio-proxy
echo "🎉 Update selesai!"

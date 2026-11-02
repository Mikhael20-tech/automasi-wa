const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const vidioTokenCache = {};
const recentLogs = [];

function addLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  recentLogs.push(line);
  if (recentLogs.length > 200) recentLogs.shift();
}

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
  if (!attrs || (!attrs.hls && !attrs.dash)) throw new Error('No stream URLs');

  let hlsUrl = attrs.hls || '';
  if (hlsUrl.startsWith('http://')) hlsUrl = 'https://' + hlsUrl.substring(7);

  let dashUrl = attrs.dash || '';
  if (dashUrl.startsWith('http://')) dashUrl = 'https://' + dashUrl.substring(7);

  const expMatch = (hlsUrl || dashUrl).match(/exp=(\d+)/);
  const expiresAt = expMatch ? (parseInt(expMatch[1]) * 1000 - 30000) : (now + 180000);

  vidioTokenCache[channelId] = {
    hls: hlsUrl,
    dash: dashUrl,
    custom_data: attrs.custom_data || {},
    license_servers: attrs.license_servers || {},
    expiresAt: expiresAt
  };
  return vidioTokenCache[channelId];
}

function rewriteM3u8(content, manifestUrl, host, proto = 'http') {
  const origin = new URL(manifestUrl).origin;
  const baseDir = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
  const rawLines = content.split('\n');
  const lines = [];

  const hasH264 = content.includes('CODECS="avc1');
  let skipNext = false;
  for (let i = 0; i < rawLines.length; i++) {
    let l = rawLines[i].trim();
    if (!l) continue;

    if (l.startsWith('#EXT-X-CONTENT-STEERING')) continue;

    if (l.includes('PATHWAY-ID="backup"') || l.includes('GROUP-ID="backup-audio"') || l.includes('NAME="backup"')) {
      if (l.startsWith('#EXT-X-STREAM-INF')) skipNext = true;
      continue;
    }

    if (hasH264 && l.startsWith('#EXT-X-STREAM-INF') && l.includes('av01')) {
      skipNext = true;
      continue;
    }

    if (skipNext) {
      skipNext = false;
      continue;
    }

    l = l.replace(/,PATHWAY-ID="[^"]+"/g, '');
    lines.push(l);
  }

  return lines.map(line => {
    if (line.startsWith('#EXT-X-MAP') && line.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/, (m, uri) => {
        let abs = uri.startsWith('http') ? uri : (uri.startsWith('/') ? origin + uri : baseDir + uri);
        if (abs.startsWith('http://')) abs = 'https://' + abs.substring(7);
        return `URI="${proto}://${host}/stream/${abs}"`;
      });
    }
    if (line.startsWith('#EXT-X-MEDIA') && line.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/, (m, uri) => {
        let abs = uri.startsWith('http') ? uri : (uri.startsWith('/') ? origin + uri : baseDir + uri);
        if (abs.startsWith('http://')) abs = 'https://' + abs.substring(7);
        return `URI="${proto}://${host}/stream/${abs}"`;
      });
    }
    if (line.startsWith('#')) return line;
    let abs = line.startsWith('http') ? line : (line.startsWith('/') ? origin + line : baseDir + line);
    if (abs.startsWith('http://')) abs = 'https://' + abs.substring(7);
    return `${proto}://${host}/stream/${abs}`;
  }).join('\n');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const host = req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const rawUrl = req.url;

  addLog(`${req.method} ${rawUrl}`);

  // Diagnostic Logs
  if (rawUrl === '/logs') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(recentLogs.join('\n'));
    return;
  }

  // Playlist M3U Service
  if (rawUrl === '/akmatv.m3u' || rawUrl === '/playlist.m3u' || rawUrl === '/api/visionplus.m3u') {
    const candidatePaths = [
      path.join(__dirname, 'akmatv.m3u'),
      path.join(__dirname, '..', 'akmatv.m3u')
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(fs.readFileSync(p));
        return;
      }
    }
  }

  // Modern NusaTV Web App (from tv/ folder)
  if (rawUrl === '/' || rawUrl === '/index.html' || rawUrl === '/tv' || rawUrl === '/tv/') {
    const candidatePaths = [
      path.join(__dirname, 'tv', 'index.html'),
      path.join(__dirname, 'index.html')
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(p));
        return;
      }
    }
  }

  if (rawUrl === '/tv/app.js' || rawUrl === '/app.js') {
    const candidatePaths = [
      path.join(__dirname, 'tv', 'app.js'),
      path.join(__dirname, 'app.js')
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(fs.readFileSync(p));
        return;
      }
    }
  }

  if (rawUrl === '/tv/style.css' || rawUrl === '/style.css') {
    const candidatePaths = [
      path.join(__dirname, 'tv', 'style.css'),
      path.join(__dirname, 'style.css')
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
        res.end(fs.readFileSync(p));
        return;
      }
    }
  }

  // 1. Widevine DRM License Proxy
  if (rawUrl.startsWith('/vidio/license')) {
    const parsedUrl = new URL(rawUrl, `http://${host}`);
    const channelId = parsedUrl.searchParams.get('id') || '6362';
    try {
      const streamData = await getVidioStream(channelId);
      const widevineToken = streamData.custom_data?.widevine;
      if (!widevineToken) {
        addLog(`[License] ERROR: No Widevine token for channel ${channelId}`);
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('No Widevine token found for channel ' + channelId);
        return;
      }

      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const challengeBody = Buffer.concat(chunks);
      addLog(`[License] Received challenge for ${channelId}, size: ${challengeBody.length} bytes`);

      const licUrl = streamData.license_servers?.drm_license_url || 'https://license.vidio.com/ri/licenseManager.do';
      const licenseRes = await fetch(licUrl, {
        method: 'POST',
        headers: {
          'Origin': 'https://www.vidio.com',
          'Referer': 'https://www.vidio.com/',
          'pallycon-customdata-v2': widevineToken,
          'Content-Type': 'application/octet-stream',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        body: challengeBody
      });

      const resBuffer = Buffer.from(await licenseRes.arrayBuffer());
      addLog(`[License] Upstream PallyCon status: ${licenseRes.status}, resp size: ${resBuffer.length} bytes`);

      res.writeHead(licenseRes.status, {
        'Content-Type': 'application/octet-stream',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(resBuffer);
      return;
    } catch (e) {
      addLog(`[License] Exception: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('License Error: ' + e.message);
      }
      return;
    }
  }

  // 2. MPEG-DASH (.mpd) Proxy for DRM Channels
  const mpdMatch = rawUrl.match(/^\/(?:tv\/|live\/)?vidio\/([a-zA-Z0-9_\-]+)\.mpd/);
  if (mpdMatch) {
    const channelId = mpdMatch[1];
    try {
      let streamData = await getVidioStream(channelId);
      if (!streamData.dash) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('No DASH MPD available for channel ' + channelId);
        return;
      }

      let remoteRes = await fetch(streamData.dash, {
        headers: {
          'Origin': 'https://www.vidio.com',
          'Referer': 'https://www.vidio.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (remoteRes.status === 403 || remoteRes.status === 401) {
        delete vidioTokenCache[channelId];
        streamData = await getVidioStream(channelId);
        remoteRes = await fetch(streamData.dash, {
          headers: {
            'Origin': 'https://www.vidio.com',
            'Referer': 'https://www.vidio.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
      }

      const mpdText = await remoteRes.text();
      const dashOrigin = new URL(streamData.dash).origin;
      const rewritten = mpdText.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (m, bUrl) => {
        const fullBase = bUrl.startsWith('http') ? bUrl : (bUrl.startsWith('/') ? dashOrigin + bUrl : dashOrigin + '/' + bUrl);
        return `<BaseURL>${proto}://${host}/stream/${fullBase}</BaseURL>`;
      });

      res.writeHead(200, {
        'Content-Type': 'application/dash+xml; charset=utf-8',
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

  // 3. HLS (.m3u8) Proxy for Non-DRM Channels
  const vidioMatch = rawUrl.match(/^\/(?:tv\/|live\/)?vidio\/([a-zA-Z0-9_\-]+)(?:\.m3u8)?/);
  if (vidioMatch) {
    const channelId = vidioMatch[1];
    try {
      let streamData = await getVidioStream(channelId);
      let remoteRes = await fetch(streamData.hls, {
        headers: {
          'Origin': 'https://www.vidio.com',
          'Referer': 'https://www.vidio.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (remoteRes.status === 403 || remoteRes.status === 401) {
        delete vidioTokenCache[channelId];
        streamData = await getVidioStream(channelId);
        remoteRes = await fetch(streamData.hls, {
          headers: {
            'Origin': 'https://www.vidio.com',
            'Referer': 'https://www.vidio.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
      }

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

  // 4. Reverse Proxy for Media Segments (.m4s, .ts, .mp4)
  if (rawUrl.startsWith('/stream/')) {
    let targetUrl = rawUrl.substring('/stream/'.length);
    if (targetUrl.startsWith('https:/') && !targetUrl.startsWith('https://')) targetUrl = 'https://' + targetUrl.substring(7);
    else if (targetUrl.startsWith('http:/') && !targetUrl.startsWith('http://')) targetUrl = 'http://' + targetUrl.substring(6);

    if (targetUrl.startsWith('http://')) {
      targetUrl = 'https://' + targetUrl.substring(7);
    }

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

server.listen(PORT, '0.0.0.0', () => addLog('Listening on ' + PORT));

const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 8765;
const vidioTokenCache = {};
const recentLogs = [];

let vidioSession = {
  encryptedApiKey: '',
  cookieHeader: '',
  expiresAt: 0
};

let liga1Cache = {
  data: null,
  cachedAt: 0
};

function addLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  recentLogs.push(line);
  if (recentLogs.length > 200) recentLogs.shift();
}

async function getOrRefreshVidioSession() {
  const now = Date.now();
  if (vidioSession.encryptedApiKey && vidioSession.expiresAt > now + 300000) {
    return vidioSession;
  }

  addLog('[Auth] Refreshing Vidio API Key & Session from /auth...');
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  const authRes = await fetch('https://api.vidio.com/auth', {
    method: 'POST',
    headers: {
      'Origin': 'https://www.vidio.com',
      'Referer': 'https://www.vidio.com/',
      'User-Agent': userAgent
    }
  });

  if (!authRes.ok) {
    throw new Error(`Failed to fetch /auth: ${authRes.status}`);
  }

  const authData = await authRes.json();
  if (!authData.api_key) {
    throw new Error('No api_key in /auth response');
  }

  const setCookies = authRes.headers.getSetCookie ? authRes.headers.getSetCookie() : [authRes.headers.get('set-cookie')];
  let cookieHeader = setCookies.filter(Boolean).map(c => c.split(';')[0]).join('; ');

  // Include local account_cookie.txt if present for DRM/account-locked channels
  const cookieFile = path.join(__dirname, 'account_cookie.txt');
  if (fs.existsSync(cookieFile)) {
    try {
      const extra = fs.readFileSync(cookieFile, 'utf8').trim();
      if (extra) cookieHeader = cookieHeader ? `${cookieHeader}; ${extra}` : extra;
    } catch (e) {}
  }

  const key = 'dPr0QImQ7bc5o9LMntNba2DOsSbZcjUh';
  const iv = 'C8RWsrtFsoeyCyPt';
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encryptedKey = cipher.update(authData.api_key, 'utf-8', 'base64') + cipher.final('base64');

  let expiresAt = now + 86400000;
  if (authData.api_key_expires_at) {
    expiresAt = new Date(authData.api_key_expires_at).getTime();
  }

  vidioSession = {
    encryptedApiKey: encryptedKey,
    cookieHeader: cookieHeader || 'country_id=ID;',
    expiresAt: expiresAt
  };

  addLog(`[Auth] Obtained new API key, valid until ${new Date(expiresAt).toISOString()}`);
  return vidioSession;
}

// Auto-detect currently ongoing BRI Liga 1 match
async function getActiveLiga1Match() {
  const now = Date.now();
  if (liga1Cache.data && (now - liga1Cache.cachedAt < 60000)) {
    return liga1Cache.data;
  }

  try {
    const session = await getOrRefreshVidioSession();
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

    const res = await fetch('https://api.vidio.com/search?q=BRI+Liga+1', {
      headers: {
        'Origin': 'https://www.vidio.com',
        'Referer': 'https://www.vidio.com/',
        'User-Agent': userAgent,
        'X-Api-Key': session.encryptedApiKey,
        'X-API-Platform': 'web-desktop',
        'X-Secure-Level': '2',
        'Cookie': session.cookieHeader
      }
    });

    if (res.ok) {
      const json = await res.json();
      const schedules = (json.included || []).filter(item => 
        item.attributes?.content_type === 'livestreaming_schedule' ||
        item.id?.includes('livestreaming_schedule')
      );

      for (const s of schedules) {
        const attrs = s.attributes || {};
        const startTime = new Date(attrs.start_time).getTime();
        const endTime = new Date(attrs.end_time).getTime();

        // Active if now is within 15 minutes before start until end
        if (now >= (startTime - 15 * 60 * 1000) && now <= endTime) {
          const matchId = String(attrs.livestreaming_id || '');
          if (matchId && matchId !== '205') {
            liga1Cache = {
              data: {
                id: matchId,
                title: attrs.title || 'BRI Super League',
                startTime,
                endTime
              },
              cachedAt: now
            };
            addLog(`[Liga1 Scraper] Active match found: ${attrs.title} (Livestream ID: ${matchId})`);
            return liga1Cache.data;
          }
        }
      }
    }
  } catch (err) {
    addLog(`[Liga1 Scraper] Error searching match: ${err.message}`);
  }

  liga1Cache = { data: null, cachedAt: now };
  return null;
}

async function getVidioStream(channelId) {
  if (channelId === '22207' || channelId === 'liga1' || channelId === 'bola') {
    return {
      dash: 'https://tencent-1.vidiostream.com/wmt:eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3NUb2tlblNlc3Npb25JZCI6IiIsImV4cCI6MTc5NDU2MzI4MSwiZnJhZ2R1cmF0aW9uIjoyMDAwLCJpYXQiOjE3OTM5NTg0ODEsIm5iZiI6MTc5Mzk1ODQ4MSwidHh3bXZlciI6MSwid21wYXQiOiJvSU9UdEFRPSIsIndtcGF0Zm10IjoiYmFzZTY0Iiwid21wYXRsZW4iOjQwfQ.OQk-h8mdMsDzZPC6rgcj6BYqHeduwMa9JIoYxV1b-ro/live/tencent-1-drm-dash/main.mpd',
      custom_data: {
        widevine: 'eyJkcm1fdHlwZSI6IldpZGV2aW5lIiwic2l0ZV9pZCI6Ik1RRFQiLCJ1c2VyX2lkIjoiNzg5NDMxMDciLCJjaWQiOiJ0ZW5jZW50MSIsInBvbGljeSI6IjVreGtTMkcrSGxIUm9hZ29QMGFOd2YxYll0MTBKZVlKMmhCVno3OGxkMmdCUHJBRWU5Z0NPb05ubXVJSWJGejB0aEp4WWtocmhTWXloSGpxS3Fsb29rVVI2eFhZVmVkL1ljaWNuTHRMLy9aMXc3RVJVRk9EeU42K0hBWit5ZTk2IiwidGltZXN0YW1wIjoiMjAyNi0xMS0wNlQxMjowNjozM1oiLCJoYXNoIjoiclNrYUkwQVJPMnoxYXR5M2w5MjZqbnYrZHlKeCt6a3JUd2FjdC9nTDU5ND0iLCJrZXlfcm90YXRpb24iOmZhbHNlLCJ2aWRpb19jb250ZW50X2lkIjoyMjIwNywidmlkaW9fY29udGVudF90eXBlIjoiTGl2ZXN0cmVhbWluZyIsImlzX3ByZXZpZXciOmZhbHNlfQ=='
      },
      license_servers: {
        drm_license_url: 'https://license.vidio.com/ri/licenseManager.do'
      },
      expiresAt: Date.now() + 3600000 * 4
    };
  }

  // Resolve alias
  if (channelId === 'indosiar-auto') {
    const activeMatch = await getActiveLiga1Match();
    if (activeMatch) {
      try {
        return await getVidioStream(activeMatch.id);
      } catch (err) {
        addLog(`[Stream] Failed to get match stream ${activeMatch.id}: ${err.message}. Falling back to 205.`);
      }
    }
    return await getVidioStream('205');
  }

  const now = Date.now();
  if (vidioTokenCache[channelId] && vidioTokenCache[channelId].expiresAt > now) {
    return vidioTokenCache[channelId];
  }

  const session = await getOrRefreshVidioSession();
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  let clientId = '';
  let signature = '';
  try {
    const pageRes = await fetch(`https://www.vidio.com/live/${channelId}`, {
      headers: {
        'User-Agent': userAgent,
        'Referer': 'https://www.vidio.com/',
        'Cookie': session.cookieHeader
      }
    });
    if (pageRes.ok) {
      const html = await pageRes.text();
      const matchClient = html.match(/clientId[^0-9]+([0-9.]+)/);
      const matchSig = html.match(/signature[^a-f0-9]+([a-f0-9]{32,64})/i);
      if (matchClient) clientId = matchClient[1];
      if (matchSig) signature = matchSig[1];
    }
  } catch (err) {
    addLog(`[Stream] Warning fetching live page for ${channelId}: ${err.message}`);
  }

  const apiHeaders = {
    'Origin': 'https://www.vidio.com',
    'Referer': `https://www.vidio.com/live/${channelId}`,
    'User-Agent': userAgent,
    'X-Api-Key': session.encryptedApiKey,
    'X-API-Platform': 'web-desktop',
    'X-Secure-Level': '2',
    'Cookie': session.cookieHeader
  };

  if (clientId) apiHeaders['X-Client'] = clientId;
  if (signature) apiHeaders['X-Signature'] = signature;

  const apiRes = await fetch(`https://api.vidio.com/livestreamings/${channelId}/stream?initialize=true`, {
    headers: apiHeaders
  });

  if (!apiRes.ok) {
    const errText = await apiRes.text().catch(() => '');
    if (errText.includes('invalid_api_key') || errText.includes('Unauthorized application')) {
      vidioSession.expiresAt = 0;
    }
    if (errText.includes('not_yet_started')) {
      addLog(`[Stream] Event ${channelId} not yet started. Falling back to Indosiar 205.`);
      if (channelId !== '205') return await getVidioStream('205');
    }
    throw new Error(`Vidio API error (${channelId}): ${apiRes.status} ${errText}`);
  }

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
    if (!l) continue; // Skip empty lines completely so they don't become bogus URLs!

    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      // Prioritize standard H.264 (avc1) for maximum TV hardware decoding compatibility!
      // Skip AV1 (av01) and HEVC (hvc1/hev1) if H.264 is available to prevent TV freezing/stuck pictures
      if (hasH264 && (l.includes('CODECS="av01') || l.includes('CODECS="hvc1') || l.includes('CODECS="hev1'))) {
        skipNext = true;
        continue;
      }
    } else if (skipNext) {
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

  // Active Liga 1 Match Status API
  if (rawUrl === '/vidio/liga1/status') {
    const match = await getActiveLiga1Match();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      active: !!match,
      match: match || null,
      fallback: '205 (Indosiar)'
    }, null, 2));
    return;
  }

  // Playlist M3U Service
  if (rawUrl === '/akmatv.m3u' || rawUrl === '/playlist.m3u' || rawUrl === '/api/visionplus.m3u') {
    const candidatePaths = [
      path.join(__dirname, 'playlist.m3u'),
      path.join(__dirname, 'akmatv.m3u'),
      path.join(__dirname, '..', 'playlist.m3u')
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
    let channelId = parsedUrl.searchParams.get('id') || '205';

    if (channelId === 'liga1' || channelId === 'bola' || channelId === 'indosiar-auto') {
      const match = await getActiveLiga1Match();
      channelId = match ? match.id : '205';
    }

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
    let channelId = mpdMatch[1];
    try {
      let streamData = await getVidioStream(channelId);
      if (!streamData.dash) {
        if (streamData.hls) {
          res.writeHead(302, { 'Location': `/vidio/${channelId}.m3u8` });
          res.end();
          return;
        }
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
      const dashBaseDir = streamData.dash.substring(0, streamData.dash.lastIndexOf('/') + 1);
      const proxyBaseUrl = `${proto}://${host}/stream/${dashBaseDir}`;
      let rewritten = mpdText;
      if (rewritten.includes('<BaseURL>')) {
        rewritten = rewritten.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (m, bUrl) => {
          const fullBase = bUrl.startsWith('http') ? bUrl : (bUrl.startsWith('/') ? dashOrigin + bUrl : dashOrigin + '/' + bUrl);
          return `<BaseURL>${proto}://${host}/stream/${fullBase}</BaseURL>`;
        });
      } else {
        rewritten = rewritten.replace(/<Period([^>]*)>/, `<Period$1>\n    <BaseURL>${proxyBaseUrl}</BaseURL>`);
      }

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

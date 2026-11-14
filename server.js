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
    if (errText.includes('right_blocked')) {
      addLog(`[Stream] Channel ${channelId} right_blocked. Checking redirect...`);
      const bannerMatch = errText.match(/\/live\/(\d+)/);
      if (bannerMatch && bannerMatch[1] && bannerMatch[1] !== channelId) {
        addLog(`[Stream] Attempting redirect to event channel ${bannerMatch[1]}...`);
        try {
          return await getVidioStream(bannerMatch[1]);
        } catch (e2) {
          addLog(`[Stream] Event stream ${bannerMatch[1]} failed: ${e2.message}`);
        }
      }
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

  // ==========================================
  // --- LIVE EVENT MANAGEMENT & STREAMING ---
  // ==========================================
  const event1File = path.join(__dirname, 'event_url.txt');
  const event2File = path.join(__dirname, 'event2_url.txt');

  // Web UI & API to set or view Live Event URL
  if (rawUrl === '/event' || rawUrl === '/set-event' || rawUrl.startsWith('/event?') || rawUrl.startsWith('/set-event?')) {
    const parsedUrl = new URL(rawUrl, `http://${host}`);
    let newUrl = parsedUrl.searchParams.get('url');
    const slot = parsedUrl.searchParams.get('slot') === '2' ? 2 : 1;
    const targetFile = slot === 2 ? event2File : event1File;

    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf-8');
      const params = new URLSearchParams(body);
      if (params.has('url')) newUrl = params.get('url');
    }

    if (typeof newUrl === 'string') {
      newUrl = newUrl.trim();
      fs.writeFileSync(targetFile, newUrl, 'utf-8');
      addLog(`[Live Event] Slot ${slot} updated to: ${newUrl || '(cleared)'}`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Event Updated</title><meta http-equiv="refresh" content="2;url=/event"></head><body style="background:#0f172a;color:#fff;font-family:sans-serif;text-align:center;padding:50px;"><h2 style="color:#38bdf8;">✅ Live Event ${slot} Berhasil Diupdate!</h2><p>Target: <code>${newUrl || 'Kosong (Default / Auto Match)'}</code></p><p style="color:#94a3b8;">Mengarahkan kembali dalam 2 detik...</p></body></html>`);
      return;
    }

    const cur1 = fs.existsSync(event1File) ? fs.readFileSync(event1File, 'utf-8').trim() : '';
    const cur2 = fs.existsSync(event2File) ? fs.readFileSync(event2File, 'utf-8').trim() : '';

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Live Event Stream Manager</title>
  <style>
    body { background: #0f172a; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 20px; display: flex; justify-content: center; }
    .card { background: #1e293b; border-radius: 12px; padding: 25px; max-width: 650px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    h1 { margin-top: 0; color: #38bdf8; font-size: 22px; display: flex; align-items: center; gap: 10px; }
    .slot-box { background: #0f172a; border-radius: 8px; padding: 16px; margin-bottom: 20px; border: 1px solid #334155; }
    .slot-title { font-weight: bold; margin-bottom: 8px; color: #f43f5e; display: flex; justify-content: space-between; }
    .active-url { font-family: monospace; background: #1e293b; padding: 8px 12px; border-radius: 6px; font-size: 13px; word-break: break-all; color: #a5f3fc; border: 1px solid #475569; }
    input[type=text] { width: 100%; box-sizing: border-box; padding: 12px; border-radius: 6px; border: 1px solid #475569; background: #1e293b; color: #fff; font-size: 14px; margin-top: 8px; }
    button { background: #0284c7; color: white; border: none; padding: 10px 18px; border-radius: 6px; cursor: pointer; font-weight: bold; margin-top: 10px; transition: 0.2s; }
    button:hover { background: #0369a1; }
    .btn-danger { background: #e11d48; margin-left: 8px; }
    .btn-danger:hover { background: #be123c; }
    .m3u-link { font-size: 13px; color: #94a3b8; margin-top: 6px; }
    .m3u-link a { color: #38bdf8; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔴 Live Event Stream Manager</h1>
    <p style="color:#94a3b8;font-size:14px;">Masukkan link streaming (.m3u8) atau ID Vidio saat ada event bola / pertandingan live. TV akan otomatis memutar link ini tanpa perlu ubah playlist.</p>

    <div class="slot-box">
      <div class="slot-title"><span>📺 LIVE EVENT 1</span> <span style="font-size:12px;color:#38bdf8;">Slot Utama</span></div>
      <div class="active-url">${cur1 || '<i>(Belum diset - Otomatis Liga 1 / Soccer Channel)</i>'}</div>
      <div class="m3u-link">Stream URL TV: <a href="/live/event.m3u8" target="_blank">http://${host}/live/event.m3u8</a></div>
      <form method="POST" action="/event?slot=1">
        <input type="text" name="url" placeholder="Paste link .m3u8 atau ID Vidio..." value="${cur1}">
        <div style="display:flex;">
          <button type="submit">💾 Simpan Slot 1</button>
          <button type="button" class="btn-danger" onclick="location.href='/event?slot=1&url='">🗑️ Kosongkan</button>
        </div>
      </form>
    </div>

    <div class="slot-box">
      <div class="slot-title"><span>📺 LIVE EVENT 2</span> <span style="font-size:12px;color:#38bdf8;">Slot Cadangan</span></div>
      <div class="active-url">${cur2 || '<i>(Belum diset - Kosong)</i>'}</div>
      <div class="m3u-link">Stream URL TV: <a href="/live/event2.m3u8" target="_blank">http://${host}/live/event2.m3u8</a></div>
      <form method="POST" action="/event?slot=2">
        <input type="text" name="url" placeholder="Paste link .m3u8 atau ID Vidio..." value="${cur2}">
        <div style="display:flex;">
          <button type="submit">💾 Simpan Slot 2</button>
          <button type="button" class="btn-danger" onclick="location.href='/event?slot=2&url='">🗑️ Kosongkan</button>
        </div>
      </form>
    </div>
  </div>
</body>
</html>`);
    return;
  }

  // Handle /live/event.m3u8 and /live/event2.m3u8 (or /event.m3u8)
  const isEvent1 = rawUrl.startsWith('/live/event.m3u8') || rawUrl === '/event.m3u8';
  const isEvent2 = rawUrl.startsWith('/live/event2.m3u8') || rawUrl === '/event2.m3u8';

  if (isEvent1 || isEvent2) {
    const targetFile = isEvent2 ? event2File : event1File;
    let target = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf-8').trim() : '';

    // If not set and event 1, check auto Liga 1 / live match
    if (!target && isEvent1) {
      const match = await getActiveLiga1Match();
      if (match) target = match.id;
    }

    // Fallback if still empty
    if (!target) {
      if (isEvent1) {
        // Fallback to Soccer Channel
        target = 'http://202.80.222.20/cdn/iptv/Tvod/001/channel2000144/1024.m3u8';
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Belum ada siaran event live yang diatur pada slot ini.\\nAtur URL siaran di http://' + host + '/event');
        return;
      }
    }

    // Check if target is a Vidio Channel ID (numbers only)
    if (/^\\d+$/.test(target)) {
      try {
        const streamData = await getVidioStream(target);
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
        addLog(`[Live Event] Error streaming Vidio ID ${target}: ${err.message}`);
      }
    }

    // Otherwise target is an external HTTP/HTTPS M3U8 URL
    if (target.startsWith('http://') || target.startsWith('https://')) {
      try {
        const remoteRes = await fetch(target, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        const m3u8Text = await remoteRes.text();
        const rewritten = rewriteM3u8(m3u8Text, target, host, proto);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store'
        });
        res.end(rewritten);
        return;
      } catch (err) {
        addLog(`[Live Event] Error streaming URL ${target}: ${err.message}`);
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Error streaming event: ' + err.message);
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

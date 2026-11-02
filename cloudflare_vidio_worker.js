/**
 * Cloudflare Worker: Vidio Live Auto-Refresh Token Scraper & Reverse Proxy
 * Online 24/7 di Cloudflare Workers (Gratis 100.000 requests/hari)
 *
 * Mendukung pemutaran langsung di VLC, TiviMate, OTT Navigator, Smart TV, Android, iOS.
 * Penggunaan: https://<worker-anda>.workers.dev/<channelId>.m3u8
 * Contoh:     https://<worker-anda>.workers.dev/1561.m3u8   (RTV)
 *             https://<worker-anda>.workers.dev/206.m3u8    (Indosiar)
 */

// In-memory token cache (persists per edge isolate)
const tokenCache = {};

const COOKIE = 'ahoy_visitor=45d2c1a3-9a34-4c1f-9ef1-147139cd2b5a; country_id=ID; _vidio=true; x_user_token=prNQvxNZ3onTPjBTM3sU; access_token=eyJhbGciOiJIUzI1NiJ9.eyJkYXRhIjp7InR5cGUiOiJhY2Nlc3NfdG9rZW4iLCJ1aWQiOjc4OTQzMTA3fSwiZXhwIjoxNzkzNzA1MjM1fQ.3i72uOcqRosBX1_nsopzwUAmaRsImDWUJEW3DoAJ8j8;';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const API_KEY = 'CH1ZFsN4N/MIfAds1DL9mP151CNqIpWHqZGRr+LkvUyiq3FRPuP1Kt6aK+pG3nEC1FXt0ZAAJ5FKP8QU8CZ5/liRgivOu0XPxx95b+n9Ep50u+1xM8A+e8Aqqr0ELvoLqbPbciOC95byhupdN9IjfKcQl/qXFNXJnLsvn5L5hM8=';

async function getVidioStream(channelId) {
  const now = Date.now();
  if (tokenCache[channelId] && tokenCache[channelId].expiresAt > now) {
    return tokenCache[channelId];
  }

  // 1. Ambil streamSignature terbaru dari halaman Vidio
  let clientId = '';
  let signature = '';
  let pageStatus = 0;
  try {
    const pageRes = await fetch(`https://www.vidio.com/live/${channelId}`, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': 'https://www.vidio.com/',
        'Cookie': COOKIE
      }
    });
    pageStatus = pageRes.status;
    if (pageRes.ok) {
      const html = await pageRes.text();
      const matchClient = html.match(/clientId[\\"]+:\s*[\\"]+([0-9.]+)/);
      const matchSig = html.match(/signature[\\"]+:\s*[\\"]+([a-f0-9]{32,64})/);
      if (matchClient) clientId = matchClient[1];
      if (matchSig) signature = matchSig[1];
    }
  } catch (err) {
    console.error(`Page fetch warning: ${err.message}`);
  }

  // 2. Tembak Vidio Stream API resmi
  const apiHeaders = {
    'Origin': 'https://www.vidio.com',
    'Referer': 'https://www.vidio.com/',
    'User-Agent': USER_AGENT,
    'X-Api-Key': API_KEY,
    'X-API-Platform': 'web-desktop',
    'X-Secure-Level': '2',
    'X-Country-Id': 'ID',
    'X-Country-Alpha2': 'ID',
    'True-Client-IP': '180.248.88.1',
    'X-Forwarded-For': '180.248.88.1',
    'X-Real-IP': '180.248.88.1',
    'X-User-Email': 'mikhaelyuli13@gmail.com',
    'X-User-Id': '78943107',
    'Cookie': COOKIE
  };
  if (clientId) apiHeaders['X-Client'] = clientId;
  if (signature) apiHeaders['X-Signature'] = signature;

  const apiRes = await fetch(`https://api.vidio.com/livestreamings/${channelId}/stream?initialize=true`, {
    headers: apiHeaders
  });

  if (!apiRes.ok) {
    const errBody = await apiRes.text();
    throw new Error(`Vidio API error: ${apiRes.status} - ${errBody} (pageStatus: ${pageStatus}, clientId: ${clientId || 'NONE'}, sig: ${signature ? 'FOUND' : 'NONE'})`);
  }

  const json = await apiRes.json();
  const attrs = json.data?.attributes;
  if (!attrs || (!attrs.hls && !attrs.dash)) {
    throw new Error('Vidio API did not return stream URLs');
  }

  const expiresIn = attrs.expires_in || 7200;
  tokenCache[channelId] = {
    hls: attrs.hls,
    dash: attrs.dash,
    expiresAt: now + ((expiresIn - 300) * 1000) // Auto-refresh 5 menit sebelum expire
  };

  return tokenCache[channelId];
}

function rewriteM3u8(content, manifestUrl, workerOrigin) {
  const origin = new URL(manifestUrl).origin;
  const baseDir = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
  const lines = content.split('\n');
  const rewritten = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    // Map tag like #EXT-X-MAP:URI="..."
    if (trimmed.startsWith('#EXT-X-MAP') && trimmed.includes('URI="')) {
      return trimmed.replace(/URI="([^"]+)"/, (m, uri) => {
        const abs = uri.startsWith('http') ? uri : (uri.startsWith('/') ? origin + uri : baseDir + uri);
        return `URI="${workerOrigin}/stream?url=${encodeURIComponent(abs)}"`;
      });
    }
    // Media tag like #EXT-X-MEDIA:... URI="..."
    if (trimmed.startsWith('#EXT-X-MEDIA') && trimmed.includes('URI="')) {
      return trimmed.replace(/URI="([^"]+)"/, (m, uri) => {
        const abs = uri.startsWith('http') ? uri : (uri.startsWith('/') ? origin + uri : baseDir + uri);
        return `URI="${workerOrigin}/stream?url=${encodeURIComponent(abs)}"`;
      });
    }
    if (trimmed.startsWith('#')) return line;
    // Segment or sub-playlist URL
    const abs = trimmed.startsWith('http') ? trimmed : (trimmed.startsWith('/') ? origin + trimmed : baseDir + trimmed);
    return `${workerOrigin}/stream?url=${encodeURIComponent(abs)}`;
  });
  return rewritten.join('\n');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const workerOrigin = url.origin;

    // Handle CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*'
        }
      });
    }

    // 1. Stream Segment & Sub-Playlist Reverse Proxy: /stream?url=...
    if (url.pathname === '/stream') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return new Response('Missing url param', { status: 400 });
      }

      try {
        const fetchHeaders = {
          'Origin': 'https://www.vidio.com',
          'Referer': 'https://www.vidio.com/',
          'User-Agent': USER_AGENT
        };
        const range = request.headers.get('range');
        if (range) fetchHeaders['Range'] = range;

        const upstreamRes = await fetch(targetUrl, { headers: fetchHeaders });
        const resHeaders = new Headers(upstreamRes.headers);
        resHeaders.set('Access-Control-Allow-Origin', '*');
        resHeaders.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
        resHeaders.set('Access-Control-Allow-Headers', '*');

        // Jika sub-playlist .m3u8, lakukan rewrite pada segmen-segmennya
        const isM3u8 = new URL(targetUrl).pathname.endsWith('.m3u8');
        if (isM3u8 || (resHeaders.get('content-type') || '').includes('mpegurl')) {
          const text = await upstreamRes.text();
          const rewritten = rewriteM3u8(text, targetUrl, workerOrigin);
          resHeaders.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
          return new Response(rewritten, { status: upstreamRes.status, headers: resHeaders });
        }

        // Segment video m4s / mp4 / ts dikirim langsung
        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          headers: resHeaders
        });
      } catch (e) {
        return new Response('Proxy Error: ' + e.message, { status: 502 });
      }
    }

    // 2. Channel Master Playlist: /:channelId.m3u8 atau /?id=1561
    const match = url.pathname.match(/^\/(?:live\/)?([a-zA-Z0-9_\-]+)(?:\.(m3u8|mpd))?/);
    const channelId = url.searchParams.get('id') || (match && match[1] !== 'favicon' ? match[1] : null);

    if (channelId) {
      try {
        const streamData = await getVidioStream(channelId);
        const upstreamRes = await fetch(streamData.hls, {
          headers: {
            'Origin': 'https://www.vidio.com',
            'Referer': 'https://www.vidio.com/',
            'User-Agent': USER_AGENT
          }
        });

        if (!upstreamRes.ok) {
          return new Response(`Upstream error: ${upstreamRes.status}`, { status: 502 });
        }

        const text = await upstreamRes.text();
        const rewritten = rewriteM3u8(text, streamData.hls, workerOrigin);

        return new Response(rewritten, {
          status: 200,
          headers: {
            'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache, no-store'
          }
        });
      } catch (err) {
        return new Response(`Error fetching stream: ${err.message}`, { status: 500 });
      }
    }

    return new Response('✅ Vidio Live Auto-Refresh Cloudflare Worker is ACTIVE!\n\nUsage: /<channelId>.m3u8\nExamples:\n- /1561.m3u8 (RTV)\n- /206.m3u8 (Indosiar)\n- /204.m3u8 (SCTV)', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
};

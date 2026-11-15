/**
 * Cloudflare Worker: Vision+ Stream & DRM License Proxy (Emon Architecture)
 * 
 * 1. DRM License Proxy (/vision/license?ch=...):
 *    - Menerima Widevine Challenge dari OTT Navigator / TiviMate
 *    - Otomatis request token JWT baru ke Vision+ API
 *    - Menembus server lisensi Verimatrix Multi-DRM MNC 24/7
 * 
 * 2. Media Stream Dispatcher (/vision/live/{ch}/index.mpd):
 *    - Menggunakan teknik 302 Redirect (seperti arsitektur Emon)
 *    - Memerintahkan TV (IP asli Indonesia) untuk menarik video langsung ke AWS CloudFront
 *    - Mencegah error "Geo-blocking / Blocked from your country"
 * 
 * 3. HLS Stream Proxy (/live/web/...):
 *    - Menembus proteksi Referer 403 untuk channel non-DRM (RCTI, MNCTV, tvN, dll)
 */

const CHANNEL_TARGETS = {
  '1002': {
    mediaUrl: 'multirights:mediapackage/live//EG_d2tjypxxy769fn/DASH/89a6e4261cd7470f83e5869e90440cff/00000000000000001002',
    mpd: 'https://d2tjypxxy769fn.cloudfront.net/out/v1/89a6e4261cd7470f83e5869e90440cff/index.mpd'
  },
  '1010': {
    mediaUrl: 'multirights:mediapackage/live//EG_d3b0v7fggu5zwm/DASH/d2c68a3dfb644808b416bd90dcc92d5f/00000000000000001010',
    mpd: 'https://d3b0v7fggu5zwm.cloudfront.net/out/v1/d2c68a3dfb644808b416bd90dcc92d5f/index.mpd'
  },
  '1012': {
    mediaUrl: 'multirights:mediapackage/live//EG_d3b0v7fggu5zwm/DASH/113af3d432214f62bd6815f976bf2cd6/00000000000000001012',
    mpd: 'https://d3b0v7fggu5zwm.cloudfront.net/out/v1/113af3d432214f62bd6815f976bf2cd6/index.mpd'
  }
};

const USER_SESSION_TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjQ5NzE4NTQ2LCJ0eSI6IlVTRVIiLCJwY2kiOiIxMTM2NjgxNTUiLCJod0lkIjoiNGY5OGM5ODUtMDZjNC00YTU5LTllMzYtOWMzMWM3OTI4OTcyIiwiZXhwIjoxNzk0NzU5OTg0LCJwbiI6Ik1OQyIsImNpZCI6MjE3Njc1NDg0fQ.-xxcGHur5coqsHujjSMqG2GWeU_RhUnWGV81pzjm-6Q';
const IRIS_HW_ID = '704b28f4-3924-4609-a29d-f79d02574943';
const IRIS_PROFILE_ID = '30098954';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:90.0) Gecko/20100101 Firefox/140.0';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle preflight OPTIONS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': '*'
        }
      });
    }

    // Sambutan jika dibuka langsung di browser
    if (path === '/' || path === '') {
      return new Response('Vision+ Stream & DRM License Proxy is RUNNING!\n\nEndpoints:\n- /vision/live/{1002|1010|1012}/index.mpd (302 Direct Stream)\n- /vision/license?ch={1002|1010|1012} (Auto DRM License)\n- /live/web/{channel}/index.m3u8 (Clean HLS)', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    // =========================================================================
    // 1. DRM License Proxy (Widevine Relay dengan Auto-Refresh Token)
    // =========================================================================
    if (path === '/vision/license' || path === '/license') {
      const channelId = url.searchParams.get('ch') || '1012';
      const chConfig = CHANNEL_TARGETS[channelId] || CHANNEL_TARGETS['1012'];
      const locatorUrl = `https://www.visionplus.id/streamlocators/multirights/getPlayableUrlAndLicense?adsProfile=premium&drm=WV&packaging=DASH&provisioningData=eyJwcm92aXNpb25pbmciOlt7InN5c3RlbSI6InZlcmltYXRyaXgiLCJkYXRhIjpbeyJuYW1lIjoidnVpZCIsInZhbHVlIjoiNzA0YjI4ZjQtMzkyNC00NjA5LWEyOWQtZjc5ZDAyNTc0OTQzIn1dfV19&url=${encodeURIComponent(chConfig.mediaUrl)}&userSessionToken=${USER_SESSION_TOKEN}`;

      try {
        const vRes = await fetch(locatorUrl, {
          headers: {
            'Accept': '*/*',
            'Authorization': USER_SESSION_TOKEN,
            'IRIS-DEVICE-CLASS': 'PC',
            'IRIS-DEVICE-TYPE': 'WINDOWS/CHROME',
            'IRIS-DEVICE-REGION': 'Indonesia',
            'IRIS-APP-VERSION': '11.4.13(0)_prd',
            'IRIS-APP-MODE': 'Normal',
            'IRIS-HW-DEVICE-ID': IRIS_HW_ID,
            'IRIS-PROFILE-ID': IRIS_PROFILE_ID,
            'Referer': 'https://www.visionplus.id/webclient/live',
            'User-Agent': BROWSER_UA
          }
        });
        const vJson = await vRes.json();
        const licUrl = vJson.videos?.[0]?.licenses?.[0]?.url;
        if (!licUrl) {
          return new Response(JSON.stringify({ error: 'No license URL found', raw: vJson }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const body = await request.arrayBuffer();
        const licenseRes = await fetch(licUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Origin': 'https://www.visionplus.id',
            'Referer': 'https://www.visionplus.id/',
            'User-Agent': BROWSER_UA
          },
          body: body
        });

        return new Response(licenseRes.body, {
          status: licenseRes.status,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*'
          }
        });
      } catch (err) {
        return new Response('Vision DRM Proxy Error: ' + err.message, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
    }

    // =========================================================================
    // 2. Media Stream Dispatcher (302 Redirect Anti-Geo-Blocking)
    // =========================================================================
    // Format: /vision/live/{ch}/index.mpd
    const liveMatch = path.match(/^\/vision\/live\/(\d+)\/?.*$/);
    if (liveMatch) {
      const chId = liveMatch[1];
      const chConfig = CHANNEL_TARGETS[chId] || CHANNEL_TARGETS['1012'];
      return Response.redirect(chConfig.mpd, 302);
    }

    // =========================================================================
    // 3. HLS Stream Proxy untuk Channel Non-DRM (proxy-v.rctiplus.id)
    // =========================================================================
    if (path === '/ts') {
      const q = url.searchParams.get('url');
      if (!q) return new Response('Missing url parameter', { status: 400 });
      try {
        const tsRes = await fetch(q, {
          headers: {
            'Referer': 'https://www.visionplus.id/',
            'Origin': 'https://www.visionplus.id',
            'User-Agent': BROWSER_UA
          }
        });
        return new Response(tsRes.body, {
          status: tsRes.status,
          headers: {
            'Content-Type': tsRes.headers.get('content-type') || 'video/MP2T',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (e) {
        return new Response('TS Proxy Error: ' + e.message, { status: 502 });
      }
    }

    const targetUrl = `https://proxy-v.rctiplus.id${path}${url.search}`;

    try {
      const response = await fetch(targetUrl, {
        headers: {
          'Referer': 'https://www.visionplus.id/',
          'Origin': 'https://www.visionplus.id',
          'User-Agent': BROWSER_UA
        }
      });

      if (!response.ok) {
        return new Response(response.body, {
          status: response.status,
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      }

      const contentType = response.headers.get('content-type') || '';

      // Rewrite file .m3u8 agar request segmen .ts tetap lewat Worker
      if (path.endsWith('.m3u8') || contentType.includes('mpegurl')) {
        let text = await response.text();
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

        const rewritten = text.split('\n').map(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return line;
          let fullUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
          return `${url.origin}/ts?url=${encodeURIComponent(fullUrl)}`;
        }).join('\n');

        return new Response(rewritten, {
          headers: {
            'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache, no-store'
          }
        });
      }

      // Potongan video .ts
      return new Response(response.body, {
        status: response.status,
        headers: {
          'Content-Type': contentType || 'video/MP2T',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (err) {
      return new Response('Worker Proxy Error: ' + err.message, { status: 500 });
    }
  }
};

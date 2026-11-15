/**
 * Cloudflare Worker: Vision+ & RCTI+ Stream & License Proxy
 * Menembus proteksi Referer 403 Forbidden & Widevine Token Expiration 24/7.
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle preflight OPTIONS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*'
        }
      });
    }

    // Halaman sambutan jika dibuka di browser biasa
    if (path === '/' || path === '') {
      return new Response('Vision+ Stream Proxy Worker is Running! Silakan panggil path channel, contoh: /live/web/antv/512.m3u8', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    // A. Vision+ Widevine DRM License Proxy (Auto-Refresh Token 24/7)
    if (path === '/vision/license' || path === '/license') {
      const channelId = url.searchParams.get('ch') || '1002';
      const mediaMap = {
        '1002': 'multirights:mediapackage/live//EG_d2tjypxxy769fn/DASH/89a6e4261cd7470f83e5869e90440cff/00000000000000001002',
        '1010': 'multirights:mediapackage/live//EG_d2tjypxxy769fn/DASH/89a6e4261cd7470f83e5869e90440cff/00000000000000001010',
        '1012': 'multirights:mediapackage/live//EG_d2xz2v5wuvgur6/DASH/63c0da12bb4d48afbaf053f51dff2353/HLS/b9fc626578f34e0db7ff123168ace53a/00000000000000001012/00000000000000000115'
      };
      const mediaUrl = mediaMap[channelId] || mediaMap['1002'];
      const locatorUrl = `https://www.visionplus.id/streamlocators/multirights/getPlayableUrlAndLicense?adsProfile=premium&drm=WV&packaging=DASH&provisioningData=eyJwcm92aXNpb25pbmciOlt7InN5c3RlbSI6InZlcmltYXRyaXgiLCJkYXRhIjpbeyJuYW1lIjoidnVpZCIsInZhbHVlIjoiNzA0YjI4ZjQtMzkyNC00NjA5LWEyOWQtZjc5ZDAyNTc0OTQzIn1dfV19&url=${encodeURIComponent(mediaUrl)}&userSessionToken=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjQ5NzE4NTQ2LCJ0eSI6IlVTRVIiLCJwY2kiOiIxMTM2NjgxNTUiLCJod0lkIjoiNzA0YjI4ZjQtMzkyNC00NjA5LWEyOWQtZjc5ZDAyNTc0OTQzIiwiZXhwIjoxNzk0NzMwNDM3LCJwbiI6Ik1OQyIsImNpZCI6MjE3Njc1NDg0fQ.ct558TfZFXTX3_t_2tq_YKDbXfaiV3ZCDPrwtx9hl4M`;

      try {
        const vRes = await fetch(locatorUrl, {
          headers: {
            'Accept': '*/*',
            'Authorization': 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjQ5NzE4NTQ2LCJ0eSI6IlVTRVIiLCJwY2kiOiIxMTM2NjgxNTUiLCJod0lkIjoiNzA0YjI4ZjQtMzkyNC00NjA5LWEyOWQtZjc5ZDAyNTc0OTQzIiwiZXhwIjoxNzk0NzMwNDM3LCJwbiI6Ik1OQyIsImNpZCI6MjE3Njc1NDg0fQ.ct558TfZFXTX3_t_2tq_YKDbXfaiV3ZCDPrwtx9hl4M',
            'IRIS-DEVICE-CLASS': 'PC',
            'IRIS-DEVICE-TYPE': 'WINDOWS/CHROME',
            'IRIS-DEVICE-REGION': 'Indonesia',
            'IRIS-APP-VERSION': '11.4.13(0)_prd',
            'IRIS-APP-MODE': 'Normal',
            'IRIS-HW-DEVICE-ID': '704b28f4-3924-4609-a29d-f79d02574943',
            'IRIS-PROFILE-ID': '30098954',
            'Referer': 'https://www.visionplus.id/webclient/live',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        const vJson = await vRes.json();
        const licUrl = vJson.videos?.[0]?.licenses?.[0]?.url;
        if (!licUrl) return new Response('No license URL found', { status: 500 });

        const body = await request.arrayBuffer();
        const licenseRes = await fetch(licUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Origin': 'https://www.visionplus.id',
            'Referer': 'https://www.visionplus.id/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          body: body
        });

        return new Response(licenseRes.body, {
          status: licenseRes.status,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (err) {
        return new Response('Vision License Error: ' + err.message, { status: 500 });
      }
    }

    // 1. Tentukan target URL
    let targetUrl = '';
    if (path === '/ts') {
      const q = url.searchParams.get('url');
      if (!q) return new Response('Missing url parameter', { status: 400 });
      targetUrl = q;
    } else {
      targetUrl = `https://proxy-v.rctiplus.id${path}`;
    }

    try {
      // 2. Tembak ke Vision+ dengan header Referer resmi
      const response = await fetch(targetUrl, {
        headers: {
          'Referer': 'https://www.visionplus.id/',
          'Origin': 'https://www.visionplus.id',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!response.ok) {
        return new Response(response.body, {
          status: response.status,
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      }

      const contentType = response.headers.get('content-type') || '';

      // 3. Jika file .m3u8, rewrite link video .ts agar tetap lewat Worker
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

      // 4. Jika potongan video (.ts), teruskan datanya ke TV
      return new Response(response.body, {
        status: response.status,
        headers: {
          'Content-Type': contentType || 'video/MP2T',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (err) {
      return new Response('Worker Error: ' + err.message, { status: 500 });
    }
  }
};

/**
 * Cloudflare Worker: Vision+ & RCTI+ Stream Proxy
 * Menembus proteksi Referer 403 Forbidden secara otomatis 24/7.
 * 
 * Penggunaan di TV:
 * https://<nama-worker-anda>.workers.dev/live/web/antv/512.m3u8
 * https://<nama-worker-anda>.workers.dev/live/web/trans7/512.m3u8
 * https://<nama-worker-anda>.workers.dev/live/web/tvone/512.m3u8
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Halaman sambutan jika dibuka di browser biasa
    if (path === '/' || path === '') {
      return new Response('Vision+ Stream Proxy Worker is Running! Silakan panggil path channel, contoh: /live/web/antv/512.m3u8', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
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


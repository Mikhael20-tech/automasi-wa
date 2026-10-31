const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 8765;
const ROOT_DIR = path.basename(__dirname) === 'tv' ? path.resolve(__dirname, '..') : __dirname;
const TV_DIR = path.join(ROOT_DIR, 'tv');

// Category mapping for VisionPlus channels
const categoryMap = {
  'RCTI': 'Nasional', 'MNCTV': 'Nasional', 'GTV': 'Nasional', 'iNews': 'Nasional',
  'SindoNews': 'Nasional', 'Trans TV': 'Nasional', 'Trans 7': 'Nasional', 'SCTV': 'Nasional',
  'Indosiar': 'Nasional', 'ANTV': 'Nasional', 'RTV': 'Nasional', 'TVOne': 'Nasional',
  'Kompas TV': 'Nasional', 'Metro TV': 'Nasional', 'BTV': 'Nasional', 'TVRI': 'Nasional',
  'DAAI TV': 'Nasional', 'Moji': 'Nasional', 'Mentari TV': 'Nasional', 'MDTV': 'Nasional',
  'JTV': 'Daerah', 'JAK TV': 'Daerah', 'Bali TV': 'Daerah', 'Bandung TV': 'Daerah', 'TV 9': 'Daerah',
  'DMI TV': 'Religi', 'TV MU': 'Religi', 'Muslim TV': 'Religi', 'LIFE': 'Religi', 'Reformed 21': 'Religi',
  'Originals': 'Movies', 'Buddy Star': 'Movies', 'Uniques': 'Movies', 'Superrix': 'Movies',
  'Cineedge': 'Movies', 'Thrill': 'Movies', 'Hits Movies': 'Movies', 'Celestial Movies': 'Movies',
  'CCM': 'Movies', 'TVN Movies': 'Movies', 'Zee Bioskop': 'Movies', 'GALAXY PREMIUM': 'Movies',
  'GALAXY': 'Movies', 'IMC': 'Movies', 'Studio Universal': 'Movies',
  'Kids TV': 'Kids', 'Moonbug': 'Kids', 'Cbeebies': 'Kids', 'Nick Jr': 'Kids', 'Zoo Moo': 'Kids',
  'Nick': 'Kids', 'Animax': 'Kids & Anime', 'Dream Works': 'Kids',
  'HITS Now': 'Entertainment', 'Formosa': 'Entertainment', 'Sanlih': 'Entertainment',
  'Food Travel': 'Entertainment', 'Entertainment': 'Entertainment', 'TVN': 'Entertainment',
  'Kix': 'Entertainment', 'Hits': 'Entertainment', 'AXN': 'Entertainment', 'Lifetime': 'Entertainment',
  'Vision Prime': 'Entertainment', 'Celebrities TV': 'Entertainment', 'Rock Entertainment': 'Entertainment',
  'Rock Action': 'Entertainment', 'Drama World': 'Entertainment', 'RCTI World': 'Entertainment',
  'Sportstars 3': 'Sports', 'Soccer Channel': 'Sports', 'SpoTV 1': 'Sports', 'SpoTV 2': 'Sports',
  'Fight Sports': 'Sports', 'beIN SPORTS': 'Sports', 'beIN SPORTS 2': 'Sports', 'beIN SPORTS 3': 'Sports',
  'BBC Earth': 'Documentary', 'Global Trekker': 'Documentary', 'History': 'Documentary',
  'Love Nature': 'Documentary', 'CGTN Documentary': 'Documentary', 'Music TV': 'Music',
  'BBC World news': 'News', 'CNBC Asia': 'News', 'FOX News': 'News', 'Bloomberg': 'News', 'IDX': 'News',
  'DW': 'Internasional', 'France 24': 'Internasional', 'TRT World': 'Internasional', 'Aljazeera': 'Internasional',
  'RT': 'Internasional', 'EURONEWS': 'Internasional', 'Channel News Asia': 'Internasional', 'NHK': 'Internasional',
  'NHK World Premium': 'Internasional', 'TV5Monde': 'Internasional', 'Arirang': 'Internasional'
};

// MIME types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.m3u': 'application/vnd.apple.mpegurl; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl; charset=utf-8',
  '.mpd': 'application/dash+xml; charset=utf-8'
};

// Cached live playlist
let cachedPlaylist = null;
let lastPlaylistFetch = 0;

/**
 * Rewrite a DASH MPD manifest:
 * 1. Convert all relative segment/init URLs to absolute URLs using the MPD's base URL
 * 2. Wrap those absolute URLs through our /stream/ proxy so CORS headers are added
 * 3. Remove Widevine & PlayReady ContentProtection elements so Shaka falls back to ClearKey
 */
function rewriteMpd(mpdText, mpdUrl, host) {
  // Derive the base URL from the MPD URL (directory of the MPD)
  const lastSlash = mpdUrl.lastIndexOf('/');
  const baseUrl = lastSlash !== -1 ? mpdUrl.substring(0, lastSlash + 1) : mpdUrl;

  let rewritten = mpdText;

  // Remove Widevine ContentProtection (so Shaka won't try Widevine license)
  rewritten = rewritten.replace(
    /<ContentProtection\s+schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"[^/]*\/>/g, ''
  );
  // Remove PlayReady ContentProtection
  rewritten = rewritten.replace(
    /<ContentProtection\s+schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"[^/]*\/>/g, ''
  );

  // Rewrite SegmentTemplate media/init attributes to absolute proxied URLs
  rewritten = rewritten.replace(
    /(\s(?:media|initialization))="([^"]+)"/g,
    (match, attr, value) => {
      if (value.startsWith('http://') || value.startsWith('https://')) {
        return `${attr}="http://${host}/stream/${value}"`;
      }
      const absUrl = baseUrl + value;
      return `${attr}="http://${host}/stream/${absUrl}"`;
    }
  );

  // Rewrite BaseURL elements
  rewritten = rewritten.replace(
    /<BaseURL>([^<]+)<\/BaseURL>/g,
    (match, url) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        return `<BaseURL>http://${host}/stream/${url}</BaseURL>`;
      }
      const absUrl = baseUrl + url;
      return `<BaseURL>http://${host}/stream/${absUrl}</BaseURL>`;
    }
  );

  return rewritten;
}

async function getLiveVisionPlusPlaylist(host) {
  const processed = ['#EXTM3U url-tvg="https://bit.ly/IndonesiaEpg"'];

  // 1. Add verified 100% active DRM Channels (MPEG-DASH with ClearKey Decryption)
  try {
    const drmJsonPath = [
      path.join(TV_DIR, 'working_drm_channels.json'),
      path.join(ROOT_DIR, 'working_drm_channels.json')
    ].find(p => fs.existsSync(p));

    if (drmJsonPath) {
      const drmChannels = JSON.parse(fs.readFileSync(drmJsonPath, 'utf8'));
      for (const ch of drmChannels) {
        processed.push(`#KODIPROP:inputstream.adaptive.license_type=clearkey`);
        processed.push(`#KODIPROP:inputstream.adaptive.license_key=${ch.key}`);
        processed.push(`#EXTINF:-1 tvg-id="${ch.name}" tvg-logo="${ch.logo}" group-title="${ch.group || 'Sports & Racing (DRM)'}",${ch.name}`);
        if (ch.needsProxy) {
          processed.push(`http://${host}/mpd-proxy/${ch.url}`);
        } else {
          processed.push(ch.url);
        }
      }
    }
  } catch (e) {
    console.warn('[Playlist] Error loading working_drm_channels:', e.message);
  }

  // 2. Add verified 100% active Web Channels (HLS Bebas DRM)
  try {
    const workingJsonPath = [
      path.join(TV_DIR, 'working_web_channels.json'),
      path.join(ROOT_DIR, 'working_web_channels.json')
    ].find(p => fs.existsSync(p));

    if (workingJsonPath) {
      const webChannels = JSON.parse(fs.readFileSync(workingJsonPath, 'utf8'));
      for (const ch of webChannels) {
        processed.push(`#EXTINF:-1 tvg-id="${ch.name}" tvg-logo="${ch.logo}" group-title="${ch.group || 'TV Nasional (Bebas DRM)'}",${ch.name}`);
        processed.push(`http://${host}/stream/${ch.url}`);
      }
    }
  } catch (e) {
    console.warn('[Playlist] Error loading working_web_channels:', e.message);
  }

  cachedPlaylist = processed.join('\n');
  return cachedPlaylist;
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;

  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  const rawUrl = req.url;

  // 1. VisionPlus Live Playlist: /api/visionplus.m3u or /tv/api/visionplus.m3u
  if (rawUrl.startsWith('/api/visionplus.m3u') || rawUrl.startsWith('/tv/api/visionplus.m3u')) {
    try {
      const playlist = await getLiveVisionPlusPlaylist(host);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      });
      res.end(playlist);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Error loading playlist: ' + e.message);
    }
    return;
  }

  // 2. MPD Proxy: /mpd-proxy/https://... — Rewrites DASH manifest
  //    Strips Widevine DRM, makes segment URLs absolute and proxied
  const mpdPrefixes = ['/mpd-proxy/', '/tv/mpd-proxy/'];
  const mpdPrefix = mpdPrefixes.find(p => rawUrl.startsWith(p));
  if (mpdPrefix) {
    const targetUrl = rawUrl.substring(mpdPrefix.length);
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Invalid MPD URL: ' + targetUrl);
      return;
    }

    try {
      console.log('[MPD Proxy] Fetching & rewriting:', targetUrl);
      const fetchHeaders = {
        'Origin': 'https://www.visionplus.id',
        'Referer': 'https://www.visionplus.id/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
      };

      const remoteRes = await fetch(targetUrl, { headers: fetchHeaders });
      if (!remoteRes.ok) {
        res.writeHead(remoteRes.status, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('MPD upstream error: ' + remoteRes.status);
        return;
      }

      const mpdText = await remoteRes.text();
      const rewritten = rewriteMpd(mpdText, targetUrl, host);

      res.writeHead(200, {
        'Content-Type': 'application/dash+xml; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store'
      });
      res.end(rewritten);
    } catch (err) {
      console.error('[MPD Proxy Error]', targetUrl, err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('MPD Proxy Error: ' + err.message);
      }
    }
    return;
  }

  // 3. Stream Proxy: /stream/https://... or /tv/stream/https://...
  if (rawUrl.startsWith('/stream/') || rawUrl.startsWith('/tv/stream/')) {
    const prefix = rawUrl.startsWith('/tv/stream/') ? '/tv/stream/' : '/stream/';
    const targetUrl = rawUrl.substring(prefix.length);
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Invalid stream URL: ' + targetUrl);
      return;
    }

    try {
      const fetchHeaders = {
        'Origin': 'https://www.visionplus.id',
        'Referer': 'https://www.visionplus.id/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
      };

      if (req.headers['range']) {
        fetchHeaders['Range'] = req.headers['range'];
      }

      const remoteRes = await fetch(targetUrl, {
        method: req.method,
        headers: fetchHeaders
      });

      const responseHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
        'Access-Control-Allow-Headers': '*',
        'Content-Type': remoteRes.headers.get('content-type') || 'application/octet-stream'
      };

      if (remoteRes.headers.has('content-length')) {
        responseHeaders['Content-Length'] = remoteRes.headers.get('content-length');
      }
      if (remoteRes.headers.has('accept-ranges')) {
        responseHeaders['Accept-Ranges'] = remoteRes.headers.get('accept-ranges');
      }
      if (remoteRes.headers.has('content-range')) {
        responseHeaders['Content-Range'] = remoteRes.headers.get('content-range');
      }

      res.writeHead(remoteRes.status, responseHeaders);

      const buffer = await remoteRes.arrayBuffer();
      res.end(Buffer.from(buffer));
    } catch (err) {
      console.error('[StreamProxy Error]', targetUrl, err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('Stream Proxy Error: ' + err.message);
      }
    }
    return;
  }

  // 4. License Proxy: /license/https://... or /tv/license/https://...
  if (rawUrl.startsWith('/license/') || rawUrl.startsWith('/tv/license/')) {
    const prefix = rawUrl.startsWith('/tv/license/') ? '/tv/license/' : '/license/';
    const targetUrl = rawUrl.substring(prefix.length);
    try {
      // Collect request body chunks from CDM
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const bodyBuffer = Buffer.concat(chunks);

      const fetchHeaders = {
        'Origin': 'https://www.visionplus.id',
        'Referer': 'https://www.visionplus.id/',
        'Content-Type': req.headers['content-type'] || 'application/octet-stream',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      };

      const remoteRes = await fetch(targetUrl, {
        method: req.method,
        headers: fetchHeaders,
        body: req.method === 'POST' ? bodyBuffer : undefined
      });

      const responseHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Content-Type': remoteRes.headers.get('content-type') || 'application/octet-stream'
      };

      res.writeHead(remoteRes.status, responseHeaders);
      const resBuffer = await remoteRes.arrayBuffer();
      res.end(Buffer.from(resBuffer));
    } catch (err) {
      console.error('[LicenseProxy Error]', targetUrl, err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('License Proxy Error: ' + err.message);
      }
    }
    return;
  }

  // 5. Static Files
  let pathname = new URL(req.url, `http://${host}`).pathname;
  if (pathname === '/' || pathname === '' || pathname === '/tv' || pathname === '/tv/') {
    pathname = '/tv/index.html';
  }

  // Resolve file from TV_DIR or ROOT_DIR
  let filePath = null;
  if (pathname.startsWith('/tv/')) {
    const relTvPath = pathname.substring(4); // e.g. "index.html", "style.css", "app.js"
    const cand1 = path.join(TV_DIR, decodeURIComponent(relTvPath));
    const cand2 = path.join(ROOT_DIR, decodeURIComponent(pathname));
    if (fs.existsSync(cand1) && fs.statSync(cand1).isFile()) {
      filePath = cand1;
    } else if (fs.existsSync(cand2) && fs.statSync(cand2).isFile()) {
      filePath = cand2;
    }
  } else {
    const cand1 = path.join(TV_DIR, decodeURIComponent(pathname));
    const cand2 = path.join(ROOT_DIR, decodeURIComponent(pathname));
    if (fs.existsSync(cand1) && fs.statSync(cand1).isFile()) {
      filePath = cand1;
    } else if (fs.existsSync(cand2) && fs.statSync(cand2).isFile()) {
      filePath = cand2;
    }
  }

  if (!filePath) {
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('File Not Found: ' + pathname);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  VisionPlus & TV Streaming Server is LIVE!`);
  console.log(`  URL: http://localhost:${PORT}/tv/index.html`);
  console.log(`  Live Playlist: http://localhost:${PORT}/api/visionplus.m3u`);
  console.log(`  MPD Proxy: http://localhost:${PORT}/mpd-proxy/<dash-url>`);
  console.log(`=======================================================`);
});

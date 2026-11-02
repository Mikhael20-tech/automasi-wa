/**
 * NusaTV & VisionPlus — Modern Web TV Streaming Client
 * Powered by Google Shaka Player (MPEG-DASH & ClearKey DRM) + Hls.js Fallback
 */

// ============================================================
// State
// ============================================================
const state = {
  channels: [],
  groups: [],
  filteredChannels: [],
  currentChannelIdx: -1,
  activeGroup: 'all',
  searchQuery: '',
  shakaPlayer: null,
  hlsInstance: null,
  retryCount: 0,
  maxRetry: 3,
  isSwitching: false
};

// ============================================================
// DOM References
// ============================================================
const $ = id => document.getElementById(id);
const video = $('video-player');
const sidebar = $('sidebar');
const channelList = $('channel-list');
const groupTabs = $('group-tabs');
const searchInput = $('search-input');
const toast = $('toast');

// ============================================================
// Utility Helpers
// ============================================================
function esc(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m]);
}

function initials(name) {
  if (!name) return 'TV';
  const clean = name.replace(/[^a-zA-Z0-9 ]/g, '').trim();
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return clean.substring(0, 2).toUpperCase() || 'TV';
}

function showToast(msg, duration = 3000) {
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), duration);
}

function showBuffering() {
  const el = $('buffering-overlay');
  if (el) el.style.display = 'flex';
}

function hideBuffering() {
  const el = $('buffering-overlay');
  if (el) el.style.display = 'none';
}

function showStreamError(msg) {
  const errEl = $('stream-error');
  const msgEl = $('error-msg');
  if (errEl) errEl.style.display = 'flex';
  if (msgEl) msgEl.textContent = msg || 'Mencoba stream alternatif...';
  hideBuffering();
}

function hideError() {
  const errEl = $('stream-error');
  if (errEl) errEl.style.display = 'none';
}

// ============================================================
// M3U Parser with DRM & Headers
// ============================================================
function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  const channelMap = {};

  let currentMeta = null;
  let pendingDrm = null;
  let pendingHdr = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // 1. DRM Info (#KODIPROP)
    if (line.startsWith('#KODIPROP:')) {
      if (!pendingDrm) pendingDrm = {};
      const kv = line.substring('#KODIPROP:'.length);
      const eq = kv.indexOf('=');
      if (eq !== -1) {
        const k = kv.substring(0, eq).trim();
        const v = kv.substring(eq + 1).trim();
        if (k === 'inputstream.adaptive.license_type') pendingDrm.type = v;
        if (k === 'inputstream.adaptive.license_key') pendingDrm.key = v;
      }
      continue;
    }

    // 2. HTTP Headers (#EXTVLCOPT)
    if (line.startsWith('#EXTVLCOPT:')) {
      const kv = line.substring('#EXTVLCOPT:'.length);
      const eq = kv.indexOf('=');
      if (eq !== -1) {
        const k = kv.substring(0, eq).toLowerCase();
        const v = kv.substring(eq + 1);
        if (k === 'http-referrer' || k === 'http-referer') pendingHdr.referer = v;
        if (k === 'http-user-agent') pendingHdr.userAgent = v;
        if (k === 'http-origin') pendingHdr.origin = v;
      }
      continue;
    }

    // 3. Channel Info (#EXTINF)
    if (line.startsWith('#EXTINF:')) {
      currentMeta = parseExtInf(line);
      continue;
    }

    // 4. Stream URL
    if (currentMeta && !line.startsWith('#')) {
      let finalUrl = line.trim();

      // Unwrap direct streams from unnecessary proxies (fixes Vercel Mixed Content & slash collapses)
      if (finalUrl.includes('/stream/https://')) {
        finalUrl = finalUrl.substring(finalUrl.indexOf('/stream/https://') + '/stream/'.length);
      } else if (finalUrl.includes('/stream/https:/')) {
        finalUrl = 'https://' + finalUrl.substring(finalUrl.indexOf('/stream/https:/') + '/stream/https:/'.length);
      } else if (finalUrl.includes('/mpd-proxy/https://')) {
        if (window.location.hostname.includes('vercel.app')) {
          finalUrl = finalUrl.substring(finalUrl.indexOf('/mpd-proxy/https://') + '/mpd-proxy/'.length);
        }
      }

      // Auto rewrite VPS HTTP URLs to HTTPS via Vercel proxy rewrite
      if (window.location.protocol === 'https:' && finalUrl.includes('72.60.79.72:8765')) {
        finalUrl = finalUrl.replace(/https?:\/\/72\.60\.79\.72:8765/, window.location.origin);
      }
      if (pendingDrm && pendingDrm.key && pendingDrm.key.includes('72.60.79.72:8765')) {
        pendingDrm.key = pendingDrm.key.replace(/https?:\/\/72\.60\.79\.72:8765/, window.location.origin);
      }

      // If page is on HTTPS, ensure proxy URLs use https:
      if (window.location.protocol === 'https:' && finalUrl.startsWith('http://' + window.location.host)) {
        finalUrl = finalUrl.replace('http://', 'https://');
      }

      const type = detectStreamType(finalUrl);
      const drmObj = parseDrmObj(pendingDrm);
      const stream = {
        url: finalUrl,
        type,
        drm: drmObj,
        headers: { ...pendingHdr }
      };

      const key = currentMeta.name.trim().toLowerCase();

      if (channelMap[key]) {
        channelMap[key].streams.push(stream);
      } else {
        const ch = {
          id: channels.length,
          name: currentMeta.name,
          group: currentMeta.group || 'Lainnya',
          logo: currentMeta.logo || '',
          tvgId: currentMeta.tvgId || '',
          streams: [stream],
          activeStream: 0
        };
        channels.push(ch);
        channelMap[key] = ch;
      }

      currentMeta = null;
      pendingDrm = null;
      pendingHdr = {};
      continue;
    }

    // Reset meta if unexpected non-comment line
    if (line.startsWith('#') && !line.startsWith('#KODIPROP') && !line.startsWith('#EXTVLCOPT') && !line.startsWith('#EXTINF')) {
      currentMeta = null;
      pendingDrm = null;
      pendingHdr = {};
    }
  }

  return channels;
}

function parseExtInf(line) {
  const result = { name: '', group: '', logo: '', tvgId: '' };
  const commaIdx = line.indexOf(',');
  if (commaIdx !== -1) result.name = line.substring(commaIdx + 1).trim();
  const attrStr = commaIdx !== -1 ? line.substring(0, commaIdx) : line;

  const logoMatch = attrStr.match(/tvg-logo="([^"]*)"/);
  if (logoMatch) result.logo = logoMatch[1];

  const groupMatch = attrStr.match(/group-title="([^"]*)"/);
  if (groupMatch) result.group = groupMatch[1];

  const tvgIdMatch = attrStr.match(/tvg-id="([^"]*)"/);
  if (tvgIdMatch) result.tvgId = tvgIdMatch[1];

  return result;
}

function detectStreamType(url) {
  const u = url.toLowerCase().split('?')[0];
  if (u.endsWith('.mpd')) return 'dash';
  return 'hls';
}

function parseDrmObj(raw) {
  if (!raw || !raw.type) return null;
  const t = raw.type.toLowerCase();

  // ClearKey: "hex_kid:hex_key"
  if (t === 'org.w3.clearkey' || t === 'clearkey') {
    const pairs = {};
    if (raw.key && raw.key.includes(':') && !raw.key.startsWith('http')) {
      const parts = raw.key.split(':');
      if (parts.length >= 2) {
        const kid = parts[0].replace(/-/g, '').toLowerCase();
        const key = parts[1].replace(/-/g, '').toLowerCase();
        pairs[kid] = key;
      }
    }
    return { drmType: 'clearkey', clearkeys: Object.keys(pairs).length ? pairs : null, licenseUrl: null };
  }

  // Google Widevine Modular DRM
  if (t === 'com.widevine.alpha') {
    return { drmType: 'widevine', clearkeys: null, licenseUrl: raw.key || null };
  }

  return null;
}

// ============================================================
// Playlist Loading
// ============================================================
async function loadPlaylist() {
  const urls = [
    '/playlist.m3u',
    '../playlist.m3u',
    'playlist.m3u',
    'https://gist.githubusercontent.com/Mikhael20-tech/28af0cc656510032cdab4f311c0af4f4/raw/iptv.m3u',
    '/akmatv.m3u',
    '../akmatv.m3u'
  ];

  let text = null;
  for (const url of urls) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        text = await resp.text();
        console.log('[NusaTV] Playlist loaded successfully from:', url);
        break;
      }
    } catch (e) {
      // Continue to fallback
    }
  }

  if (!text) {
    channelList.innerHTML = `
      <div class="loading-channels">
        <p style="color:#ef4444">❌ Gagal memuat playlist</p>
        <p style="margin-top:8px;font-size:0.75rem">Pastikan server proxy aktif (node server.js di port 8765)</p>
        <button onclick="loadPlaylist()" class="retry-btn" style="margin-top:12px">🔄 Coba Lagi</button>
      </div>`;
    return;
  }

  state.channels = parseM3U(text);
  buildGroups();
  renderGroupTabs();
  filterAndRender();

  showToast(`✅ ${state.channels.length} channel berhasil dimuat!`);
  const countLabel = $('channel-count-label');
  if (countLabel) countLabel.textContent = `${state.channels.length} channel`;
}

function buildGroups() {
  const groupSet = new Set();
  state.channels.forEach(ch => {
    if (ch.group) groupSet.add(ch.group);
  });
  state.groups = Array.from(groupSet).sort();
}

function renderGroupTabs() {
  const existingBtns = groupTabs.querySelectorAll('.group-tab:not([data-group="all"])');
  existingBtns.forEach(b => b.remove());

  state.groups.forEach(group => {
    const btn = document.createElement('button');
    btn.className = 'group-tab';
    btn.dataset.group = group;
    btn.textContent = group.length > 20 ? group.substring(0, 18) + '…' : group;
    btn.title = group;
    groupTabs.appendChild(btn);
  });

  groupTabs.onclick = e => {
    const btn = e.target.closest('.group-tab');
    if (!btn) return;
    groupTabs.querySelectorAll('.group-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.activeGroup = btn.dataset.group;
    state.searchQuery = '';
    if (searchInput) searchInput.value = '';
    filterAndRender();
  };
}

function filterAndRender() {
  const q = state.searchQuery.toLowerCase();
  state.filteredChannels = state.channels.filter(ch => {
    const inGroup = state.activeGroup === 'all' || ch.group === state.activeGroup;
    const matchSearch = !q || ch.name.toLowerCase().includes(q) || ch.group.toLowerCase().includes(q);
    return inGroup && matchSearch;
  });

  renderChannelList();
  const countLabel = $('channel-count-label');
  if (countLabel) countLabel.textContent = `${state.filteredChannels.length} channel`;
}

function renderChannelList() {
  if (state.filteredChannels.length === 0) {
    channelList.innerHTML = '<div class="loading-channels"><p>Tidak ada channel ditemukan</p></div>';
    return;
  }

  const grouped = {};
  state.filteredChannels.forEach(ch => {
    if (!grouped[ch.group]) grouped[ch.group] = [];
    grouped[ch.group].push(ch);
  });

  const showHeaders = state.activeGroup === 'all';
  const currentId = state.channels[state.currentChannelIdx]?.id ?? -1;
  let html = '';

  Object.entries(grouped).forEach(([group, channels]) => {
    if (showHeaders) html += `<div class="group-header">${esc(group)}</div>`;
    channels.forEach(ch => {
      const isActive = ch.id === currentId;
      const s0 = ch.streams[ch.activeStream] || ch.streams[0];
      const drmType = s0?.drm?.drmType;
      const drmBadge = drmType === 'widevine'
        ? `<span class="drm-badge widevine" title="Widevine DRM (Google Shaka)">🔐 Widevine</span>`
        : drmType === 'clearkey'
        ? `<span class="drm-badge clearkey" title="ClearKey DRM">🔑 ClearKey</span>`
        : '';

      const logoHtml = ch.logo
        ? `<img class="channel-logo" src="${esc(ch.logo)}" alt="${esc(ch.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling&&(this.nextElementSibling.style.display='flex')" /><div class="channel-logo-fallback" style="display:none">${initials(ch.name)}</div>`
        : `<div class="channel-logo-fallback">${initials(ch.name)}</div>`;

      html += `
        <div class="channel-item${isActive ? ' active' : ''}" data-id="${ch.id}" role="button" tabindex="0">
          ${logoHtml}
          <div class="channel-text">
            <div class="channel-name">${esc(ch.name)}</div>
            <div class="channel-group-label">${esc(ch.group)}</div>
          </div>
          ${drmBadge}
          ${ch.streams.length > 1 ? `<span class="streams-badge" title="${ch.streams.length} Stream">${ch.streams.length}</span>` : ''}
        </div>`;
    });
  });

  channelList.innerHTML = html;

  channelList.querySelectorAll('.channel-item').forEach(el => {
    el.onclick = () => playChannelById(+el.dataset.id);
    el.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') playChannelById(+el.dataset.id);
    };
  });
}

// ============================================================
// Playback Engine (Shaka Player with Fallbacks)
// ============================================================
function playChannelById(id) {
  const idx = state.channels.findIndex(ch => ch.id === id);
  if (idx === -1) return;
  state.currentChannelIdx = idx;
  state.retryCount = 0;
  state.channels[idx].activeStream = 0;
  playCurrentStream();
}

async function destroyPlayers() {
  if (state.shakaPlayer) {
    try {
      await state.shakaPlayer.destroy();
    } catch (e) {
      console.warn('[Shaka] Error destroying player:', e);
    }
    state.shakaPlayer = null;
  }

  if (state.hlsInstance) {
    try {
      state.hlsInstance.destroy();
    } catch (e) {
      console.warn('[Hls] Error destroying player:', e);
    }
    state.hlsInstance = null;
  }

  video.pause();
  video.removeAttribute('src');
  video.load();
}

async function playCurrentStream() {
  if (state.isSwitching) return;
  state.isSwitching = true;

  const ch = state.channels[state.currentChannelIdx];
  if (!ch) {
    state.isSwitching = false;
    return;
  }

  const stream = ch.streams[ch.activeStream];
  if (!stream) {
    showStreamError('Tidak ada stream tersedia.');
    state.isSwitching = false;
    return;
  }

  updateNowPlaying(ch);
  markActiveChannel(ch.id);
  hideError();
  showBuffering();

  await destroyPlayers();

  const drmLabel = stream.drm
    ? (stream.drm.drmType === 'widevine' ? ' 🔐 WV' : ' 🔑 CK')
    : '';
  const qualityLabel = $('stream-quality-label');
  if (qualityLabel) {
    qualityLabel.textContent = `Stream ${ch.activeStream + 1}/${ch.streams.length} · ${stream.type.toUpperCase()}${drmLabel}`;
  }

  console.log(`[NusaTV] Memutar channel: ${ch.name} (Stream #${ch.activeStream + 1}) URL: ${stream.url}`);

  try {
    // Use Shaka Player for DASH (.mpd) or DRM-encrypted streams
    if (stream.type === 'dash' || stream.drm) {
      await playShaka(stream.url, stream.drm, stream.headers);
    } else {
      // HLS biasa (.m3u8)
      playHls(stream.url);
    }
  } catch (err) {
    console.error('[Playback Error]', err);
    tryNextStream();
  } finally {
    state.isSwitching = false;
  }
}

/**
 * Convert hex string to base64url-encoded string
 * Needed for ClearKey JSON license format
 */
function hexToB64url(hex) {
  const bytes = new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
  let b64 = btoa(String.fromCharCode(...bytes));
  // Convert to base64url
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build a ClearKey license response as a data: URI
 * This creates the JSON Web Key (JWK) format that Shaka Player expects
 */
function buildClearKeyLicenseDataUri(clearkeys) {
  const keys = [];
  for (const [kidHex, keyHex] of Object.entries(clearkeys)) {
    keys.push({
      kty: 'oct',
      kid: hexToB64url(kidHex),
      k: hexToB64url(keyHex)
    });
  }
  const jwks = JSON.stringify({ keys });
  const b64 = btoa(jwks);
  return `data:application/json;base64,${b64}`;
}

/**
 * Google Shaka Player Engine
 * Supports ClearKey DRM & MPEG-DASH with auto recovery
 */
async function playShaka(url, drm, customHeaders = {}) {
  if (typeof shaka === 'undefined') {
    throw new Error('Shaka Player library belum dimuat.');
  }

  if (!shaka.Player.isBrowserSupported()) {
    throw new Error('Browser ini belum mendukung Shaka Player DRM playback.');
  }

  const player = new shaka.Player();
  await player.attach(video);
  state.shakaPlayer = player;

  // Build DRM configuration
  const drmConfig = {};

  if (drm && drm.drmType === 'clearkey' && drm.clearkeys) {
    // ClearKey DRM: provide keys directly to Shaka
    // We use the clearKeys config which accepts hex key pairs
    drmConfig.clearKeys = drm.clearkeys;
    showToast('🔑 ClearKey DRM aktif — memuat stream terenkripsi...', 2500);
    console.log('[Shaka DRM] ClearKey configured with', Object.keys(drm.clearkeys).length, 'key(s)');
  } else if (drm && drm.drmType === 'widevine' && drm.licenseUrl) {
    drmConfig.servers = {
      'com.widevine.alpha': drm.licenseUrl
    };
    drmConfig.advanced = {
      'com.widevine.alpha': {
        videoRobustness: 'SW_SECURE_CRYPTO',
        audioRobustness: 'SW_SECURE_CRYPTO'
      }
    };
    showToast('🔐 Widevine DRM aktif — Shaka Player memuat stream...', 2500);
  }

  // Streaming & Buffer Parameters
  player.configure({
    drm: drmConfig,
    streaming: {
      rebufferingGoal: 2,
      bufferingGoal: 10,
      bufferBehind: 30,
      lowLatencyMode: false,
      retryParameters: {
        maxAttempts: 4,
        baseDelay: 1000,
        backoffFactor: 2
      }
    },
    manifest: {
      dash: {
        ignoreMinBufferTime: true
      },
      retryParameters: {
        maxAttempts: 4,
        baseDelay: 1000,
        backoffFactor: 2
      }
    }
  });

  // Request Filter: Add CORS headers for proxied requests & log DRM challenges
  const netEngine = player.getNetworkingEngine();
  if (netEngine) {
    netEngine.registerRequestFilter((type, request) => {
      if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) {
        console.log('[Shaka DRM] License request to:', request.uris[0]);
      }
      if (type === shaka.net.NetworkingEngine.RequestType.SEGMENT ||
          type === shaka.net.NetworkingEngine.RequestType.MANIFEST) {
        // Log segment/manifest requests for debugging
        if (request.uris[0] && request.uris[0].includes('/stream/')) {
          console.log(`[Shaka ${type === 1 ? 'Segment' : 'Manifest'}]`, request.uris[0].substring(0, 120));
        }
      }
    });
  }

  // Event Listeners
  player.addEventListener('error', event => {
    console.error('[Shaka Player Error]', event.detail);
    const err = event.detail;

    // DRM errors
    if (err && err.category === shaka.util.Error.Category.DRM) {
      if (drm && drm.drmType === 'widevine') {
        showToast('⚠️ Lisensi Widevine channel ini offline. Pilih tab "DRM Channels" untuk ClearKey!', 4500);
        showStreamError(`Lisensi Widevine untuk ${state.channels[state.currentChannelIdx]?.name || 'channel ini'} sedang offline. Coba channel dari grup "DRM Channels".`);
        return;
      }
      // ClearKey error: try next stream
      console.warn('[Shaka] ClearKey DRM error, trying next stream...');
    }
    tryNextStream();
  });

  player.addEventListener('buffering', event => {
    if (event.buffering) showBuffering();
    else hideBuffering();
  });

  // Load manifest & start playback
  try {
    await player.load(url);
  } catch (loadErr) {
    console.error('[Shaka Load Error]', loadErr);
    // If ClearKey channel fails, show specific message
    if (drm && drm.drmType === 'clearkey') {
      console.warn('[Shaka] ClearKey stream failed to load:', loadErr.message);
    }
    throw loadErr;
  }

  video.style.display = 'block';
  const placeholder = $('player-placeholder');
  if (placeholder) placeholder.style.display = 'none';
  hideBuffering();

  await video.play().catch(e => {
    console.log('[Video Play Notice] Autoplay was prevented or postponed:', e.message);
  });
}

/**
 * Hls.js Fallback Engine
 */
function playHls(url) {
  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 30
    });
    state.hlsInstance = hls;

    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.style.display = 'block';
      const placeholder = $('player-placeholder');
      if (placeholder) placeholder.style.display = 'none';
      hideBuffering();
      video.play().catch(() => {});
    });

    hls.on(Hls.Events.ERROR, (e, d) => {
      if (d.fatal) {
        console.warn('[Hls.js Fatal Error]', d);
        tryNextStream();
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Native Safari HLS
    video.src = url;
    video.style.display = 'block';
    const placeholder = $('player-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    video.play().catch(() => tryNextStream());
    hideBuffering();
  } else {
    tryNextStream();
  }
}

function tryNextStream() {
  const ch = state.channels[state.currentChannelIdx];
  if (!ch) return;

  if (ch.activeStream < ch.streams.length - 1) {
    ch.activeStream++;
    showToast(`⚠️ Stream #${ch.activeStream} gagal. Mengalihkan ke stream #${ch.activeStream + 1}...`, 3000);
    setTimeout(playCurrentStream, 800);
  } else if (state.retryCount < state.maxRetry) {
    state.retryCount++;
    ch.activeStream = 0;
    showToast(`🔄 Memuat ulang stream (Percobaan ${state.retryCount}/${state.maxRetry})...`, 2500);
    setTimeout(playCurrentStream, 1500);
  } else {
    showStreamError(`Semua stream untuk ${ch.name} saat ini sedang offline.`);
  }
}

// ============================================================
// UI Updates & Interactions
// ============================================================
function updateNowPlaying(ch) {
  const np = $('now-playing');
  const npLogo = $('np-logo');
  const npTitle = $('np-title');
  const npGroup = $('np-group');

  if (np) np.style.display = 'flex';
  if (npTitle) npTitle.textContent = ch.name;
  if (npGroup) npGroup.textContent = ch.group;

  if (npLogo) {
    if (ch.logo) {
      npLogo.src = ch.logo;
      npLogo.style.display = 'block';
    } else {
      npLogo.style.display = 'none';
    }
  }
}

function markActiveChannel(id) {
  channelList.querySelectorAll('.channel-item').forEach(el => {
    el.classList.toggle('active', +el.dataset.id === id);
  });
}

function navigateChannel(dir) {
  if (!state.filteredChannels.length) return;
  const currentId = state.channels[state.currentChannelIdx]?.id ?? -1;
  const ci = state.filteredChannels.findIndex(ch => ch.id === currentId);
  const ni = (ci + dir + state.filteredChannels.length) % state.filteredChannels.length;
  playChannelById(state.filteredChannels[ni].id);
}

// ============================================================
// Global Event Listeners & Initialization
// ============================================================
function initApp() {
  // Install Shaka Polyfills
  if (typeof shaka !== 'undefined') {
    shaka.polyfill.installAll();
  }

  // Sidebar Toggle
  const toggleBtn = $('sidebar-toggle');
  if (toggleBtn) {
    toggleBtn.onclick = () => sidebar.classList.toggle('collapsed');
  }

  // Search Input
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      state.searchQuery = e.target.value.trim();
      filterAndRender();
    });
  }

  // Retry Button
  const retryBtn = $('retry-btn');
  if (retryBtn) {
    retryBtn.onclick = () => {
      state.retryCount = 0;
      playCurrentStream();
    };
  }

  // Stream Navigation Buttons
  const prevBtn = $('prev-stream-btn');
  const nextBtn = $('next-stream-btn');
  if (prevBtn) {
    prevBtn.onclick = () => {
      const ch = state.channels[state.currentChannelIdx];
      if (ch && ch.streams.length > 1) {
        ch.activeStream = (ch.activeStream - 1 + ch.streams.length) % ch.streams.length;
        playCurrentStream();
      }
    };
  }
  if (nextBtn) {
    nextBtn.onclick = () => {
      const ch = state.channels[state.currentChannelIdx];
      if (ch && ch.streams.length > 1) {
        ch.activeStream = (ch.activeStream + 1) % ch.streams.length;
        playCurrentStream();
      }
    };
  }

  // Fullscreen & PiP
  const fsBtn = $('fullscreen-btn');
  if (fsBtn) {
    fsBtn.onclick = () => {
      const wrap = $('player-wrap');
      if (!document.fullscreenElement) {
        wrap.requestFullscreen().catch(console.warn);
      } else {
        document.exitFullscreen();
      }
    };
  }

  const pipBtn = $('pip-btn');
  if (pipBtn) {
    pipBtn.onclick = async () => {
      if (!video.src && !state.shakaPlayer && !state.hlsInstance) return;
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
      } catch (e) {
        showToast('⚠️ Picture in Picture tidak didukung peramban.');
      }
    };
  }

  // Video Native Events
  video.addEventListener('waiting', showBuffering);
  video.addEventListener('playing', hideBuffering);
  video.addEventListener('canplay', hideBuffering);
  video.addEventListener('error', () => {
    if (video.style.display !== 'none') tryNextStream();
  });

  // Keyboard Shortcuts
  document.addEventListener('keydown', e => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateChannel(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateChannel(1);
    } else if (e.key === 'f' || e.key === 'F') {
      const fs = $('fullscreen-btn');
      if (fs) fs.click();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (video.paused) video.play();
      else video.pause();
    }
  });

  // Realtime Clock
  function updateClock() {
    const clock = $('current-time-label');
    if (!clock) return;
    const now = new Date();
    clock.textContent = now.toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'Asia/Jakarta'
    }) + ' WIB';
  }
  setInterval(updateClock, 1000);
  updateClock();

  // Load Initial Playlist
  loadPlaylist();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

"""
Auto-Refresh & Health Checker for IPTV Playlist
Checks stream health, applies fallbacks for dead channels, and regenerates playlist.m3u.
"""

import os
import re
import sys
import ssl
import json
import time
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed

# Reconfigure stdout for utf-8
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

SSL_CTX = ssl._create_unverified_context()
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

# Known fallback URLs if primary stream fails
FALLBACK_MAP = {
    "Kompas TV": [
        "https://op-flashcon-digdayahd-1.dens.tv/s/s104/index.m3u8",
        "https://r-plus.sedotcw3.workers.dev/index.m3u8?id=kompas"
    ],
    "TVRI": [
        "http://72.60.79.72:8765/vidio/6441.m3u8",
        "https://op-flashcon-digdayahd-1.dens.tv/s/s01/index.m3u8"
    ],
    "Metro TV": [
        "http://72.60.79.72:8765/vidio/777.m3u8",
        "https://op-flashcon-digdayahd-1.dens.tv/s/s08/index.m3u8"
    ],
    "Trans TV": [
        "http://72.60.79.72:8765/vidio/733.mpd",
        "https://r-plus.sedotcw3.workers.dev/index.m3u8?id=transtv"
    ],
    "Trans7": [
        "http://72.60.79.72:8765/vidio/734.mpd",
        "https://r-plus.sedotcw3.workers.dev/index.m3u8?id=trans7"
    ],
    "RCTI": [
        "https://r-plus.sedotcw3.workers.dev/index.m3u8?id=rcti",
        "https://d2xz2v5wuvgur6.cloudfront.net/out/v1/997ce8767b604fae9fce05379b3b8b3a/index.mpd"
    ],
    "MNC TV": [
        "https://r-plus.sedotcw3.workers.dev/index.m3u8?id=mnctv",
        "https://d2xz2v5wuvgur6.cloudfront.net/out/v1/d6b026ad50f14b7f9af5ddd5450007d4/index.mpd"
    ],
    "GTV": [
        "https://r-plus.sedotcw3.workers.dev/index.m3u8?id=gtv",
        "https://d2tjypxxy769fn.cloudfront.net/out/v1/b8b9b1d5f80f45649b4a3619291551ab/index.mpd"
    ]
}

def parse_playlist(filepath):
    channels = []
    if not os.path.exists(filepath):
        return channels

    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        content = f.read()

    blocks = content.split('#EXTINF:')
    header = blocks[0]

    for b in blocks[1:]:
        full_block = '#EXTINF:' + b.strip()
        lines = [l.strip() for l in full_block.split('\n') if l.strip()]
        if not lines:
            continue

        extinf_line = lines[0]
        url = lines[-1]

        # Extract channel name
        parts = extinf_line.split(',')
        name = parts[-1].strip() if len(parts) > 1 else 'Unknown'

        # Extract group
        g_match = re.search(r'group-title="([^"]+)"', extinf_line)
        group = g_match.group(1) if g_match else 'Other'

        # Extra metadata lines (KODIPROP, EXTVLCOPT)
        meta_lines = lines[1:-1]

        channels.append({
            'name': name,
            'group': group,
            'extinf': extinf_line,
            'meta': meta_lines,
            'url': url,
            'original_block': full_block
        })

    return header, channels

def check_stream_url(url, meta_lines, timeout=6):
    """Checks if a stream URL responds with valid manifest content."""
    try:
        headers = {
            'User-Agent': USER_AGENT,
            'Accept': '*/*'
        }
        for m in meta_lines:
            if 'http-user-agent=' in m:
                headers['User-Agent'] = m.split('http-user-agent=', 1)[1]
            elif 'http-referrer=' in m:
                headers['Referer'] = m.split('http-referrer=', 1)[1]
            elif 'http-origin=' in m:
                headers['Origin'] = m.split('http-origin=', 1)[1]

        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as resp:
            status = resp.status
            content_type = resp.headers.get('content-type', '').lower()
            # Read first 512 bytes
            chunk = resp.read(512).decode('utf-8', errors='ignore')

            # Validate HLS or DASH content
            if '#EXTM3U' in chunk or '<MPD' in chunk or '<?xml' in chunk or '.ts' in chunk or '.m4s' in chunk:
                return True, status, "OK"
            if 'html' in content_type and 'error' in chunk.lower():
                return False, status, "HTML Error"
            if status in [200, 206]:
                return True, status, "OK"
            return False, status, f"Invalid content ({content_type})"
    except urllib.error.HTTPError as e:
        return False, e.code, str(e.reason)
    except Exception as e:
        return False, 0, str(e)

def process_channel(ch):
    ok, status, reason = check_stream_url(ch['url'], ch['meta'])
    ch['status'] = status
    ch['alive'] = ok
    ch['check_reason'] = reason
    ch['used_fallback'] = False

    # If primary stream failed, check fallbacks
    if not ok:
        channel_key = None
        for k in FALLBACK_MAP:
            if k.lower() in ch['name'].lower():
                channel_key = k
                break

        if channel_key:
            for fb_url in FALLBACK_MAP[channel_key]:
                if fb_url == ch['url']:
                    continue
                fb_ok, fb_status, _ = check_stream_url(fb_url, ch['meta'])
                if fb_ok:
                    ch['url'] = fb_url
                    ch['alive'] = True
                    ch['status'] = fb_status
                    ch['used_fallback'] = True
                    ch['check_reason'] = f"Restored via fallback {fb_url[:35]}..."
                    break

    return ch

def main():
    start_time = time.time()
    playlist_file = 'playlist.m3u'
    print(f"[Auto-Refresh] Loading {playlist_file}...")
    header, channels = parse_playlist(playlist_file)
    print(f"[Auto-Refresh] Checking {len(channels)} channels with parallel threads...")

    verified_channels = []
    with ThreadPoolExecutor(max_workers=20) as executor:
        futures = {executor.submit(process_channel, ch): ch for ch in channels}
        for future in as_completed(futures):
            res = future.result()
            verified_channels.append(res)

    alive_count = sum(1 for c in verified_channels if c['alive'])
    dead_count = len(verified_channels) - alive_count
    fallback_count = sum(1 for c in verified_channels if c.get('used_fallback'))

    print("\n" + "=" * 60)
    print(f"📊 CHECK RESULTS:")
    print(f"   Total Channels:    {len(verified_channels)}")
    print(f"   ✅ Alive / OK:     {alive_count}")
    print(f"   🔄 Restored FB:    {fallback_count}")
    print(f"   ❌ Offline / Dead: {dead_count}")
    print(f"   ⏱️  Time Elapsed:   {time.time() - start_time:.2f}s")
    print("=" * 60 + "\n")

    # Generate updated playlist.m3u while preserving section headers and structure
    out_lines = [header.strip()]
    for ch in channels:
        out_lines.append("")
        out_lines.append(ch['extinf'])
        for m in ch['meta']:
            out_lines.append(m)
        out_lines.append(ch['url'])

    output_content = "\n".join(out_lines) + "\n"
    with open(playlist_file, 'w', encoding='utf-8') as f:
        f.write(output_content)

    print(f"[Auto-Refresh] Successfully regenerated {playlist_file}")

if __name__ == '__main__':
    main()


import re
import ssl
import sys
import json
import urllib.request
import urllib.parse
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

# Reconfigure stdout for utf-8 on Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

ssl_ctx = ssl._create_unverified_context()

def clean_url(raw_url):
    raw_url = raw_url.strip()
    # parse and re-encode path and query to fix unencoded spaces or unicode
    parts = urllib.parse.urlsplit(raw_url)
    path = urllib.parse.quote(parts.path, safe='/%')
    query = urllib.parse.quote(parts.query, safe='=&%?:')
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))

def parse_m3u(file_path):
    channels = []
    with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
        lines = f.readlines()

    current_meta = {}
    current_headers = {}

    for idx, line in enumerate(lines, 1):
        line = line.strip()
        if not line:
            continue

        if line.startswith('#EXTINF:'):
            group_match = re.search(r'group-title="([^"]+)"', line)
            group = group_match.group(1) if group_match else 'Other'

            parts = line.split(',')
            name = parts[-1].strip() if len(parts) > 1 else 'Unknown'

            current_meta = {
                'line': idx,
                'name': name,
                'group': group,
                'extinf': line
            }
        elif line.startswith('#EXTVLCOPT:'):
            opt = line[len('#EXTVLCOPT:'):].strip()
            if opt.startswith('http-user-agent='):
                current_headers['User-Agent'] = opt.split('=', 1)[1]
            elif opt.startswith('http-referrer=') or opt.startswith('http-referer='):
                current_headers['Referer'] = opt.split('=', 1)[1]
            elif opt.startswith('http-origin='):
                current_headers['Origin'] = opt.split('=', 1)[1]
        elif line.startswith('#KODIPROP:stream_headers='):
            h = line.split('=', 1)[1]
            if 'user-agent=' in h.lower():
                ua = re.search(r'user-agent=([^&]+)', h, re.IGNORECASE)
                if ua:
                    current_headers['User-Agent'] = ua.group(1)
        elif line.startswith('#') or line.startswith(';'):
            continue
        elif line.startswith('http://') or line.startswith('https://'):
            url = line.strip()
            channels.append({
                'name': current_meta.get('name', 'Unknown'),
                'group': current_meta.get('group', 'Other'),
                'line': current_meta.get('line', idx),
                'url': url,
                'headers': dict(current_headers)
            })
            current_headers = {}
            current_meta = {}

    return channels

def check_channel(ch):
    original_url = ch['url']
    url = clean_url(original_url)

    headers = {
        'User-Agent': ch['headers'].get('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    }
    if 'Referer' in ch['headers']:
        headers['Referer'] = ch['headers']['Referer']
    if 'Origin' in ch['headers']:
        headers['Origin'] = ch['headers']['Origin']

    headers['Range'] = 'bytes=0-2048'

    result = {
        'name': ch['name'],
        'group': ch['group'],
        'line': ch['line'],
        'url': original_url,
        'alive': False,
        'status': '',
        'reason': ''
    }

    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, context=ssl_ctx, timeout=8) as response:
            code = response.getcode()
            sample = response.read(512)
            content_type = response.headers.get('Content-Type', '')

            # If response is 200 or 206, it's considered alive
            if code in (200, 206):
                result['alive'] = True
                result['status'] = f"HTTP {code}"
                result['reason'] = content_type.split(';')[0] if content_type else 'stream'
            else:
                result['status'] = f"HTTP {code}"
                result['reason'] = 'Unexpected status'
    except urllib.error.HTTPError as e:
        result['status'] = f"HTTP {e.code}"
        result['reason'] = e.reason
    except urllib.error.URLError as e:
        result['status'] = "ConnError"
        result['reason'] = str(e.reason)[:50]
    except TimeoutError:
        result['status'] = "Timeout"
        result['reason'] = "Timeout (>8s)"
    except Exception as e:
        result['status'] = "Error"
        result['reason'] = str(e)[:50]

    return result

if __name__ == '__main__':
    file_path = sys.argv[1] if len(sys.argv) > 1 else 'd:/TOPIK 2/korea_channels_gist.m3u'
    channels = parse_m3u(file_path)
    print(f"Total channel aktif yang diperiksa: {len(channels)}")

    alive_count = 0
    dead_count = 0
    results = []

    with ThreadPoolExecutor(max_workers=12) as executor:
        future_to_ch = {executor.submit(check_channel, ch): ch for ch in channels}
        for future in as_completed(future_to_ch):
            res = future.result()
            results.append(res)
            if res['alive']:
                alive_count += 1
                print(f"[ALIVE] [{res['group']}] {res['name']} ({res['status']})")
            else:
                dead_count += 1
                print(f"[DEAD]  [{res['group']}] {res['name']} ({res['status']}: {res['reason']})")

    # Sort results by original line
    results.sort(key=lambda x: x['line'])

    with open('d:/TOPIK 2/channel_check_results.json', 'w', encoding='utf-8') as f:
        json.dump({
            'total': len(channels),
            'alive': alive_count,
            'dead': dead_count,
            'results': results
        }, f, indent=2, ensure_ascii=False)

    print("\n" + "="*50)
    print(f"SELESAI! Total: {len(channels)} | HIDUP: {alive_count} | MATI: {dead_count}")
    print("="*50)

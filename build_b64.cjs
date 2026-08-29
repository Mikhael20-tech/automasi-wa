const fs = require('fs');
const code = `const express = require('express');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { URL } = require('url');

const app = express();
const PORT = 47129;
const SECRET_KEY = "pecel_magetan";

// 🔗 LINK RAW GIST KAMU (Hanya membaca pilihan 13 channel milikmu):
const GITHUB_GIST_URL = "https://gist.githubusercontent.com/Mikhael20-tech/28af0cc656510032cdab4f311c0af4f4/raw/iptv.m3u";

const PROXY_URL = 'http://219.249.37.107:8382'; 
const agent = new HttpsProxyAgent(PROXY_URL);

// ROUTE 1: Hanya membaca & menyajikan channel dari GitHub Gist kamu!
app.get('/playlist.m3u', async (req, res) => {
    if (req.query.key !== SECRET_KEY) {
        return res.status(404).send('Not Found');
    }

    try {
        const response = await axios.get(GITHUB_GIST_URL, { timeout: 8000 });
        const host = req.get('host');
        
        const rewrittenM3u = response.data.split('\\n').map(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && (trimmed.startsWith('http://') || trimmed.startsWith('https://'))) {
                return \`http://\${host}/proxy?key=\${SECRET_KEY}&url=\${encodeURIComponent(trimmed)}\`;
            }
            return line;
        }).join('\\n');

        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(rewrittenM3u);
    } catch (err) {
        console.error("Gagal mengambil playlist dari GitHub Gist:", err.message);
        res.status(500).send("Gagal mengambil playlist dari GitHub Gist");
    }
});

// ROUTE 2: Stream Proxy (Bungkus Stream M3U8 & Segmen TS)
app.get('/proxy', async (req, res) => {
    if (req.query.key !== SECRET_KEY) {
        return res.status(404).send('Not Found');
    }

    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Bad Request');

    const isGeoblocked = targetUrl.includes('tvchosun') || targetUrl.includes('dothome.co.kr');

    try {
        const config = {
            method: 'get',
            url: targetUrl,
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            responseType: targetUrl.endsWith('.m3u8') ? 'text' : 'stream',
            timeout: 8000
        };

        if (isGeoblocked) {
            config.httpsAgent = agent;
        }

        const response = await axios(config);

        if (targetUrl.endsWith('.m3u8')) {
            const rewritten = response.data.split('\\n').map(line => {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    const absoluteUrl = new URL(trimmed, targetUrl).href;
                    return \`http://\${req.get('host')}/proxy?key=\${SECRET_KEY}&url=\${encodeURIComponent(absoluteUrl)}\`;
                }
                return line;
            }).join('\\n');
            
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.send(rewritten);
        } else {
            res.set('Content-Type', response.headers['content-type'] || 'video/MP2T');
            response.data.pipe(res);
        }
    } catch (error) {
        console.error(\`Gagal akses \${targetUrl}: \${error.message}\`);
        res.status(502).send('Proxy Connection Failed');
    }
});

app.listen(PORT, () => {
    console.log(\`Proxy Ninja V2 Aktif di port \${PORT}\`);
});
`;

console.log(Buffer.from(code).toString('base64'));

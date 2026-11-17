const express = require("express");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 8888;
const HLS_DIR = path.join(__dirname, "hls");

if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });

// Enable CORS for all IPTV players
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  next();
});

app.use("/live", express.static(HLS_DIR));

async function startRestreamer(targetUrl) {
  console.log("[*] Membuka Chromium di background...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-web-security",
      "--autoplay-policy=no-user-gesture-required"
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
  );

  let segmentIndex = 0;
  const segments = [];

  page.on("response", async (response) => {
    const url = response.url();
    const contentType = response.headers()["content-type"] || "";
    if (
      url.includes("cfall") ||
      url.includes(".ts") ||
      contentType.includes("video/mp2t") ||
      contentType.includes("video/mp4")
    ) {
      try {
        const buffer = await response.buffer();
        if (buffer.length > 5000) {
          const segName = `seg_${segmentIndex++}.ts`;
          fs.writeFileSync(path.join(HLS_DIR, segName), buffer);
          segments.push(segName);
          if (segments.length > 6) {
            const old = segments.shift();
            try {
              fs.unlinkSync(path.join(HLS_DIR, old));
            } catch (e) {}
          }

          let m3u8 = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:${segmentIndex - segments.length}\n`;
          for (const s of segments) {
            m3u8 += `#EXTINF:4.0,\n${s}\n`;
          }
          fs.writeFileSync(path.join(HLS_DIR, "stream.m3u8"), m3u8);
          console.log(`[+] Chunk berhasil ditangkap: ${segName} (${buffer.length} bytes)`);
        }
      } catch (err) {}
    }
  });

  console.log("[*] Navigasi ke URL siaran:", targetUrl);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  console.log("[*] Halaman termuat! Menunggu player & memicu pemutaran...");
  await new Promise((r) => setTimeout(r, 4000));

  try {
    await page.evaluate(() => {
      const clickables = document.querySelectorAll(
        "video, .player, .play, .play-btn, .vjs-big-play-button, button, .live-btn"
      );
      clickables.forEach((c) => {
        try {
          c.click();
        } catch (e) {}
      });
    });
  } catch (e) {}

  // Keep checking every 10 seconds if video is paused and play it
  setInterval(async () => {
    try {
      await page.evaluate(() => {
        const v = document.querySelector("video");
        if (v && v.paused) {
          v.play();
        }
      });
    } catch (e) {}
  }, 10000);
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[🚀] Restreamer aktif di port ${PORT}`);
  startRestreamer(
    "https://zac01.superabbit77hd.xyz/id/football/afc-u17-asian-cup-4508697/afghanistan-u17-vs-indonesia-u17.html?icg=SUQ&ilang=id"
  );
});

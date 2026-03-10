const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.get("/ping", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get("/", (req, res) => {
  res.json({ ok: true, message: "WebArchive Backend Running 🚀" });
});

app.post("/capture", async (req, res) => {
  const { url, fullPage = true, twitterCookie = '' } = req.body;

  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ success: false, error: "Invalid URL" });
  }

  const isTwitter = /twitter\.com|x\.com/.test(url);
  let browser;

  try {
    console.log("Capturing:", url);

    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--disable-extensions",
        "--single-process",
        "--disable-software-rasterizer"
      ]
    });

    const contextOptions = {
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ignoreHTTPSErrors: true
    };

    if (isTwitter && twitterCookie) {
      contextOptions.storageState = {
        cookies: [
          { name: 'auth_token', value: twitterCookie, domain: '.twitter.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' },
          { name: 'auth_token', value: twitterCookie, domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' }
        ]
      };
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    await page.route("**/*", route => {
      const type = route.request().resourceType();
      if (["media", "websocket"].includes(type)) route.abort();
      else route.continue();
    });

    const waitUntil = isTwitter ? "networkidle" : "domcontentloaded";
    await page.goto(url, { waitUntil, timeout: isTwitter ? 45000 : 30000 });
    await page.waitForTimeout(isTwitter ? 4000 : 2000);

    // Auto-scroll to trigger lazy content
    if (fullPage) {
      await page.evaluate(async () => {
        await new Promise(resolve => {
          let total = 0;
          const timer = setInterval(() => {
            window.scrollBy(0, 400);
            total += 400;
            if (total >= document.body.scrollHeight) {
              window.scrollTo(0, 0);
              clearInterval(timer);
              resolve();
            }
          }, 120);
        });
      });
      await page.waitForTimeout(1000);
    }

    // Take screenshot
    const screenshot = await page.screenshot({ fullPage, type: "png" });
    const title = await page.title();
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 5000) || "");

    // ── SINGLEFILE approach: inject the library into the live page ──
    const html = await page.evaluate(async (pageUrl) => {
      // Load SingleFile core from CDN into the page context
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/single-file-core@1.3.32/single-file.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('SingleFile CDN load failed'));
        document.head.appendChild(s);
      });

      if (typeof singlefile === 'undefined') throw new Error('SingleFile not available');

      const result = await singlefile.getPageData({
        removeHiddenElements: false,
        removeUnusedStyles: false,
        removeUnusedFonts: false,
        removeFrames: false,
        compressHTML: false,
        removeScripts: true,
        insertMetaCSP: false,
        saveOriginalURLs: true,
        url: pageUrl
      });

      return result.content;

    }, url).catch(async (err) => {
      // Fallback: manual inline if SingleFile CDN fails
      console.log("SingleFile failed, using fallback:", err.message);
      return await page.evaluate(async (pageUrl) => {
        const styleLinks = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).slice(0, 15);
        for (const link of styleLinks) {
          try {
            const res = await Promise.race([fetch(link.href), new Promise((_, r) => setTimeout(() => r(new Error('t')), 4000))]);
            if (!res.ok) continue;
            const css = await res.text();
            const style = document.createElement('style');
            style.textContent = css;
            link.parentNode.replaceChild(style, link);
          } catch {}
        }
        const images = Array.from(document.querySelectorAll('img')).slice(0, 40);
        for (const img of images) {
          try {
            if (!img.src || img.src.startsWith('data:')) continue;
            const res = await Promise.race([fetch(img.src), new Promise((_, r) => setTimeout(() => r(new Error('t')), 3000))]);
            if (!res.ok) continue;
            const blob = await res.blob();
            if (blob.size > 800000) continue;
            await new Promise(resolve => {
              const reader = new FileReader();
              reader.onload = () => { img.src = reader.result; resolve(); };
              reader.onerror = resolve;
              reader.readAsDataURL(blob);
            });
          } catch {}
        }
        if (!document.querySelector('base')) {
          const base = document.createElement('base');
          base.href = pageUrl;
          document.head.insertBefore(base, document.head.firstChild);
        }
        return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
      }, pageUrl);
    });

    await browser.close();
    console.log("Done:", url);

    res.json({ success: true, title, text, html, screenshot: screenshot.toString("base64") });

  } catch (err) {
    console.error("Error:", err.message);
    if (browser) try { await browser.close(); } catch {}
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("WebArchive backend running on port " + PORT);
});

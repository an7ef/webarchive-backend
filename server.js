const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── Browser pool (keep one instance warm) ────────────────────────
let browserInstance = null;
let browserLaunchTime = null;
const BROWSER_MAX_AGE_MS = 10 * 60 * 1000; // recycle after 10 min

async function getBrowser() {
  const now = Date.now();
  if (browserInstance && browserLaunchTime && (now - browserLaunchTime) < BROWSER_MAX_AGE_MS) {
    return browserInstance;
  }
  if (browserInstance) {
    try { await browserInstance.close(); } catch {}
  }
  browserInstance = await chromium.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions'
    ]
  });
  browserLaunchTime = now;
  console.log('🚀 Browser launched');
  return browserInstance;
}

// Pre-warm on startup
getBrowser().catch(console.error);

// ── /ping — keep-alive endpoint ─────────────────────────────────
app.get('/ping', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ── /capture ────────────────────────────────────────────────────
app.post('/capture', async (req, res) => {
  const { url, fullPage = true } = req.body;

  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ success: false, error: 'Invalid URL' });
  }

  let page = null;
  const startTime = Date.now();

  try {
    console.log(`📸 Capturing: ${url}`);

    const browser = await getBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true
    });

    page = await context.newPage();

    // Block heavy resources for speed
    await page.route('**/*', route => {
      const type = route.request().resourceType();
      if (['media', 'font', 'websocket'].includes(type)) {
        return route.abort();
      }
      route.continue();
    });

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Wait a bit for JS to render
    await page.waitForTimeout(1500);

    // Auto-scroll to trigger lazy-load (for full-page shots)
    if (fullPage) {
      await page.evaluate(async () => {
        await new Promise(resolve => {
          let total = 0;
          const step = 300;
          const timer = setInterval(() => {
            window.scrollBy(0, step);
            total += step;
            if (total >= document.body.scrollHeight) {
              window.scrollTo(0, 0);
              clearInterval(timer);
              resolve();
            }
          }, 80);
        });
      });
      await page.waitForTimeout(500);
    }

    // Screenshot
    const screenshotBuffer = await page.screenshot({
      fullPage,
      type: 'png'
    });

    // HTML
    const html = await page.content();

    // Title + text
    const title = await page.title();
    const text = await page.evaluate(() =>
      document.body?.innerText?.slice(0, 5000) || ''
    );

    await context.close();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ Done in ${elapsed}s: ${url}`);

    res.json({
      success: true,
      title,
      text,
      html,
      screenshot: screenshotBuffer.toString('base64'),
      elapsed
    });

  } catch (err) {
    console.error('❌ Capture error:', err.message);

    if (page) {
      try { await page.close(); } catch {}
    }

    // If browser died, force recreate
    if (err.message?.includes('Target closed') || err.message?.includes('Browser')) {
      browserInstance = null;
    }

    res.status(500).json({ success: false, error: err.message });
  }
});

// ── /health ─────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
    browser: !!browserInstance
  });
});

// ── Global error handling ────────────────────────────────────────
process.on('uncaughtException', err => {
  console.error('Uncaught:', err.message);
  browserInstance = null; // force browser restart
});

process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err?.message);
});

app.listen(PORT, () => {
  console.log(`🌐 WebArchive backend running on port ${PORT}`);
});

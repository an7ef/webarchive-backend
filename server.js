const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.get("/ping", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get("/", (req, res) => {
  res.json({ ok: true, message: "WebArchive Backend Running 🚀" });
});

// ── Common cookie/consent banner selectors ─────────────────────────
const CONSENT_SELECTORS = [
  // Generic
  '#accept-cookies', '#acceptCookies', '#cookie-accept', '#cookieAccept',
  '#accept-all', '#acceptAll', '#accept_all',
  '.accept-cookies', '.acceptCookies', '.cookie-accept',
  '.accept-all', '.acceptAll',
  '[id*="cookie"][id*="accept"]', '[id*="consent"][id*="accept"]',
  '[class*="cookie"][class*="accept"]', '[class*="consent"][class*="accept"]',
  // Buttons with text patterns (handled separately)
  'button[id*="accept"]', 'button[class*="accept"]',
  'button[id*="agree"]', 'button[class*="agree"]',
  'button[id*="consent"]', 'button[class*="consent"]',
  'button[id*="cookie"]', 'button[class*="cookie"]',
  // Specific sites
  '#onetrust-accept-btn-handler',      // OneTrust (huge network)
  '#truste-consent-button',            // TrustArc
  '.cc-btn.cc-allow',                  // Cookie Consent plugin
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', // Cookiebot
  '.CookieConsent button',
  '#gdpr-consent-tool-wrapper button', 
  '.gdpr-consent button',
  '[aria-label*="Accept cookies"]',
  '[aria-label*="accept cookies"]',
  '[aria-label*="Aceptar"]',
  '[aria-label*="Acepto"]',
  // EU/Spanish common
  '#aceptar-cookies', '.aceptar-cookies',
  'button[id*="aceptar"]', 'button[class*="aceptar"]',
  // Steam age gate
  '#agecheck_form button[type="submit"]',
  '#age_gate button',
  // YouTube
  'button[aria-label="Accept all"]',
  'tp-yt-paper-button[aria-label="Accept all"]',
  // Google
  'button[jsname="b3VHJd"]',
  // Reddit
  'button[class*="AcceptAllCookies"]',
  // CNN/news
  '.cn-button', '.cn-buttons button',
  // NYT
  '[data-testid="Accept all-btn"]',
  // Forbes
  '.trustarc-banner-button',
  // Twitter/X
  '[data-testid="AppTabBar_Home_Link"]', // just checking login
  // Modal overlays / paywalls — try to remove
  '.paywall', '#paywall', '.pw-wrapper',
  '.tp-modal', '.tp-backdrop',
  '.piano-modal', '#piano-modal',
  '.subscription-wall', '.sub-wall',
  '.overlay-modal', '.modal-overlay',
];

// ── Text patterns for consent buttons ─────────────────────────────
const CONSENT_TEXT = [
  'accept all', 'accept cookies', 'allow all', 'agree', 'i agree',
  'got it', 'ok', 'okay', 'continue', 'acepto', 'aceptar todo',
  'aceptar cookies', 'accepter', 'accepter tout', 'alle akzeptieren',
  'alle cookies akzeptieren', 'accetta tutto', 'alle accepteren',
  'zezwól na wszystkie', 'kabul et'
];

async function dismissBanners(page) {
  try {
    // Try selector-based clicks
    for (const selector of CONSENT_SELECTORS) {
      try {
        const el = await page.$(selector);
        if (el && await el.isVisible()) {
          await el.click({ timeout: 1000 });
          await page.waitForTimeout(500);
          break;
        }
      } catch {}
    }

    // Try text-based button matching
    const buttons = await page.$$('button, [role="button"], a.btn, .button');
    for (const btn of buttons) {
      try {
        const text = (await btn.textContent() || '').toLowerCase().trim();
        const isVisible = await btn.isVisible();
        if (isVisible && CONSENT_TEXT.some(t => text === t || text.includes(t))) {
          await btn.click({ timeout: 1000 });
          await page.waitForTimeout(500);
          break;
        }
      } catch {}
    }

    // Remove common overlay/paywall elements from DOM
    await page.evaluate(() => {
      const overlaySelectors = [
        '.paywall', '#paywall', '.pw-wrapper', '.pw-modal',
        '.tp-modal', '.tp-backdrop', '.piano-modal',
        '.subscription-wall', '.sub-wall',
        '[class*="paywall"]', '[id*="paywall"]',
        '[class*="overlay"]', '[class*="modal"]',
        '.cookie-banner', '.cookie-notice', '.cookie-bar',
        '#cookie-banner', '#cookie-notice', '#cookie-bar',
        '.gdpr-banner', '#gdpr-banner',
        '.consent-banner', '#consent-banner',
      ];
      overlaySelectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          // Only remove if it looks like an overlay (fixed/absolute position)
          const style = window.getComputedStyle(el);
          if (['fixed', 'absolute'].includes(style.position) && 
              parseInt(style.zIndex) > 100) {
            el.remove();
          }
        });
      });

      // Re-enable scroll if blocked by overlays
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
    });
  } catch {}
}

app.post("/capture", async (req, res) => {
  const { url, fullPage = true, twitterCookie = '', twitterCt0 = '' } = req.body;

  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ success: false, error: "Invalid URL" });
  }

  const isTwitter = /twitter\.com|x\.com/.test(url);
  const isSteam   = /steampowered\.com|store\.steam/.test(url);
  const isYT      = /youtube\.com|youtu\.be/.test(url);
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
        "--disable-software-rasterizer",
        "--disable-blink-features=AutomationControlled",
      ]
    });

    const contextOptions = {
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      ignoreHTTPSErrors: true,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      }
    };

    // Twitter auth cookie
    if (isTwitter && twitterCookie) {
      contextOptions.storageState = {
        cookies: [
          { name: 'auth_token', value: twitterCookie, domain: '.twitter.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' },
          { name: 'auth_token', value: twitterCookie, domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' },
          { name: 'ct0', value: twitterCt0, domain: '.twitter.com', path: '/', secure: true, sameSite: 'Lax' },
          { name: 'ct0', value: twitterCt0, domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' },
        ]
      };
    }

    // Steam: set age-check cookies
    if (isSteam) {
      contextOptions.storageState = {
        cookies: [
          { name: 'birthtime', value: '631152001', domain: '.steampowered.com', path: '/' },
          { name: 'lastagecheckage', value: '1-0-1990', domain: '.steampowered.com', path: '/' },
          { name: 'mature_content', value: '1', domain: '.steampowered.com', path: '/' },
        ]
      };
    }

    const context = await browser.newContext(contextOptions);

    // Hide automation fingerprints
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
    });

    const page = await context.newPage();

    // Resource cache for HTML inlining
    const resourceCache = {};

    await page.route("**/*", async route => {
      const type = route.request().resourceType();
      const reqUrl = route.request().url();

      if (["media", "websocket"].includes(type)) return route.abort();
      // For Twitter block extra heavy resources to avoid OOM
      if (isTwitter && ["font", "other"].includes(type)) return route.abort();

      if (["stylesheet", "image", "font"].includes(type)) {
        try {
          const response = await route.fetch();
          const body = await response.body();
          const headers = response.headers();
          const ct = headers["content-type"] || "";
          if (body.length < 5 * 1024 * 1024) { // cache if under 5MB
            resourceCache[reqUrl] = { body: body.toString("base64"), contentType: ct };
          }
          return route.fulfill({ response });
        } catch {
          return route.continue();
        }
      }
      return route.continue();
    });

    // Navigate - use domcontentloaded for Twitter to avoid memory crash on free tier
    const waitUntil = "domcontentloaded";
    await page.goto(url, { waitUntil, timeout: 45000 });
    await page.waitForTimeout(isTwitter ? 6000 : 2000);

    // Dismiss cookie banners and overlays
    await dismissBanners(page);
    await page.waitForTimeout(800);

    // Steam age gate: click through if present
    if (isSteam) {
      try {
        await page.selectOption('#ageYear', '1990');
        await page.click('#view_product_page_btn', { timeout: 2000 });
        await page.waitForTimeout(1500);
      } catch {}
    }

    // Auto-scroll to trigger lazy loading
    if (fullPage) {
      await page.evaluate(async () => {
        await new Promise(resolve => {
          let total = 0;
          const timer = setInterval(() => {
            window.scrollBy(0, 500);
            total += 500;
            if (total >= document.body.scrollHeight) {
              window.scrollTo(0, 0);
              clearInterval(timer);
              resolve();
            }
          }, 150);
        });
      });
      await page.waitForTimeout(1500);
    }

    // Screenshot
    const screenshot = await page.screenshot({ fullPage, type: "png" });
    const title = await page.title();
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 5000) || "");

    // Build self-contained HTML from cached resources
    const html = await page.evaluate((args) => {
      const { pageUrl, cache } = args;

      // Inline stylesheets
      document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
        const cached = cache[link.href];
        if (cached) {
          try {
            const style = document.createElement('style');
            style.textContent = atob(cached.body);
            link.parentNode.replaceChild(style, link);
          } catch {}
        }
      });

      // Inline images
      document.querySelectorAll('img[src]').forEach(img => {
        const cached = cache[img.src];
        if (cached && cached.body) {
          try {
            const ct = cached.contentType.split(';')[0] || 'image/png';
            img.src = `data:${ct};base64,${cached.body}`;
          } catch {}
        }
      });

      // Inline srcset images
      document.querySelectorAll('img[srcset]').forEach(img => {
        img.removeAttribute('srcset');
      });

      // Inline picture sources
      document.querySelectorAll('source[srcset]').forEach(src => {
        src.removeAttribute('srcset');
      });

      // Inline background images in inline styles
      document.querySelectorAll('[style*="url("]').forEach(el => {
        const style = el.getAttribute('style');
        const replaced = style.replace(/url\(['"]?([^'")\s]+)['"]?\)/g, (match, u) => {
          try {
            const abs = new URL(u, pageUrl).href;
            const cached = cache[abs];
            if (cached) {
              const ct = cached.contentType.split(';')[0] || 'image/png';
              return `url(data:${ct};base64,${cached.body})`;
            }
          } catch {}
          return match;
        });
        el.setAttribute('style', replaced);
      });

      // Add base tag for remaining relative links
      if (!document.querySelector('base')) {
        const base = document.createElement('base');
        base.href = pageUrl;
        document.head.insertBefore(base, document.head.firstChild);
      }

      // Remove scripts
      document.querySelectorAll('script').forEach(s => s.remove());

      return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
    }, { pageUrl: url, cache: resourceCache });

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

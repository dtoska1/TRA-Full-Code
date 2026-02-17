// backend/scrapers/tiranaVendime.js

const cheerio = require("cheerio");

const NAV_TIMEOUT_MS = 45000;
const FETCH_TIMEOUT_MS = 25000;
const RETRY_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 1200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseAlbanianDate_ddmmyyyy(s) {
  const m = String(s || "").trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeTitle(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isLikelyDocumentUrl(href) {
  const s = String(href || "").toLowerCase();
  return (
    /\.(pdf|doc|docx|rtf|xls|xlsx)(\?|#|$)/i.test(s) ||
    /[?&](download|file|attachment_id)=/i.test(s) ||
    /\/download\/?/i.test(s)
  );
}

async function getHtmlWithPlaywright(url) {
  let chromium = null;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    throw new Error(
      "Playwright is not installed. Run `cd backend && npm install playwright` first."
    );
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      locale: "sq-AL",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    if (!response || !response.ok()) {
      const status = response ? response.status() : "NO_RESPONSE";
      throw new Error(`Playwright navigation failed with status ${status}`);
    }

    // The listing sometimes renders late; try a short wait for either table rows or links.
    await Promise.race([
      page.waitForSelector("table tr td a", { timeout: 5000 }),
      page.waitForSelector("a[href]", { timeout: 5000 }),
    ]).catch(() => {});

    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    return await page.content();
  } finally {
    await browser.close();
  }
}

async function getHtmlWithFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "TransparencyRadarBot/1.0",
        Accept: "text/html",
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP fallback failed: ${res.status} ${res.statusText}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer).toString("utf8");
  } finally {
    clearTimeout(timeout);
  }
}

function parseItemsFromHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const rows = [];
  const seen = new Set();

  $("table tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 2) return;

    const num = $(tds[0]).text().trim();
    const dateStr = $(tds[1]).text().trim();
    const linkEl = $(tr).find("a[href]").first();

    const title = linkEl.text().trim();
    const href = linkEl.attr("href");

    if (!title || !href) return;

    const key = `${title}|${href}`;
    if (seen.has(key)) return;
    seen.add(key);

    rows.push({
      number: num || null,
      published_date: parseAlbanianDate_ddmmyyyy(dateStr),
      date_raw: dateStr || null,
      title,
      summary: null,
      title_normalized: normalizeTitle(title),
      source_url: href, // index.js resolves absolute URLs.
    });
  });

  if (rows.length > 0) return rows;

  // Fallback for non-table layouts: keep only document-like links.
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!isLikelyDocumentUrl(href)) return;

    const title = $(a).text().replace(/\s+/g, " ").trim() || String(href).trim();
    const abs = (() => {
      try {
        return new URL(href, baseUrl).toString();
      } catch {
        return href;
      }
    })();

    if (!title || !abs) return;
    if (seen.has(abs)) return;
    seen.add(abs);

    rows.push({
      number: null,
      published_date: null,
      date_raw: null,
      title,
      summary: null,
      title_normalized: normalizeTitle(title),
      source_url: href,
    });
  });

  return rows;
}

async function scrapeTiranaVendime({ year = 2026, limit = 50, urlOverride = null }) {
  const url =
    urlOverride ||
    `https://tirana.al/kategoria-e-publikimit/vendime-te-keshillit-bashkiak-${year}-4290`;

  let html = null;
  let lastError = null;
  let method = null;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      html = await getHtmlWithPlaywright(url);
      method = "playwright";
      break;
    } catch (err) {
      lastError = err;
      if (attempt < RETRY_ATTEMPTS) {
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  }

  if (!html) {
    try {
      html = await getHtmlWithFetch(url);
      method = "fetch_fallback";
    } catch (fallbackErr) {
      const first = String(lastError?.message || "unknown");
      const second = String(fallbackErr?.message || "unknown");
      throw new Error(`Tirana scrape failed. Playwright: ${first}. HTTP fallback: ${second}`);
    }
  }

  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const items = parseItemsFromHtml(html, url).slice(0, lim);
  return { url, method, items };
}

module.exports = { scrapeTiranaVendime };

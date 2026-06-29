// backend/scrapers/tiranaVendime.js

const cheerio = require("cheerio");

const NAV_TIMEOUT_MS = 45000;
const FETCH_TIMEOUT_MS = 25000;
const RETRY_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 1200;
const DEFAULT_INDEX_URL =
  "https://tirana.al/kategoria-e-publikimit/vendime-keshilli-bashkiak-77";
const SOURCE_ORIGIN = "tirana.al";
const CHALLENGE_MARKERS = ["Just a moment", "cf-chl", "challenge-platform", "cf-browser-verification"];

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
    /\.(pdf|doc|docx|rtf|xls|xlsx|zip)(\?|#|$)/i.test(s) ||
    /[?&](download|file|attachment_id)=/i.test(s) ||
    /\/download\/?/i.test(s)
  );
}

function hasChallengeMarkup(html) {
  const source = String(html || "");
  return CHALLENGE_MARKERS.some((marker) => source.includes(marker));
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
    const html = await page.content();
    if (hasChallengeMarkup(html)) {
      throw new Error("Tirana bot-detection challenge returned instead of page content");
    }
    return html;
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
    const html = Buffer.from(arrayBuffer).toString("utf8");
    if (hasChallengeMarkup(html)) {
      throw new Error("Tirana bot-detection challenge returned instead of page content");
    }
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

async function getHtml(url) {
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

  return { html, method };
}

function makeAbsolute(baseUrl, href) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function isDirectYearListingUrl(url, year) {
  try {
    const parsed = new URL(url);
    const path = String(parsed.pathname || "").toLowerCase();
    return path.includes(String(year)) && !path.endsWith("-77");
  } catch {
    return false;
  }
}

function discoverYearUrlFromIndexHtml(html, indexUrl, year) {
  const $ = cheerio.load(html);
  const candidates = [];
  const yearText = String(year);

  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    const abs = makeAbsolute(indexUrl, href);
    if (!abs) return;
    let parsed = null;
    try {
      parsed = new URL(abs);
    } catch {
      return;
    }
    if (parsed.hostname.toLowerCase() !== SOURCE_ORIGIN) return;

    const text = $(a).text().replace(/\s+/g, " ").trim().toLowerCase();
    let pathText = String(parsed.pathname || "").toLowerCase();
    try {
      pathText = decodeURIComponent(pathText).toLowerCase();
    } catch {}
    const haystack = `${text} ${pathText}`;
    if (!haystack.includes(yearText)) return;
    if (!haystack.includes("vendime") && !haystack.includes("keshill")) return;

    let score = 0;
    if (text.includes(yearText)) score += 20;
    if (haystack.includes("vendime-te-keshillit-bashkiak")) score += 30;
    if (haystack.includes("keshillit-bashkiak")) score += 10;
    candidates.push({ url: abs, score });
  });

  candidates.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return candidates[0]?.url || null;
}

async function resolveYearListingUrl({ indexUrl, year }) {
  if (isDirectYearListingUrl(indexUrl, year)) {
    return { url: indexUrl, indexMethod: null };
  }

  const index = await getHtml(indexUrl);
  const discovered = discoverYearUrlFromIndexHtml(index.html, indexUrl, year);
  if (!discovered) {
    throw new Error(`Tirana index did not expose a Vendime year URL for ${year}`);
  }
  return { url: discovered, indexMethod: index.method };
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
    const abs = makeAbsolute(baseUrl, href);

    if (!title || !abs) return;

    const key = `${title}|${abs}`;
    if (seen.has(key)) return;
    seen.add(key);

    rows.push({
      number: num || null,
      published_date: parseAlbanianDate_ddmmyyyy(dateStr),
      date_raw: dateStr || null,
      title,
      summary: null,
      title_normalized: normalizeTitle(title),
      source_url: abs,
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
      source_url: abs,
    });
  });

  return rows;
}

async function scrapeTiranaVendime({ year = 2026, limit = 50, urlOverride = null }) {
  const indexUrl = urlOverride || DEFAULT_INDEX_URL;
  const resolved = await resolveYearListingUrl({ indexUrl, year });
  const url = resolved.url;
  const page = await getHtml(url);
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const items = parseItemsFromHtml(page.html, url)
    .filter((item) => {
      const itemYear = Number.parseInt(String(item.published_date || "").slice(0, 4), 10);
      return Number.isFinite(itemYear) ? itemYear === Number(year) : true;
    })
    .slice(0, lim)
    .map((item) => ({
      ...item,
      source_page_url: url,
      source_origin: SOURCE_ORIGIN,
    }));

  if (items.length === 0) {
    throw new Error(`Tirana official scraper returned zero rows for ${year}`);
  }

  return {
    url,
    method: page.method,
    items,
    meta: {
      custom_official_scraper: true,
      index_url: indexUrl,
      index_method: resolved.indexMethod,
      source_origin: SOURCE_ORIGIN,
    },
  };
}

module.exports = { scrapeTiranaVendime };

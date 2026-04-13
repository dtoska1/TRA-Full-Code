"use strict";

const cheerio = require("cheerio");

const NAV_TIMEOUT_MS = 45000;
const FETCH_TIMEOUT_MS = 25000;
const RETRY_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 1200;
const DEFAULT_LISTING_URL = "https://vaudejes.gov.al/vendime/";
const DEFAULT_SOURCE_ORIGIN = "vaudejes.gov.al";
const DEFAULT_PAGE_SIZE = 20;
const DETAIL_CONCURRENCY = 4;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function makeAbsolute(baseUrl, href) {
  if (!href) return null;
  try {
    return new URL(String(href).trim(), baseUrl).toString();
  } catch {
    return null;
  }
}

function isLikelyDocumentUrl(href) {
  const s = String(href || "").toLowerCase();
  return (
    /\.(pdf|doc|docx|rtf|xls|xlsx)(\?|#|$)/i.test(s) ||
    /[?&](download|file|attachment_id)=/i.test(s) ||
    /\/download\/?/i.test(s)
  );
}

function extractNumberFromTitle(title) {
  const m =
    String(title || "").match(/^\s*([0-9]{1,5})\s*[\.)-]?\s*vendim\b/i) ||
    String(title || "").match(/\bnr\.?\s*([0-9]{1,5})\b/i);
  return m ? m[1] : null;
}

function parseMonthNameDate(text) {
  const months = {
    jan: "01",
    january: "01",
    feb: "02",
    february: "02",
    mar: "03",
    march: "03",
    apr: "04",
    april: "04",
    may: "05",
    jun: "06",
    june: "06",
    jul: "07",
    july: "07",
    aug: "08",
    august: "08",
    sep: "09",
    sept: "09",
    september: "09",
    oct: "10",
    october: "10",
    nov: "11",
    november: "11",
    dec: "12",
    december: "12",
  };

  const m = String(text || "")
    .trim()
    .match(/\b([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})\b/);
  if (!m) return null;
  const month = months[String(m[1] || "").toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${String(m[2]).padStart(2, "0")}`;
}

function parsePublishedDate(value) {
  const raw = cleanText(value);
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.slice(0, 10);

  let m = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = raw.match(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\b/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;

  return parseMonthNameDate(raw);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await mapper(items[current], current);
    }
  }

  const count = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

async function createContext() {
  let chromium = null;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    throw new Error(
      "Playwright is not installed. Run `cd backend && npm install playwright` first."
    );
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    locale: "sq-AL",
  });

  return { browser, context };
}

async function loadListingHtml(page, url) {
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT_MS,
  });

  if (!response || !response.ok()) {
    const status = response ? response.status() : "NO_RESPONSE";
    throw new Error(`Vau i Dejes Playwright navigation failed with status ${status}`);
  }

  await Promise.race([
    page.waitForSelector("table.posts-data-table tbody tr td a", { timeout: 7000 }),
    page.waitForSelector("table tbody tr td a", { timeout: 7000 }),
  ]).catch(() => {});

  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
  return page.content();
}

function buildListingPageUrl(siteUrl, pageNumber) {
  if (pageNumber <= 1) return siteUrl;
  return new URL(`page/${pageNumber}/`, siteUrl).toString();
}

function extractListingRows(html, listingUrl) {
  const $ = cheerio.load(html);
  const rows = [];

  $("table.posts-data-table tbody tr, table tbody tr").each((_, tr) => {
    const cells = $(tr).find("td");
    if (cells.length === 0) return;

    const titleAnchor =
      $(tr).find("td.col-title a[href]").first()[0] ||
      $(tr).find("td a[href]").filter((__, a) => cleanText($(a).text()).length > 0).first()[0];

    if (!titleAnchor) return;

    const href = $(titleAnchor).attr("href");
    const detailUrl = makeAbsolute(listingUrl, href);
    const title = cleanText($(titleAnchor).text());

    if (!detailUrl || !title) return;

    rows.push({
      title,
      detail_url: detailUrl,
      number: extractNumberFromTitle(title),
    });
  });

  return rows;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });

    if (!res.ok) {
      throw new Error(`Vau i Dejes detail fetch failed: ${res.status} ${res.statusText}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return {
      url: res.url || url,
      html: Buffer.from(arrayBuffer).toString("utf8"),
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`Vau i Dejes detail request timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function extractDocumentUrl($, pageUrl) {
  const scopedSelectors = [
    "article .entry-content a[href]",
    "article a[href]",
    ".et_pb_post .entry-content a[href]",
    ".et_pb_post a[href]",
  ];

  for (const selector of scopedSelectors) {
    let found = null;
    $(selector).each((_, a) => {
      if (found) return;
      const abs = makeAbsolute(pageUrl, $(a).attr("href"));
      if (!isLikelyDocumentUrl(abs)) return;
      found = abs;
    });
    if (found) return found;
  }

  return null;
}

function parseDetailPage(html, pageUrl, fallbackTitle, fallbackNumber) {
  const $ = cheerio.load(String(html || ""));

  const title =
    cleanText($("meta[property='og:title']").attr("content")) ||
    cleanText($("article h1, .et_pb_post h1, h1").first().text()) ||
    cleanText(fallbackTitle);

  const normalizedTitle = title
    ? cleanText(title.replace(/\s*\|\s*Bashkia Vau Dejes\s*$/i, ""))
    : null;

  const publishedDate =
    parsePublishedDate($("meta[property='article:published_time']").attr("content")) ||
    parsePublishedDate($("time[datetime]").first().attr("datetime")) ||
    parsePublishedDate(
      cleanText($("article, .et_pb_post").first().text()).slice(0, 240)
    ) ||
    null;

  const sourceUrl = extractDocumentUrl($, pageUrl) || pageUrl;

  return {
    title: normalizedTitle || cleanText(fallbackTitle),
    title_normalized: normalizeTitle(normalizedTitle || fallbackTitle),
    source_url: sourceUrl,
    source_page_url: DEFAULT_LISTING_URL,
    source_origin: DEFAULT_SOURCE_ORIGIN,
    published_date: publishedDate,
    number: fallbackNumber || extractNumberFromTitle(normalizedTitle || fallbackTitle),
  };
}

async function scrapeVauDejesVendime({ url, limit = 50, pageStart = 1 }) {
  const siteUrl = url || DEFAULT_LISTING_URL;
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const startPage = Math.max(1, Number(pageStart) || 1);

  let browser = null;
  let context = null;
  let page = null;

  let lastError = null;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    const items = [];
    const seen = new Set();
    let currentPageNumber = startPage;

    try {
      ({ browser, context } = await createContext());
      page = await context.newPage();
      page.setDefaultTimeout(NAV_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

      while (items.length < lim) {
        const listingUrl = buildListingPageUrl(siteUrl, currentPageNumber);
        const listingHtml = await loadListingHtml(page, listingUrl);
        const listingRows = extractListingRows(listingHtml, listingUrl);

        if (listingRows.length === 0) break;

        const remaining = lim - items.length;
        const pageRows = listingRows.slice(0, remaining);
        const pageResults = await mapWithConcurrency(
          pageRows,
          DETAIL_CONCURRENCY,
          async (row) => {
            const detail = await fetchText(row.detail_url);
            return {
              row,
              parsed: parseDetailPage(detail.html, detail.url, row.title, row.number),
            };
          }
        );

        for (const result of pageResults) {
          if (items.length >= lim) break;
          if (!result) continue;
          const { row, parsed } = result;
          const dedupeKey = `${row.detail_url}|${parsed.published_date || ""}`;

          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          items.push(parsed);
        }

        if (listingRows.length < DEFAULT_PAGE_SIZE) break;
        currentPageNumber += 1;
      }

      return { url: siteUrl, method: "playwright", items };
    } catch (err) {
      lastError = err;
      if (attempt < RETRY_ATTEMPTS) {
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      page = null;
      context = null;
      browser = null;
    }
  }

  throw lastError || new Error("Vau i Dejes scrape failed");
}

module.exports = { scrapeVauDejesVendime };

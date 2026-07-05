"use strict";

const cheerio = require("cheerio");
const { isLikelyDocumentAttachmentUrl } = require("../lib/documentAttachments");
const {
  classifyKind,
  cleanText,
  getHost,
  makeAbsolute,
  normalizeTitle,
  foldText,
} = require("./konsultimeUtils");

const DEFAULT_LISTING_URL = "https://bashkiashkoder.gov.al/keshillim-me-publikun/";
const SOURCE_ORIGIN = "bashkiashkoder.gov.al";
const YEAR_FLOOR = 2023;
const YEAR_FLOOR_DATE = `${YEAR_FLOOR}-01-01`;
const MAX_PAGES = 50;
const SCRAPE_REQUEST_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(String(process.env.SCRAPE_REQUEST_TIMEOUT_MS || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20000;
})();
const HTTP_HEADERS = {
  "User-Agent": "TransparencyRadar/0.1 (+contact@transparency-radar.al)",
  "Accept-Language": "sq-AL,sq;q=0.9,en;q=0.8",
  Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
};

const MONTHS = new Map([
  ["janar", "01"],
  ["shkurt", "02"],
  ["mars", "03"],
  ["prill", "04"],
  ["maj", "05"],
  ["qershor", "06"],
  ["korrik", "07"],
  ["gusht", "08"],
  ["shtator", "09"],
  ["tetor", "10"],
  ["nentor", "11"],
  ["dhjetor", "12"],
]);

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: HTTP_HEADERS,
    });
    const html = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      url: res.url || url,
      html,
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      const timeoutErr = new Error(`Request timed out after ${SCRAPE_REQUEST_TIMEOUT_MS}ms: ${url}`);
      timeoutErr.code = "TIMEOUT";
      timeoutErr.last_error_type = "TIMEOUT";
      timeoutErr.final_url = url;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isShkoderHost(host) {
  return host === SOURCE_ORIGIN || host === `www.${SOURCE_ORIGIN}`;
}

function normalizeShkoderDocumentUrl(href, baseUrl = DEFAULT_LISTING_URL) {
  const url = makeAbsolute(baseUrl, href);
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (!isShkoderHost(parsed.hostname.toLowerCase())) return null;
    parsed.hostname = SOURCE_ORIGIN;
    parsed.hash = "";
    const normalizedUrl = parsed.toString();
    return isLikelyDocumentAttachmentUrl(normalizedUrl) ? normalizedUrl : null;
  } catch {
    return null;
  }
}

function labelFromDocumentUrl(sourceUrl) {
  try {
    const lastSegment = new URL(sourceUrl).pathname.split("/").filter(Boolean).pop() || "";
    const decoded = decodeURIComponent(lastSegment)
      .replace(/\.[a-z0-9]{2,5}$/i, "")
      .replace(/[-_]+/g, " ");
    return cleanText(decoded) || "Dokument";
  } catch {
    return "Dokument";
  }
}

function collectShkoderKonsultimeDocuments($, pageUrl = DEFAULT_LISTING_URL) {
  const documents = [];
  const seen = new Set();
  const root = $("article, .entry-content, main");

  root.find("a[href]").each((_, el) => {
    const link = $(el);
    const url = normalizeShkoderDocumentUrl(link.attr("href") || "", pageUrl);
    if (!url || seen.has(url)) return;

    seen.add(url);
    documents.push({
      url,
      label: cleanText(link.text()) || labelFromDocumentUrl(url),
    });
  });

  return documents;
}

function parseShkoderListingDate(raw) {
  const match = cleanText(raw).match(/^(\d{1,2})\s+([^,]+),\s*(\d{4})$/);
  if (!match) return null;

  const [, dayRaw, monthRaw, year] = match;
  const day = Number.parseInt(dayRaw, 10);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  const month = MONTHS.get(foldText(monthRaw));
  if (!month) return null;

  return `${year}-${month}-${dayRaw.padStart(2, "0")}`;
}

function parseAllListingDates(html) {
  const $ = cheerio.load(html);
  const dates = [];
  $("div.article-paginated div.post-date").each((_, el) => {
    const date = parseShkoderListingDate($(el).text());
    if (date) dates.push(date);
  });
  return dates;
}

function getShkoderKonsultimeNextPageUrl(html, currentUrl = DEFAULT_LISTING_URL) {
  const $ = cheerio.load(html);
  const href = $("div.pagination a.next.page-numbers").first().attr("href") || "";
  return makeAbsolute(currentUrl, href);
}

function parseShkoderKonsultimeHtml(html, pageUrl = DEFAULT_LISTING_URL) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $("div.article-paginated").each((_, el) => {
    const article = $(el);
    const link = article.find("h4 a").first();
    const title = cleanText(link.text());
    const href = link.attr("href") || "";
    if (!title || !href) return;

    const sourceUrl = makeAbsolute(pageUrl, href);
    if (!sourceUrl || getHost(sourceUrl) !== SOURCE_ORIGIN) return;
    if (seen.has(sourceUrl)) return;
    seen.add(sourceUrl);

    const summary = cleanText(article.find("div.post-excerpt").first().text());
    const publishedDate = parseShkoderListingDate(article.find("div.post-date").first().text());
    if (!publishedDate || publishedDate < YEAR_FLOOR_DATE) return;

    items.push({
      title,
      title_normalized: normalizeTitle(title),
      summary: summary || null,
      published_date: publishedDate,
      source_url: sourceUrl,
      source_page_url: pageUrl,
      source_origin: SOURCE_ORIGIN,
      kind: classifyKind(title, summary),
      is_unofficial_proxy: false,
    });
  });

  return items;
}

async function scrapeShkoderKonsultime({ url, year, limit = 50, pageStart = 1 }) {
  const siteUrl = url || DEFAULT_LISTING_URL;
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const wantedYear = Number.isInteger(Number(year)) ? Number(year) : null;
  const startPage = Math.max(1, Number(pageStart) || 1);
  const items = [];
  const seenSourceUrls = new Set();
  const visitedPageUrls = new Set();
  let detailPagesFetched = 0;
  let detailFetchFailures = 0;
  let pageUrl = siteUrl;

  for (let page = 1; pageUrl && page <= MAX_PAGES && items.length < lim; page += 1) {
    if (visitedPageUrls.has(pageUrl)) break;
    visitedPageUrls.add(pageUrl);

    const fetched = await fetchHtml(pageUrl);
    if (!fetched.ok) {
      throw new Error(`Shkoder konsultime listing fetch failed: HTTP ${fetched.status}`);
    }
    const currentUrl = fetched.url || pageUrl;
    if (page < startPage) {
      pageUrl = getShkoderKonsultimeNextPageUrl(fetched.html, currentUrl);
      continue;
    }

    const pageItems = parseShkoderKonsultimeHtml(fetched.html, currentUrl);
    let newOnPage = 0;
    for (const item of pageItems) {
      if (items.length >= lim) break;
      if (wantedYear && Number(String(item.published_date).slice(0, 4)) !== wantedYear) continue;
      if (seenSourceUrls.has(item.source_url)) continue;
      seenSourceUrls.add(item.source_url);

      item.documents = [];
      try {
        const detailFetched = await fetchHtml(item.source_url);
        if (detailFetched.ok) {
          detailPagesFetched += 1;
          const $ = cheerio.load(detailFetched.html);
          item.documents = collectShkoderKonsultimeDocuments(
            $,
            detailFetched.url || item.source_url,
          );
        } else {
          detailFetchFailures += 1;
        }
      } catch {
        detailFetchFailures += 1;
      }

      items.push(item);
      newOnPage += 1;
    }

    if (page === startPage && pageItems.length === 0) {
      throw new Error("Shkoder official Konsultime scraper found no cards.");
    }

    const listingDates = parseAllListingDates(fetched.html);
    if (listingDates.length > 0 && listingDates.every((date) => date < YEAR_FLOOR_DATE)) {
      break;
    }

    const nextPageUrl = getShkoderKonsultimeNextPageUrl(fetched.html, currentUrl);
    if (!nextPageUrl || visitedPageUrls.has(nextPageUrl)) break;
    if (pageItems.length > 0 && newOnPage === 0 && !wantedYear) break;
    pageUrl = nextPageUrl;
  }

  return {
    url: siteUrl,
    items,
    meta: {
      source_origin: SOURCE_ORIGIN,
      custom_official_scraper: true,
      visited_pages: visitedPageUrls.size,
      detail_pages_fetched: detailPagesFetched,
      detail_fetch_failures: detailFetchFailures,
      document_links: items.reduce(
        (total, item) => total + (Array.isArray(item.documents) ? item.documents.length : 0),
        0,
      ),
    },
  };
}

module.exports = {
  classifyKind,
  collectShkoderKonsultimeDocuments,
  foldText,
  getShkoderKonsultimeNextPageUrl,
  normalizeShkoderDocumentUrl,
  parseShkoderKonsultimeHtml,
  parseShkoderListingDate,
  scrapeShkoderKonsultime,
};

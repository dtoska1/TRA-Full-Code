"use strict";

const cheerio = require("cheerio");
const { isLikelyDocumentAttachmentUrl } = require("../lib/documentAttachments");
const {
  classifyKind,
  cleanText,
  getHost,
  makeAbsolute,
  normalizeTitle,
} = require("./konsultimeUtils");

const DEFAULT_LISTING_URL = "https://bashkiapogradec.gov.al/publikime-kategori/konsultim-publik-10/";
const SOURCE_ORIGIN = "bashkiapogradec.gov.al";
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

function isPogradecHost(host) {
  return host === SOURCE_ORIGIN || host === `www.${SOURCE_ORIGIN}`;
}

function normalizePogradecDocumentUrl(href, baseUrl = DEFAULT_LISTING_URL) {
  const url = makeAbsolute(baseUrl, href);
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (!isPogradecHost(parsed.hostname.toLowerCase())) return null;
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

function collectRawDocumentUrls(value) {
  return (
    String(value || "").match(
      /https?:\/\/[^\s"'<>]+?\.(?:pdf|docx?|zip)(?:[?#][^\s"'<>]*)?/gi,
    ) || []
  );
}

function collectPogradecKonsultimeDocuments($, pageUrl = DEFAULT_LISTING_URL) {
  const documents = [];
  const seen = new Set();
  const scopes = $("article, .entry-content, main, section.single-content, .single-content");
  const root = scopes.length ? scopes : $("body");

  function addDocument(url, label) {
    const normalizedUrl = normalizePogradecDocumentUrl(url, pageUrl);
    if (!normalizedUrl || seen.has(normalizedUrl)) return;
    seen.add(normalizedUrl);
    documents.push({
      url: normalizedUrl,
      label: cleanText(label) || labelFromDocumentUrl(normalizedUrl),
    });
  }

  root.find("a[href]").each((_, el) => {
    const link = $(el);
    addDocument(link.attr("href") || "", link.text());
  });

  root.each((_, el) => {
    const node = $(el);
    const scopedHtml = `${node.html() || ""} ${node.text() || ""}`;
    for (const rawUrl of collectRawDocumentUrls(scopedHtml)) {
      addDocument(rawUrl, "");
    }
  });

  return documents;
}

function parsePogradecListingDate(raw) {
  const match = cleanText(raw).match(/\b(\d{1,2})-(\d{1,2})-(\d{4})\b/);
  if (!match) return null;

  const [, dayRaw, monthRaw, year] = match;
  const day = Number.parseInt(dayRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function collectNearbyText($, section) {
  const chunks = [];
  let cursor = section;
  for (let i = 0; i < 3 && cursor.length; i += 1) {
    chunks.push(cursor.text());
    cursor = cursor.next("section");
  }
  return cleanText(chunks.join(" "));
}

function parseAllListingDates(html) {
  const matches = String(html || "").match(/\b\d{1,2}-\d{1,2}-\d{4}\b/g) || [];
  return matches.map(parsePogradecListingDate).filter(Boolean);
}

function getPogradecKonsultimeNextPageUrl(html, currentUrl = DEFAULT_LISTING_URL) {
  const $ = cheerio.load(html);
  const currentWithoutHash = String(currentUrl || "").split("#")[0];
  const candidates = [
    "nav.pagination a.next",
    "div.pagination a.next",
    "a.next.page-numbers",
    "a[rel='next']",
  ];

  for (const selector of candidates) {
    const href = $(selector).first().attr("href") || "";
    const nextUrl = makeAbsolute(currentUrl, href);
    if (!nextUrl || getHost(nextUrl) !== SOURCE_ORIGIN) continue;
    if (nextUrl.split("#")[0] === currentWithoutHash) continue;
    return nextUrl;
  }

  return null;
}

function parsePogradecKonsultimeHtml(html, pageUrl = DEFAULT_LISTING_URL) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('h3.grid-title a[href*="/publikime/konsultim-publik-10/"]').each((_, el) => {
    const link = $(el);
    const title = cleanText(link.text());
    const href = link.attr("href") || "";
    if (!title || !href) return;

    const sourceUrl = makeAbsolute(pageUrl, href);
    if (!sourceUrl || getHost(sourceUrl) !== SOURCE_ORIGIN) return;
    if (seen.has(sourceUrl)) return;
    seen.add(sourceUrl);

    const section = link.closest("section");
    const summary = cleanText(section.find("p").first().text());
    const nearbyText = collectNearbyText($, section);
    const publishedDate = parsePogradecListingDate(nearbyText);
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

async function scrapePogradecKonsultime({ url, year, limit = 50, pageStart = 1 }) {
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
      throw new Error(`Pogradec konsultime listing fetch failed: HTTP ${fetched.status}`);
    }
    const currentUrl = fetched.url || pageUrl;
    if (page < startPage) {
      pageUrl = getPogradecKonsultimeNextPageUrl(fetched.html, currentUrl);
      continue;
    }

    const pageItems = parsePogradecKonsultimeHtml(fetched.html, currentUrl);
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
          item.documents = collectPogradecKonsultimeDocuments(
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
      throw new Error("Pogradec official Konsultime scraper found no cards.");
    }

    const listingDates = parseAllListingDates(fetched.html);
    if (listingDates.length > 0 && listingDates.every((date) => date < YEAR_FLOOR_DATE)) {
      break;
    }

    const nextPageUrl = getPogradecKonsultimeNextPageUrl(fetched.html, currentUrl);
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
  collectPogradecKonsultimeDocuments,
  getPogradecKonsultimeNextPageUrl,
  normalizePogradecDocumentUrl,
  parsePogradecKonsultimeHtml,
  parsePogradecListingDate,
  scrapePogradecKonsultime,
};

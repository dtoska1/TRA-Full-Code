"use strict";

const cheerio = require("cheerio");
const {
  classifyKind,
  cleanText,
  foldText,
  getHost,
  makeAbsolute,
  normalizeTitle,
} = require("./konsultimeUtils");

const DEFAULT_LISTING_URL = "https://durres.gov.al/konsultimet-publike/";
const SOURCE_ORIGIN = "durres.gov.al";
const YEAR_FLOOR = 2023;
const YEAR_FLOOR_DATE = `${YEAR_FLOOR}-01-01`;
const MAX_PAGES = 50;
const DETAIL_PATH_RE = /^\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/?$/;
const DOCUMENT_EXT_RE = /\.(pdf|doc|docx|xls|xlsx|zip)$/i;
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

function isDurresHost(host) {
  return host === SOURCE_ORIGIN || host === `www.${SOURCE_ORIGIN}`;
}

function normalizeDurresDetailUrl(href, baseUrl = DEFAULT_LISTING_URL) {
  const url = makeAbsolute(baseUrl, href);
  if (!url) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!isDurresHost(parsed.hostname.toLowerCase())) return null;
  if (parsed.pathname.includes("/wp-content/uploads/")) return null;
  if (DOCUMENT_EXT_RE.test(parsed.pathname)) return null;
  if (!DETAIL_PATH_RE.test(parsed.pathname)) return null;
  parsed.hash = "";
  return parsed.toString();
}

function normalizeFinalUrl(value, baseUrl = DEFAULT_LISTING_URL) {
  const url = makeAbsolute(baseUrl, value);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!isDurresHost(parsed.hostname.toLowerCase())) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseDurresKonsultimeListingHtml(html, pageUrl = DEFAULT_LISTING_URL) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const urls = [];

  $("a[href]").each((_, el) => {
    const detailUrl = normalizeDurresDetailUrl($(el).attr("href") || "", pageUrl);
    if (!detailUrl || seen.has(detailUrl)) return;
    seen.add(detailUrl);
    urls.push(detailUrl);
  });

  return urls;
}

function parseIsoPublishedDate(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function parseVisibleAlbanianDate(raw) {
  const match = cleanText(raw).match(/\b(\d{1,2})\s+([\p{L}]+),\s*(\d{4})\b/u);
  if (!match) return null;

  const [, dayRaw, monthRaw, year] = match;
  const day = Number.parseInt(dayRaw, 10);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  const month = MONTHS.get(foldText(monthRaw));
  if (!month) return null;

  return `${year}-${month}-${dayRaw.padStart(2, "0")}`;
}

function parsePermalinkDate(value) {
  const url = normalizeFinalUrl(value);
  if (!url) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const match = parsed.pathname.match(/^\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function flattenJsonLd(value) {
  if (Array.isArray(value)) return value.flatMap((item) => flattenJsonLd(item));
  if (!value || typeof value !== "object") return [];

  const nodes = [value];
  const graph = value["@graph"];
  if (Array.isArray(graph)) nodes.push(...graph.flatMap((item) => flattenJsonLd(item)));
  else if (graph && typeof graph === "object") nodes.push(...flattenJsonLd(graph));
  return nodes;
}

function extractJsonLdMetadata($) {
  const metadata = { datePublished: null, title: null };

  $('script[type="application/ld+json"]').each((_, el) => {
    let parsed;
    try {
      parsed = JSON.parse($(el).text());
    } catch {
      return;
    }

    for (const node of flattenJsonLd(parsed)) {
      const title =
        typeof node.headline === "string"
          ? cleanText(node.headline)
          : typeof node.name === "string"
            ? cleanText(node.name)
            : "";
      if (!metadata.title && title) metadata.title = title;

      if (typeof node.datePublished === "string") {
        const datePublished = parseIsoPublishedDate(node.datePublished);
        if (datePublished) {
          metadata.datePublished ||= datePublished;
          if (title) {
            metadata.datePublished = datePublished;
            metadata.title = title;
            return false;
          }
        }
      }
    }
  });

  return metadata;
}

function firstUsefulParagraph($) {
  const paragraphs = [];
  $("article p, .entry-content p, .elementor-widget-theme-post-content p, main p").each((_, el) => {
    const text = cleanText($(el).text());
    if (text) paragraphs.push(text);
  });
  return paragraphs.find((text) => text.length >= 20) || paragraphs[0] || "";
}

function parseDurresKonsultimeDetailHtml(html, finalUrl, sourcePageUrl = DEFAULT_LISTING_URL) {
  const sourceUrl = normalizeFinalUrl(finalUrl);
  if (!sourceUrl) return null;

  const $ = cheerio.load(html);
  const jsonLd = extractJsonLdMetadata($);
  const title =
    cleanText($("h1.entry-title, h1.elementor-heading-title, .entry-title h1, h1").first().text()) ||
    jsonLd.title;
  if (!title) return null;

  const summary = firstUsefulParagraph($);
  const visibleDateText = [
    $("time").first().text(),
    $(".elementor-post-info__item--type-date").first().text(),
    $(".posted-on, .entry-date, .post-date").first().text(),
    $("body").text(),
  ].join(" ");
  const publishedDate =
    jsonLd.datePublished || parseVisibleAlbanianDate(visibleDateText) || parsePermalinkDate(sourceUrl);
  if (!publishedDate || publishedDate < YEAR_FLOOR_DATE) return null;

  return {
    title,
    title_normalized: normalizeTitle(title),
    summary: summary || null,
    published_date: publishedDate,
    source_url: sourceUrl,
    source_page_url: sourcePageUrl,
    source_origin: SOURCE_ORIGIN,
    kind: classifyKind(title, `${summary} ${$("body").text()}`),
    is_unofficial_proxy: false,
  };
}

function getDurresKonsultimeNextPageUrl(html, currentUrl = DEFAULT_LISTING_URL) {
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
    if (!nextUrl || !isDurresHost(getHost(nextUrl))) continue;
    if (nextUrl.split("#")[0] === currentWithoutHash) continue;
    return nextUrl;
  }

  return null;
}

async function scrapeDurresKonsultime({ url, year, limit = 50, pageStart = 1 }) {
  const siteUrl = url || DEFAULT_LISTING_URL;
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const wantedYear = Number.isInteger(Number(year)) ? Number(year) : null;
  const startPage = Math.max(1, Number(pageStart) || 1);
  const items = [];
  const seenSourceUrls = new Set();
  const visitedPageUrls = new Set();
  let pageUrl = siteUrl;

  for (let page = 1; pageUrl && page <= MAX_PAGES && items.length < lim; page += 1) {
    if (visitedPageUrls.has(pageUrl)) break;
    visitedPageUrls.add(pageUrl);

    const fetched = await fetchHtml(pageUrl);
    if (!fetched.ok) {
      throw new Error(`Durres konsultime listing fetch failed: HTTP ${fetched.status}`);
    }
    const currentUrl = fetched.url || pageUrl;
    if (page < startPage) {
      pageUrl = getDurresKonsultimeNextPageUrl(fetched.html, currentUrl);
      continue;
    }

    const detailUrls = parseDurresKonsultimeListingHtml(fetched.html, currentUrl);
    if (page === startPage && detailUrls.length === 0) {
      throw new Error("Durres official Konsultime scraper found no detail-post URLs.");
    }

    let newOnPage = 0;
    for (const detailUrl of detailUrls) {
      if (items.length >= lim) break;
      if (seenSourceUrls.has(detailUrl)) continue;

      let item = null;
      try {
        const detailFetched = await fetchHtml(detailUrl);
        if (!detailFetched.ok) continue;
        item = parseDurresKonsultimeDetailHtml(
          detailFetched.html,
          detailFetched.url || detailUrl,
          currentUrl,
        );
      } catch {
        item = null;
      }
      if (!item) continue;
      if (wantedYear && Number(String(item.published_date).slice(0, 4)) !== wantedYear) continue;
      if (seenSourceUrls.has(item.source_url)) continue;
      seenSourceUrls.add(item.source_url);
      items.push(item);
      newOnPage += 1;
    }

    const nextPageUrl = getDurresKonsultimeNextPageUrl(fetched.html, currentUrl);
    if (!nextPageUrl || visitedPageUrls.has(nextPageUrl)) break;
    if (detailUrls.length > 0 && newOnPage === 0 && !wantedYear) break;
    pageUrl = nextPageUrl;
  }

  return {
    url: siteUrl,
    items,
    meta: {
      source_origin: SOURCE_ORIGIN,
      custom_official_scraper: true,
      visited_pages: visitedPageUrls.size,
    },
  };
}

module.exports = {
  classifyKind,
  getDurresKonsultimeNextPageUrl,
  normalizeDurresDetailUrl,
  parseDurresKonsultimeDetailHtml,
  parseDurresKonsultimeListingHtml,
  parseIsoPublishedDate,
  parsePermalinkDate,
  parseVisibleAlbanianDate,
  scrapeDurresKonsultime,
};

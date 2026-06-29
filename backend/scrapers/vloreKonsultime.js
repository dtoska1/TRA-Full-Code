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

const DEFAULT_LISTING_URL = "https://vlora.gov.al/category/degjesat-publike/";
const REGISTER_URL =
  "https://vlora.gov.al/regjistri-i-projekt-akteve-per-konsultim-publik-te-keshillit-bashkiak/";
const SOURCE_ORIGIN = "vlora.gov.al";
const YEAR_FLOOR = 2023;
const YEAR_FLOOR_DATE = `${YEAR_FLOOR}-01-01`;
const MAX_PAGES = 50;
const URL_RE = /https?:\/\/[^\s<>"')]+/i;
const SCRAPE_REQUEST_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(String(process.env.SCRAPE_REQUEST_TIMEOUT_MS || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20000;
})();
const HTTP_HEADERS = {
  "User-Agent": "TransparencyRadar/0.1 (+contact@transparency-radar.al)",
  "Accept-Language": "sq-AL,sq;q=0.9,en;q=0.8",
  Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
};

const EN_MONTHS = new Map([
  ["january", "01"],
  ["february", "02"],
  ["march", "03"],
  ["april", "04"],
  ["may", "05"],
  ["june", "06"],
  ["july", "07"],
  ["august", "08"],
  ["september", "09"],
  ["october", "10"],
  ["november", "11"],
  ["december", "12"],
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

function isVloreHost(host) {
  return host === SOURCE_ORIGIN || host === `www.${SOURCE_ORIGIN}`;
}

function normalizeVloreUrl(href, baseUrl = DEFAULT_LISTING_URL) {
  const url = makeAbsolute(baseUrl, href);
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (!isVloreHost(parsed.hostname.toLowerCase())) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseVloreRegisterDate(raw) {
  const match = cleanText(raw).match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/);
  if (!match) return null;

  const [, dayRaw, monthRaw, year] = match;
  const day = Number.parseInt(dayRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseVloreCategoryDate(raw) {
  const match = cleanText(raw).match(/\b([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\b/);
  if (!match) return null;

  const [, monthRaw, dayRaw, year] = match;
  const month = EN_MONTHS.get(foldText(monthRaw));
  const day = Number.parseInt(dayRaw, 10);
  if (!month) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  return `${year}-${month}-${dayRaw.padStart(2, "0")}`;
}

function stripTrailingPunctuation(value) {
  return String(value || "").trim().replace(/[),.;]+$/g, "");
}

function extractVloreRegisterUrl(anchorHref, text) {
  const rawUrl = cleanText(anchorHref || "") || (String(text || "").match(URL_RE) || [])[0] || "";
  if (!rawUrl) return null;
  return normalizeVloreUrl(stripTrailingPunctuation(rawUrl), REGISTER_URL);
}

function isMeaningfulTitle(value) {
  const normalized = cleanText(value);
  if (normalized.length < 4) return false;

  const folded = foldText(normalized);
  if (folded.startsWith("http")) return false;
  return !new Set(["link", "shkarko", "download", "ketu", "kliko ketu", "pdf"]).has(folded);
}

function deriveVloreRegisterTitle(cellText, sourceUrl) {
  const withoutUrls = cleanText(String(cellText || "").replace(URL_RE, " "));
  if (isMeaningfulTitle(withoutUrls)) return withoutUrls;

  try {
    const url = new URL(sourceUrl);
    const lastSegment = url.pathname.split("/").filter(Boolean).pop();
    if (!lastSegment) return null;

    const decoded = decodeURIComponent(lastSegment)
      .replace(/\.[a-z0-9]{2,5}$/i, "")
      .replace(/[-_]+/g, " ");
    const title = cleanText(decoded);
    return isMeaningfulTitle(title) ? title : null;
  } catch {
    return null;
  }
}

function isGenericCategorySummary(value) {
  const folded = foldText(value);
  if (!folded) return true;
  return ["degjesat publike", "njoftime", "degjesat publike njoftime"].includes(
    folded.replace(/\s*\/\s*/g, " "),
  );
}

function getPostLink(post) {
  const selectors = [
    "h1 a[href]",
    "h2 a[href]",
    "h3 a[href]",
    ".entry-title a[href]",
    "a[href]",
  ];
  for (const selector of selectors) {
    const link = post.find(selector).first();
    if (link.length) return link;
  }
  return null;
}

function parseVloreCategoryHtml(html, pageUrl = DEFAULT_LISTING_URL) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const items = [];

  $("article, .elementor-post, .type-post").each((_, el) => {
    const post = $(el);
    const link = getPostLink(post);
    if (!link) return;
    const sourceUrl = normalizeVloreUrl(link.attr("href") || "", pageUrl);
    const title = cleanText(link.text()) || cleanText(post.find("h1,h2,h3,.entry-title").first().text());
    if (!sourceUrl || !title || seen.has(sourceUrl)) return;

    const dateText = cleanText(
      [
        post.find("time").first().text(),
        post.find(".entry-date").first().text(),
        post.find(".posted-on").first().text(),
        post.find(".post-date").first().text(),
      ].join(" "),
    );
    const publishedDate = parseVloreCategoryDate(dateText || post.text());
    if (!publishedDate || publishedDate < YEAR_FLOOR_DATE) return;

    const rawSummary = cleanText(
      post.find(".entry-summary,.post-excerpt,.excerpt,p").first().text(),
    );
    const summary = isGenericCategorySummary(rawSummary) ? null : rawSummary;

    seen.add(sourceUrl);
    items.push({
      title,
      title_normalized: normalizeTitle(title),
      summary,
      published_date: publishedDate,
      source_url: sourceUrl,
      source_page_url: pageUrl,
      source_origin: SOURCE_ORIGIN,
      kind: classifyKind(title, summary || ""),
      is_unofficial_proxy: false,
    });
  });

  return items;
}

function parseVloreRegisterHtml(html, pageUrl = REGISTER_URL) {
  const $ = cheerio.load(html);
  const table = $("table#tablepress-7, table.tablepress-7, table.tablepress-id-7").first();
  if (table.length === 0) return [];

  const items = [];
  const seen = new Set();
  const rows = table.find("tbody tr").length > 0 ? table.find("tbody tr") : table.find("tr");
  rows.each((_, row) => {
    const cells = $(row).children("td");
    if (cells.length < 2) return;

    const sourceCell = cells.eq(0);
    const sourceUrl = extractVloreRegisterUrl(
      sourceCell.find("a[href]").first().attr("href") || null,
      sourceCell.text(),
    );
    if (!sourceUrl || seen.has(sourceUrl)) return;

    const publishedDate = parseVloreRegisterDate(cells.eq(1).text());
    if (!publishedDate || publishedDate < YEAR_FLOOR_DATE) return;

    const title = deriveVloreRegisterTitle(sourceCell.text(), sourceUrl);
    if (!title) return;

    seen.add(sourceUrl);
    items.push({
      title,
      title_normalized: normalizeTitle(title),
      summary: null,
      published_date: publishedDate,
      source_url: sourceUrl,
      source_page_url: pageUrl,
      source_origin: SOURCE_ORIGIN,
      kind: "draft_act",
      is_unofficial_proxy: false,
    });
  });

  return items;
}

function getVloreKonsultimeNextPageUrl(html, currentUrl = DEFAULT_LISTING_URL) {
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
    const nextUrl = normalizeVloreUrl(href, currentUrl);
    if (!nextUrl) continue;
    if (nextUrl.split("#")[0] === currentWithoutHash) continue;
    return nextUrl;
  }

  return null;
}

function mergeVloreItems(categoryItems, registerItems, { year = null, limit = 50 } = {}) {
  const wantedYear = Number.isInteger(Number(year)) ? Number(year) : null;
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const items = [];
  const seen = new Set();

  for (const item of [...categoryItems, ...registerItems]) {
    if (items.length >= lim) break;
    if (!item?.source_url || seen.has(item.source_url)) continue;
    if (wantedYear && Number(String(item.published_date).slice(0, 4)) !== wantedYear) continue;
    seen.add(item.source_url);
    items.push(item);
  }

  return items;
}

async function scrapeVloreKonsultime({ url, year, limit = 50, pageStart = 1 }) {
  const siteUrl = url || DEFAULT_LISTING_URL;
  const startPage = Math.max(1, Number(pageStart) || 1);
  const categoryItems = [];
  const visitedPageUrls = new Set();
  let pageUrl = siteUrl;

  for (let page = 1; pageUrl && page <= MAX_PAGES; page += 1) {
    if (visitedPageUrls.has(pageUrl)) break;
    visitedPageUrls.add(pageUrl);

    const fetched = await fetchHtml(pageUrl);
    if (!fetched.ok) {
      throw new Error(`Vlore konsultime category fetch failed: HTTP ${fetched.status}`);
    }
    const currentUrl = fetched.url || pageUrl;
    if (page >= startPage) {
      categoryItems.push(...parseVloreCategoryHtml(fetched.html, currentUrl));
    }

    const nextPageUrl = getVloreKonsultimeNextPageUrl(fetched.html, currentUrl);
    if (!nextPageUrl || visitedPageUrls.has(nextPageUrl)) break;
    pageUrl = nextPageUrl;
  }

  let registerItems = [];
  try {
    const fetchedRegister = await fetchHtml(REGISTER_URL);
    if (fetchedRegister.ok) {
      registerItems = parseVloreRegisterHtml(fetchedRegister.html, fetchedRegister.url || REGISTER_URL);
    }
  } catch {
    registerItems = [];
  }

  const items = mergeVloreItems(categoryItems, registerItems, { year, limit });

  return {
    url: siteUrl,
    items,
    meta: {
      source_origin: SOURCE_ORIGIN,
      custom_official_scraper: true,
      visited_pages: visitedPageUrls.size,
      category_items: categoryItems.length,
      register_items: registerItems.length,
    },
  };
}

module.exports = {
  classifyKind,
  deriveVloreRegisterTitle,
  extractVloreRegisterUrl,
  getVloreKonsultimeNextPageUrl,
  isMeaningfulTitle,
  mergeVloreItems,
  parseVloreCategoryDate,
  parseVloreCategoryHtml,
  parseVloreRegisterDate,
  parseVloreRegisterHtml,
  scrapeVloreKonsultime,
};

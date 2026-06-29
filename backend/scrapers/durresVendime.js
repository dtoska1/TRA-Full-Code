"use strict";

const cheerio = require("cheerio");
const {
  cleanText,
  fetchText,
  getHost,
  isLikelyDocumentUrl,
  isSupportedVendimeYear,
  makeAbsolute,
  normalizeTitle,
  numberFromText,
  parseAlbanianNumericDate,
} = require("./officialVendimeUtils");

const DEFAULT_LISTING_URL = "https://durres.gov.al/vendime-te-keshillit-bashkiak-2/";
const SOURCE_ORIGIN = "durres.gov.al";

function parseTableRow($, row, listingUrl) {
  const cells = $(row).find("td");
  if (cells.length < 4) return null;

  const number = numberFromText(cleanText(cells.eq(0).text()));
  const publishedDate = parseAlbanianNumericDate(cleanText(cells.eq(1).text()));
  const title = cleanText(cells.eq(2).text()) || `VKB nr ${number || ""} date ${publishedDate || ""}`;
  const link =
    cells.eq(3).find("a[href]").first().attr("href") ||
    $(row)
      .find("a[href]")
      .toArray()
      .map((anchor) => $(anchor).attr("href"))
      .find((href) => isLikelyDocumentUrl(href));
  const sourceUrl = makeAbsolute(listingUrl, link);

  if (!number || !publishedDate || !sourceUrl) return null;
  if (!isSupportedVendimeYear(publishedDate)) return null;
  if (getHost(sourceUrl) !== SOURCE_ORIGIN) return null;
  if (!isLikelyDocumentUrl(sourceUrl)) return null;

  return {
    number,
    published_date: publishedDate,
    title,
    title_normalized: normalizeTitle(title),
    source_url: sourceUrl,
    source_page_url: listingUrl,
    source_origin: SOURCE_ORIGIN,
  };
}

function parseFallbackDocumentAnchor($, anchor, listingUrl) {
  const href = $(anchor).attr("href");
  const sourceUrl = makeAbsolute(listingUrl, href);
  if (!sourceUrl || getHost(sourceUrl) !== SOURCE_ORIGIN || !isLikelyDocumentUrl(sourceUrl)) {
    return null;
  }

  const text = cleanText($(anchor).text());
  const fileName = (() => {
    try {
      return decodeURIComponent(new URL(sourceUrl).pathname.split("/").pop() || "");
    } catch {
      return "";
    }
  })();
  const number = numberFromText(text) || numberFromText(fileName);
  const publishedDate = parseAlbanianNumericDate(text) || parseAlbanianNumericDate(fileName);
  if (!number || !publishedDate || !isSupportedVendimeYear(publishedDate)) return null;

  const title = text || `VKB nr ${number} date ${publishedDate}`;
  return {
    number,
    published_date: publishedDate,
    title,
    title_normalized: normalizeTitle(title),
    source_url: sourceUrl,
    source_page_url: listingUrl,
    source_origin: SOURCE_ORIGIN,
  };
}

async function scrapeDurresVendime({ url, year, limit = 50 }) {
  const siteUrl = url || DEFAULT_LISTING_URL;
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const wantedYear = Number.isInteger(Number(year)) ? Number(year) : null;
  const fetched = await fetchText(siteUrl);
  if (!fetched.ok) {
    throw new Error(`Durres listing fetch failed: HTTP ${fetched.status}`);
  }

  const listingUrl = fetched.url || siteUrl;
  const $ = cheerio.load(fetched.text);
  const seen = new Set();
  const items = [];

  $("table tr").each((_, row) => {
    if (items.length >= lim) return;
    const parsed = parseTableRow($, row, listingUrl);
    if (!parsed) return;
    if (wantedYear && Number(String(parsed.published_date).slice(0, 4)) !== wantedYear) return;
    if (seen.has(parsed.source_url)) return;
    seen.add(parsed.source_url);
    items.push(parsed);
  });

  if (items.length === 0) {
    $('a[href*="/wp-content/uploads/"]').each((_, anchor) => {
      if (items.length >= lim) return;
      const parsed = parseFallbackDocumentAnchor($, anchor, listingUrl);
      if (!parsed) return;
      if (wantedYear && Number(String(parsed.published_date).slice(0, 4)) !== wantedYear) return;
      if (seen.has(parsed.source_url)) return;
      seen.add(parsed.source_url);
      items.push(parsed);
    });
  }

  if (items.length === 0) {
    throw new Error("Durres official scraper found no decision rows.");
  }

  return {
    url: listingUrl,
    items,
    meta: {
      custom_official_scraper: true,
      source_origin: SOURCE_ORIGIN,
    },
  };
}

module.exports = { scrapeDurresVendime };

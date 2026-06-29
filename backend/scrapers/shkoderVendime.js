"use strict";

const cheerio = require("cheerio");
const {
  cleanText,
  fetchText,
  getHost,
  isSupportedVendimeYear,
  makeAbsolute,
  normalizeTitle,
  numberFromText,
  parseAlbanianNumericDate,
} = require("./officialVendimeUtils");

const DEFAULT_LISTING_URL = "https://bashkiashkoder.gov.al/vendimet-e-keshillit-bashkiak-2/";
const SOURCE_ORIGIN = "bashkiashkoder.gov.al";
const MAX_PAGES = 20;

function parseListingEntry($, anchor, listingUrl) {
  const href = $(anchor).attr("href");
  const postUrl = makeAbsolute(listingUrl, href);
  if (!postUrl || getHost(postUrl) !== SOURCE_ORIGIN) return null;

  const heading = cleanText($(anchor).text());
  const number = numberFromText(heading);
  const publishedDate = parseAlbanianNumericDate(heading);
  if (!number || !publishedDate || !isSupportedVendimeYear(publishedDate)) return null;

  const container = $(anchor).closest("article, .elementor-post, .post, li, .post-content");
  const summary =
    cleanText(container.find(".entry-summary, .elementor-post__excerpt").text()) ||
    cleanText(container.find("p").not(":has(a)").first().text());
  const title = summary || heading || `VKB nr ${number} date ${publishedDate}`;

  return {
    postUrl,
    number,
    published_date: publishedDate,
    title,
    title_normalized: normalizeTitle(title),
  };
}

function extractListingEntries(html, listingUrl) {
  const $ = cheerio.load(html);
  const entries = [];
  const seen = new Set();

  $('a[href*="/vendime_te_keshillit/"]').each((_, anchor) => {
    const entry = parseListingEntry($, anchor, listingUrl);
    if (!entry || seen.has(entry.postUrl)) return;
    seen.add(entry.postUrl);
    entries.push(entry);
  });

  return entries;
}

async function resolveDocumentUrl(postUrl) {
  const fetched = await fetchText(postUrl);
  if (!fetched.ok) {
    throw new Error(`Shkoder detail fetch failed: HTTP ${fetched.status}`);
  }

  const $ = cheerio.load(fetched.text);
  let found = null;
  $('a[href*="/wp-content/uploads/"]').each((_, anchor) => {
    if (found) return;
    const href = $(anchor).attr("href");
    const abs = makeAbsolute(fetched.url || postUrl, href);
    if (!abs) return;
    if (getHost(abs) !== SOURCE_ORIGIN) return;
    if (!/\.pdf(\?|#|$)/i.test(abs)) return;
    found = abs;
  });

  return found;
}

async function scrapeShkoderVendime({ url, year, limit = 50, pageStart = 1 }) {
  const siteUrl = url || DEFAULT_LISTING_URL;
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const startPage = Math.max(1, Number(pageStart) || 1);
  const wantedYear = Number.isInteger(Number(year)) ? Number(year) : null;
  const items = [];
  const seenDocs = new Set();

  for (let page = startPage; page < startPage + MAX_PAGES && items.length < lim; page += 1) {
    const listingUrl = page === 1 ? siteUrl : new URL(`page/${page}/`, siteUrl).toString();
    const fetched = await fetchText(listingUrl);
    if (!fetched.ok) {
      if (page === startPage) throw new Error(`Shkoder listing fetch failed: HTTP ${fetched.status}`);
      break;
    }

    const entries = extractListingEntries(fetched.text, fetched.url || listingUrl);
    if (entries.length === 0) {
      if (page === startPage && items.length === 0) {
        throw new Error("Shkoder official scraper found no decision links.");
      }
      break;
    }

    for (const entry of entries) {
      if (items.length >= lim) break;
      if (wantedYear && Number(String(entry.published_date).slice(0, 4)) !== wantedYear) continue;

      let documentUrl = null;
      try {
        documentUrl = await resolveDocumentUrl(entry.postUrl);
      } catch (err) {
        console.warn(`[shkoderVendime] document lookup failed url=${entry.postUrl} err=${err.message}`);
      }
      if (!documentUrl || seenDocs.has(documentUrl)) continue;
      seenDocs.add(documentUrl);

      items.push({
        number: entry.number,
        published_date: entry.published_date,
        title: entry.title,
        title_normalized: entry.title_normalized,
        source_url: documentUrl,
        source_page_url: entry.postUrl,
        source_origin: SOURCE_ORIGIN,
      });
    }
  }

  return {
    url: siteUrl,
    items,
    meta: {
      custom_official_scraper: true,
      source_origin: SOURCE_ORIGIN,
    },
  };
}

module.exports = { scrapeShkoderVendime };

"use strict";

const cheerio = require("cheerio");
const pdfParse = require("pdf-parse");
const {
  cleanText,
  fetchBufferWithLimit,
  fetchText,
  getHost,
  isSupportedVendimeYear,
  makeAbsolute,
  normalizeTitle,
  numberFromText,
  parseAlbanianNumericDate,
} = require("./officialVendimeUtils");

const DEFAULT_LISTING_URL =
  "https://bashkiapogradec.gov.al/publikime-kategori/vendime-te-keshillit-2/";
const SOURCE_ORIGIN = "bashkiapogradec.gov.al";
const MAX_DETAIL_PAGES = 60;
const PDF_MAX_BYTES = (() => {
  const raw = Number.parseInt(String(process.env.MANUAL_UPLOAD_MAX_BYTES || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20 * 1024 * 1024;
})();

function extractDateFromUrlOrFile(value) {
  const raw = cleanText(value);
  const match = raw.match(/\b(\d{1,2})[-.](\d{1,2})[-.](20\d{2})\b/);
  if (!match) return parseAlbanianNumericDate(raw);
  return parseAlbanianNumericDate(`${match[1]}.${match[2]}.${match[3]}`);
}

function numberFromFilename(pdfUrl) {
  let fileName = "";
  try {
    fileName = decodeURIComponent(new URL(pdfUrl).pathname.split("/").pop() || "");
  } catch {
    fileName = String(pdfUrl || "");
  }
  const match =
    fileName.match(/(?:vkb|vkbr|vendimi?|vend|ven)[-_ ]?(?:n[re]\.?[-_ ]?)?(\d{1,5})/i) ||
    fileName.match(/\bnr\.?[-_ ]?(\d{1,5})\b/i);
  return match ? match[1] : null;
}

async function extractPdfFacts(buffer) {
  try {
    const parsed = await pdfParse(buffer);
    const text = String(parsed?.text || "");
    const number =
      text.match(/(?:VKB|Vendim|Vend)\s+nr\.?\s*(\d{1,5})/i)?.[1] ||
      text.match(/\bnr\.?\s*(\d{1,5})\b/i)?.[1] ||
      null;
    const firstUsefulLine =
      text
        .split(/\r?\n/)
        .map((line) => cleanText(line))
        .find((line) => line.length > 8 && /vendim|vkb|keshill/i.test(line)) || null;
    return { number, title: firstUsefulLine };
  } catch (err) {
    return { number: null, title: null, error: err?.message || "pdf_parse_failed" };
  }
}

function extractDetailLinks(html, listingUrl) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const details = [];

  $('a[href*="/publikime/vendime-te-keshillit-2/"]').each((_, anchor) => {
    const href = $(anchor).attr("href");
    if (!href || href.includes("/publikime-kategori/")) return;
    const detailUrl = makeAbsolute(listingUrl, href);
    if (!detailUrl || getHost(detailUrl) !== SOURCE_ORIGIN || seen.has(detailUrl)) return;
    const date = extractDateFromUrlOrFile(detailUrl);
    if (!date || !isSupportedVendimeYear(date)) return;
    seen.add(detailUrl);
    details.push({ detailUrl, dateFromUrl: date });
  });

  return details.sort((a, b) => String(b.dateFromUrl).localeCompare(String(a.dateFromUrl)));
}

function extractPdfUrlsAndDate(html, detailUrl, fallbackDate) {
  const $ = cheerio.load(html);
  const h1Date = parseAlbanianNumericDate(cleanText($("h1").first().text()));
  const pdfUrls = [];
  const seen = new Set();

  $('a[href$=".pdf"], a[href*=".pdf?"]').each((_, anchor) => {
    const href = $(anchor).attr("href");
    const pdfUrl = makeAbsolute(detailUrl, href);
    if (!pdfUrl || getHost(pdfUrl) !== SOURCE_ORIGIN || seen.has(pdfUrl)) return;
    seen.add(pdfUrl);
    pdfUrls.push(pdfUrl);
  });

  let fileDate = null;
  for (const pdfUrl of pdfUrls) {
    fileDate = extractDateFromUrlOrFile(pdfUrl);
    if (fileDate && isSupportedVendimeYear(fileDate)) break;
  }

  const publishedDate =
    (h1Date && isSupportedVendimeYear(h1Date) ? h1Date : null) ||
    (fileDate && isSupportedVendimeYear(fileDate) ? fileDate : null) ||
    fallbackDate ||
    null;

  return { pdfUrls, publishedDate };
}

async function processPdf({ pdfUrl, publishedDate, detailUrl }) {
  const downloaded = await fetchBufferWithLimit(pdfUrl, {
    maxBytes: PDF_MAX_BYTES,
    headers: { Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8" },
  });
  if (!downloaded.ok || !downloaded.buffer) {
    console.warn(
      `[pogradecVendime] skip pdf download url=${pdfUrl} status=${downloaded.status} reason=${downloaded.reason || "-"}`
    );
    return null;
  }

  const fileNumber = numberFromFilename(pdfUrl);
  const facts = await extractPdfFacts(downloaded.buffer);
  const number = fileNumber || facts.number;
  if (!number) {
    console.warn(`[pogradecVendime] skip pdf without decision number url=${pdfUrl}`);
    return null;
  }

  const title = facts.title || `VKB nr ${number} date ${publishedDate}`;
  return {
    number,
    published_date: publishedDate,
    title,
    title_normalized: normalizeTitle(title),
    source_url: pdfUrl,
    source_page_url: detailUrl,
    source_origin: SOURCE_ORIGIN,
  };
}

async function scrapePogradecVendime({ url, year, limit = 50 }) {
  const siteUrl = url || DEFAULT_LISTING_URL;
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const wantedYear = Number.isInteger(Number(year)) ? Number(year) : null;
  const listing = await fetchText(siteUrl);
  if (!listing.ok) {
    throw new Error(`Pogradec listing fetch failed: HTTP ${listing.status}`);
  }

  const details = extractDetailLinks(listing.text, listing.url || siteUrl)
    .filter((detail) => !wantedYear || Number(String(detail.dateFromUrl).slice(0, 4)) === wantedYear)
    .slice(0, MAX_DETAIL_PAGES);
  if (details.length === 0) {
    throw new Error("Pogradec official scraper found no detail links.");
  }

  const items = [];
  const seenPdf = new Set();
  for (const detail of details) {
    if (items.length >= lim) break;
    const detailPage = await fetchText(detail.detailUrl);
    if (!detailPage.ok) {
      console.warn(`[pogradecVendime] skip detail url=${detail.detailUrl} status=${detailPage.status}`);
      continue;
    }

    const { pdfUrls, publishedDate } = extractPdfUrlsAndDate(
      detailPage.text,
      detailPage.url || detail.detailUrl,
      detail.dateFromUrl
    );
    if (!publishedDate || (wantedYear && Number(String(publishedDate).slice(0, 4)) !== wantedYear)) {
      continue;
    }

    for (const pdfUrl of pdfUrls) {
      if (items.length >= lim) break;
      if (seenPdf.has(pdfUrl)) continue;
      seenPdf.add(pdfUrl);

      const item = await processPdf({
        pdfUrl,
        publishedDate,
        detailUrl: detailPage.url || detail.detailUrl,
      });
      if (item) items.push(item);
    }
  }

  if (items.length === 0) {
    throw new Error("Pogradec official scraper found no numbered decision PDFs.");
  }

  return {
    url: listing.url || siteUrl,
    items,
    meta: {
      custom_official_scraper: true,
      source_origin: SOURCE_ORIGIN,
    },
  };
}

module.exports = { scrapePogradecVendime };

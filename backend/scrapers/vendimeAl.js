"use strict";

const cheerio = require("cheerio");

const SCRAPE_REQUEST_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(String(process.env.SCRAPE_REQUEST_TIMEOUT_MS || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20000;
})();

const MAX_LISTING_PAGES = 8;
const MAX_POST_CANDIDATES = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeTitle(s) {
  return String(s || "")
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

function getHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function getPath(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

function isVendimeHost(url) {
  const host = getHost(url);
  return host === "vendime.al" || host === "www.vendime.al";
}

function isPdfUrl(url) {
  return /\.pdf(\?|#|$)/i.test(String(url || ""));
}

function isJunkPdf(url) {
  const lower = String(url || "").toLowerCase();
  return (
    lower.includes("/harta_61_bashki.pdf") ||
    lower.includes("/harta-shtator-2018")
  );
}

function parseDateFromText(text) {
  const s = String(text || "");

  let m = s.match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/);
  if (m) {
    const dd = String(m[1]).padStart(2, "0");
    const mm = String(m[2]).padStart(2, "0");
    const yyyy = m[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  m = s.match(/(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
  if (m) {
    const yyyy = m[1];
    const mm = String(m[2]).padStart(2, "0");
    const dd = String(m[3]).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

function extractNumberFromTitle(title) {
  const m = String(title || "").match(/\bnr\.?\s*([0-9]{1,5})\b/i);
  return m ? m[1] : null;
}

function extractYearLinks($, pageUrl) {
  const out = [];
  const seen = new Set();

  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    const abs = makeAbsolute(pageUrl, href);
    if (!abs || !isVendimeHost(abs)) return;

    const text = cleanText($(a).text());
    const hay = `${text} ${abs}`.toLowerCase();
    if (!hay.includes("viti") && !/20\d{2}/.test(hay)) return;
    if (!/\/category\//i.test(abs)) return;

    if (seen.has(abs)) return;
    seen.add(abs);

    out.push({
      url: abs,
      text,
    });
  });

  return out;
}

function pickYearLinks(yearLinks, year) {
  if (!year || yearLinks.length === 0) return [];
  const yearRe = new RegExp(`(^|[^0-9])${year}([^0-9]|$)`);
  return yearLinks.filter((entry) => yearRe.test(`${entry.text} ${entry.url}`));
}

function extractDirectPdfItems($, pageUrl) {
  const out = [];
  const seen = new Set();

  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    const abs = makeAbsolute(pageUrl, href);
    if (!abs || !isPdfUrl(abs) || isJunkPdf(abs)) return;
    if (!isVendimeHost(abs)) return;

    const rawText = cleanText($(a).text());
    const filename = abs.split("/").pop() || abs;
    const title = rawText || decodeURIComponent(filename).replace(/\.pdf(\?.*)?$/i, "");
    if (!title) return;

    if (seen.has(abs)) return;
    seen.add(abs);

    out.push({
      title,
      title_normalized: normalizeTitle(title),
      source_url: abs,
      source_page_url: pageUrl,
      source_origin: "vendime.al",
      published_date: parseDateFromText(`${title} ${abs}`),
      number: extractNumberFromTitle(title),
    });
  });

  return out;
}

function extractPostLinks($, listingUrl) {
  const out = [];
  const seen = new Set();

  const selectors = [
    "article h1 a[href]",
    "article h2 a[href]",
    "article h3 a[href]",
    ".entry-title a[href]",
    ".post-title a[href]",
    "a[rel='bookmark'][href]",
  ];

  for (const selector of selectors) {
    $(selector).each((_, a) => {
      const href = $(a).attr("href");
      const abs = makeAbsolute(listingUrl, href);
      if (!abs || !isVendimeHost(abs)) return;
      if (isPdfUrl(abs)) return;

      const lowerPath = getPath(abs);
      if (
        lowerPath.includes("/category/") ||
        lowerPath.includes("/tag/") ||
        lowerPath.includes("/feed/")
      ) {
        return;
      }

      if (seen.has(abs)) return;
      seen.add(abs);

      out.push({
        url: abs,
        title: cleanText($(a).text()) || null,
      });
    });
  }

  return out;
}

function findNextPageUrl($, listingUrl) {
  const candidates = [
    $("link[rel='next']").attr("href"),
    $("a.next.page-numbers").attr("href"),
    $("a.page-numbers.next").attr("href"),
    $("a.next").attr("href"),
    $("a[rel='next']").attr("href"),
  ].filter(Boolean);

  for (const href of candidates) {
    const abs = makeAbsolute(listingUrl, href);
    if (!abs || !isVendimeHost(abs)) continue;
    return abs;
  }

  return null;
}

function pickBestPdfFromPost($, postUrl) {
  const candidates = [];

  $("a[href], iframe[src], embed[src], object[data]").each((_, el) => {
    const href =
      $(el).attr("href") ||
      $(el).attr("src") ||
      $(el).attr("data");
    const abs = makeAbsolute(postUrl, href);
    if (!abs || !isPdfUrl(abs) || isJunkPdf(abs)) return;
    if (!isVendimeHost(abs)) return;

    const text = cleanText($(el).text());
    const score = (() => {
      const hay = `${text} ${abs}`.toLowerCase();
      let s = 0;
      if (hay.includes("vendim")) s += 20;
      if (hay.includes("nr")) s += 10;
      if (hay.includes("/wp-content/uploads/")) s += 15;
      return s;
    })();

    candidates.push({ url: abs, text, score });
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

function extractPublishedDateFromPost($, fallbackText) {
  const timeDatetime = cleanText($("time[datetime]").first().attr("datetime"));
  if (timeDatetime) {
    const normalized = timeDatetime.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  }

  const timeText = cleanText($("time").first().text());
  const dateFromTime = parseDateFromText(timeText);
  if (dateFromTime) return dateFromTime;

  return parseDateFromText(fallbackText);
}

function matchesYearHeuristic(item, year) {
  if (!year) return true;

  if (item.published_date && item.published_date.startsWith(`${year}-`)) return true;
  const yearRe = new RegExp(`(^|[^0-9])${year}([^0-9]|$)`);
  return yearRe.test(`${item.title} ${item.source_page_url} ${item.source_url}`);
}

async function fetchHtml(url, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.requestTimeoutMs))
    ? Number(options.requestTimeoutMs)
    : SCRAPE_REQUEST_TIMEOUT_MS;

  const retryDelayMs = 500;

  async function fetchOnce(targetUrl, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(targetUrl, {
        headers,
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === "AbortError") {
        const timeoutErr = new Error(`Request timed out after ${timeoutMs}ms: ${targetUrl}`);
        timeoutErr.code = "TIMEOUT";
        timeoutErr.last_error_type = "TIMEOUT";
        timeoutErr.final_url = targetUrl;
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  const headersA = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "sq-AL,sq;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };

  const headersB = {
    ...headersA,
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  };

  let res;
  try {
    res = await fetchOnce(url, headersA);
  } catch (err) {
    if (err?.code !== "UND_ERR_CONNECT_TIMEOUT" && err?.cause?.code !== "UND_ERR_CONNECT_TIMEOUT") {
      throw err;
    }
    await sleep(retryDelayMs);
    res = await fetchOnce(url, headersA);
  }

  if (res.status === 406 || res.status === 403) {
    res = await fetchOnce(url, headersB);
  }

  const finalUrl = String(res.url || url);
  if (!res.ok) {
    const err = new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    err.code = `HTTP_${res.status}`;
    err.last_error_type = `HTTP_${res.status}`;
    err.final_url = finalUrl;
    throw err;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return {
    html: buf.toString("utf8"),
    final_url: finalUrl,
  };
}

async function scrapePostItem(post, options) {
  const fetched = await fetchHtml(post.url, options);
  const $ = cheerio.load(fetched.html);

  const bestPdf = pickBestPdfFromPost($, fetched.final_url);
  if (!bestPdf) return null;

  const pageTitle =
    cleanText($("h1.entry-title, h1.post-title, article h1").first().text()) ||
    cleanText($("title").text()) ||
    post.title ||
    bestPdf.text ||
    bestPdf.url;

  const title = pageTitle.replace(/\s*\|\s*vendime\.al\s*$/i, "").trim() || pageTitle;
  const published_date = extractPublishedDateFromPost($, `${title} ${fetched.final_url}`);

  return {
    title,
    title_normalized: normalizeTitle(title),
    source_url: bestPdf.url,
    source_page_url: fetched.final_url,
    source_origin: "vendime.al",
    published_date: published_date || null,
    number: extractNumberFromTitle(title),
  };
}

async function scrapeVendimeAl({
  url,
  year = null,
  limit = 50,
  requestTimeoutMs = SCRAPE_REQUEST_TIMEOUT_MS,
}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const options = { requestTimeoutMs };

  const landing = await fetchHtml(url, options);
  const landingUrl = landing.final_url || url;
  const $landing = cheerio.load(landing.html);

  const yearLinks = extractYearLinks($landing, landingUrl);
  const exactYearLinks = pickYearLinks(yearLinks, year);
  const usedYearLinks = exactYearLinks.length > 0;

  const listingQueue = [];
  const listingSeen = new Set();

  const pushListing = (candidate) => {
    const abs = makeAbsolute(landingUrl, candidate);
    if (!abs || !isVendimeHost(abs)) return;
    if (listingSeen.has(abs)) return;
    listingSeen.add(abs);
    listingQueue.push(abs);
  };

  if (usedYearLinks) {
    for (const link of exactYearLinks) pushListing(link.url);
  } else {
    pushListing(landingUrl);
    // Keep fallback breadth small when no exact year-category was found.
    for (const link of yearLinks.slice(0, 3)) pushListing(link.url);
  }

  const postCandidates = [];
  const postSeen = new Set();
  const rawItems = [];
  const itemSeen = new Set();

  for (let i = 0; i < listingQueue.length && i < MAX_LISTING_PAGES; i += 1) {
    const listingUrl = listingQueue[i];
    const listingFetched = await fetchHtml(listingUrl, options);
    const $ = cheerio.load(listingFetched.html);

    const directPdfItems = extractDirectPdfItems($, listingFetched.final_url || listingUrl);
    for (const item of directPdfItems) {
      if (itemSeen.has(item.source_url)) continue;
      itemSeen.add(item.source_url);
      rawItems.push(item);
    }

    const links = extractPostLinks($, listingFetched.final_url || listingUrl);
    for (const link of links) {
      if (postCandidates.length >= MAX_POST_CANDIDATES) break;
      if (postSeen.has(link.url)) continue;
      postSeen.add(link.url);
      postCandidates.push(link);
    }

    const nextPage = findNextPageUrl($, listingFetched.final_url || listingUrl);
    if (nextPage) pushListing(nextPage);
  }

  for (const post of postCandidates) {
    if (rawItems.length >= lim) break;
    let item = null;
    try {
      item = await scrapePostItem(post, options);
    } catch {
      continue;
    }
    if (!item) continue;
    if (itemSeen.has(item.source_url)) continue;
    itemSeen.add(item.source_url);
    rawItems.push(item);
  }

  const filteredItems =
    usedYearLinks || !year
      ? rawItems
      : rawItems.filter((item) => matchesYearHeuristic(item, year));

  return {
    url: landingUrl,
    method: "vendime_al",
    used_year_filter: Boolean(usedYearLinks),
    items: filteredItems.slice(0, lim),
  };
}

module.exports = { scrapeVendimeAl };


"use strict";

const cheerio = require("cheerio");

const SCRAPE_REQUEST_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(String(process.env.SCRAPE_REQUEST_TIMEOUT_MS || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20000;
})();
const VENDIME_AL_MAX_RUNTIME_MS = (() => {
  const raw = Number.parseInt(String(process.env.VENDIME_AL_MAX_RUNTIME_MS || ""), 10);
  return Number.isFinite(raw) && raw > 15000 ? raw : 75000;
})();

const MAX_LISTING_PAGES = 8;
const MAX_POST_CANDIDATES = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getErrorCode(err) {
  return String(
    err?.code ||
      err?.cause?.code ||
      err?.last_error_type ||
      ""
  ).toUpperCase();
}

function normalizeTitle(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function toSlug(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

function titleLooksBlocked(titleNorm) {
  const t = String(titleNorm || "").trim();
  return /^harta\b/.test(t) || /^bashkia\b/.test(t);
}

function isGenericMapOrMunicipalityResource(titleNorm, url) {
  const lowerUrl = String(url || "").toLowerCase();
  const hay = `${String(titleNorm || "")} ${lowerUrl}`;
  return (
    hay.includes("harta") ||
    hay.includes("61 bashki") ||
    hay.includes("61-bashki") ||
    hay.includes("61_bashki") ||
    /\/bashkia-[a-z0-9-]+\.pdf(\?|#|$)/i.test(lowerUrl) ||
    /\/harta[^/]*\.pdf(\?|#|$)/i.test(lowerUrl)
  );
}

function hasVendimInNormalizedTitle(titleNorm) {
  return /\bvendim/.test(String(titleNorm || ""));
}

function hasVendimePostPattern(url) {
  const path = getPath(url);
  return (
    /\/vendim[^/]*keshillit-bashkiak-/i.test(path) ||
    /\/vendime?-te-keshillit-bashkiak-/i.test(path)
  );
}

function extractMunicipalitySlugFromVendimeUrl(url) {
  const path = getPath(url);
  if (!path) return null;

  let m = path.match(/\/vendim[^/]*keshillit-bashkiak-([a-z0-9-]+?)(?:-(?:nr|viti|\d)|\/|$)/i);
  if (m) return toSlug(m[1]);

  m = path.match(/\/vendime?-te-keshillit-bashkiak-([a-z0-9-]+)(?:\/|$)/i);
  if (m) return toSlug(m[1]);

  return null;
}

function expandMunicipalityAliases(municipalityKey) {
  const normalized = toSlug(municipalityKey);
  const set = new Set();
  if (!normalized) return set;
  set.add(normalized);
  if (normalized === "tirane") set.add("tirana");
  return set;
}

function municipalityHintsMatchExpected(hints, expectedMunicipalityKey) {
  const aliases = expandMunicipalityAliases(expectedMunicipalityKey);
  if (aliases.size === 0) return true;
  if (!Array.isArray(hints) || hints.length === 0) return true;

  for (const rawHint of hints) {
    const hint = toSlug(rawHint);
    if (!hint) continue;
    if (aliases.has(hint)) return true;
    for (const alias of aliases) {
      if (hint.startsWith(`${alias}-`) || alias.startsWith(`${hint}-`)) return true;
    }
  }
  return false;
}

function extractMunicipalityHintsFromPostPage($, postUrl) {
  const hints = new Set();
  const addHint = (value) => {
    const s = toSlug(value);
    if (s) hints.add(s);
  };

  addHint(extractMunicipalitySlugFromVendimeUrl(postUrl));

  const categorySelectors = [
    ".cat-links a[href]",
    ".tags-links a[href]",
    "a[rel='category tag'][href]",
    "a[rel='tag'][href]",
    "a[href*='/category/'][href]",
    "a[href*='/tag/'][href]",
  ];

  for (const selector of categorySelectors) {
    $(selector).each((_, a) => {
      const href = $(a).attr("href");
      const abs = makeAbsolute(postUrl, href);
      if (!abs || !isVendimeHost(abs)) return;
      addHint(extractMunicipalitySlugFromVendimeUrl(abs));
      const txt = cleanText($(a).text());
      if (/^bashkia\b/i.test(txt)) {
        addHint(txt.replace(/^bashkia\b/i, ""));
      }
    });
  }

  return Array.from(hints);
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

  const containerSelectors = [
    "main",
    "#main",
    "#content",
    ".site-content",
    ".content-area",
    ".site-main",
    "body",
  ];
  const linkSelectors = [
    "article h1 a[href]",
    "article h2 a[href]",
    "article h3 a[href]",
    "article a[rel='bookmark'][href]",
    ".post h1 a[href]",
    ".post h2 a[href]",
    ".post h3 a[href]",
    ".entry-title a[href]",
    ".post-title a[href]",
    "a[rel='bookmark'][href]",
  ];

  const roots = [];
  for (const selector of containerSelectors) {
    const node = $(selector).first();
    if (node.length) roots.push(node);
  }
  if (roots.length === 0) roots.push($.root());

  for (const root of roots) {
    for (const selector of linkSelectors) {
      root.find(selector).each((_, a) => {
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
  const maxAttempts = Number.isFinite(Number(options.maxAttempts))
    ? Math.max(1, Math.min(5, Number(options.maxAttempts)))
    : 3;
  const retryDelayMs = Number.isFinite(Number(options.retryDelayMs))
    ? Math.max(100, Number(options.retryDelayMs))
    : 600;

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

  const retryableStatus = new Set([408, 425, 429, 500, 502, 503, 504]);
  const retryableCodes = new Set([
    "TIMEOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
  ]);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      let res = await fetchOnce(url, headersA);

      if (res.status === 406 || res.status === 403) {
        // Some hosts reject one UA but accept another; do not fail immediately.
        res = await fetchOnce(url, headersB);
      }

      const finalUrl = String(res.url || url);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        return {
          html: buf.toString("utf8"),
          final_url: finalUrl,
        };
      }

      const err = new Error(`Fetch failed: ${res.status} ${res.statusText}`);
      err.code = `HTTP_${res.status}`;
      err.last_error_type = `HTTP_${res.status}`;
      err.final_url = finalUrl;

      if (retryableStatus.has(res.status) && attempt < maxAttempts) {
        const delay = retryDelayMs * attempt;
        console.warn(
          `[vendimeAl] retry fetch attempt=${attempt}/${maxAttempts} status=${res.status} url=${url} delay_ms=${delay}`
        );
        await sleep(delay);
        continue;
      }
      throw err;
    } catch (err) {
      const code = getErrorCode(err);
      if (retryableCodes.has(code) && attempt < maxAttempts) {
        const delay = retryDelayMs * attempt;
        console.warn(
          `[vendimeAl] retry fetch attempt=${attempt}/${maxAttempts} code=${code || "UNKNOWN"} url=${url} delay_ms=${delay}`
        );
        await sleep(delay);
        continue;
      }
      if (code === "TIMEOUT") {
        console.warn(`[vendimeAl] timeout url=${url} timeout_ms=${timeoutMs} attempt=${attempt}`);
      }
      throw err;
    }
  }

  const exhaustedErr = new Error(`Fetch failed after ${maxAttempts} attempts: ${url}`);
  exhaustedErr.code = "FETCH_RETRIES_EXHAUSTED";
  exhaustedErr.last_error_type = "FETCH_RETRIES_EXHAUSTED";
  exhaustedErr.final_url = url;
  throw exhaustedErr;
}

function withPageStart(listingUrl, pageStart) {
  const start = Number.isFinite(Number(pageStart)) ? Number(pageStart) : 1;
  if (start <= 1) return listingUrl;
  try {
    const parsed = new URL(listingUrl);
    const basePath = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
    if (/\/page\/\d+\/?$/i.test(basePath)) return listingUrl;
    parsed.pathname = `${basePath}page/${start}/`;
    return parsed.toString();
  } catch {
    return listingUrl;
  }
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
  const municipalityHints = extractMunicipalityHintsFromPostPage($, fetched.final_url);
  const sourceUrlMunicipalityHint = extractMunicipalitySlugFromVendimeUrl(bestPdf.url);
  if (sourceUrlMunicipalityHint) municipalityHints.push(sourceUrlMunicipalityHint);

  return {
    title,
    title_normalized: normalizeTitle(title),
    source_url: bestPdf.url,
    source_page_url: fetched.final_url,
    source_origin: "vendime.al",
    published_date: published_date || null,
    number: extractNumberFromTitle(title),
    municipality_hints: Array.from(new Set(municipalityHints.filter(Boolean))),
  };
}

async function scrapeVendimeAl({
  url,
  year = null,
  limit = 50,
  expectedMunicipalityKey = null,
  pageStart = 1,
  requestTimeoutMs = SCRAPE_REQUEST_TIMEOUT_MS,
}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const listingOptions = { requestTimeoutMs, maxAttempts: 3, retryDelayMs: 600 };
  const postRequestTimeoutMs = Math.max(3000, Math.min(10000, Number(requestTimeoutMs) || 8000));
  const postOptionsBase = { requestTimeoutMs: postRequestTimeoutMs, maxAttempts: 2, retryDelayMs: 350 };
  const startPage = Number.isFinite(Number(pageStart)) ? Math.max(1, Number(pageStart)) : 1;
  const startedAtMs = Date.now();
  const maxRuntimeMs = VENDIME_AL_MAX_RUNTIME_MS;
  const outOfTime = () => Date.now() - startedAtMs >= maxRuntimeMs;
  const diagnostics = {
    skipped_not_vendim: 0,
    skipped_not_municipality: 0,
    skipped_generic_resource: 0,
  };

  const landing = await fetchHtml(url, listingOptions);
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
    for (const link of exactYearLinks) pushListing(withPageStart(link.url, startPage));
  } else {
    pushListing(withPageStart(landingUrl, startPage));
    // Keep fallback breadth small when no exact year-category was found.
    for (const link of yearLinks.slice(0, 3)) pushListing(withPageStart(link.url, startPage));
  }

  const postSeen = new Set();
  const rawItems = [];
  const itemSeen = new Set();
  let postCandidatesProcessed = 0;

  for (let i = 0; i < listingQueue.length && i < MAX_LISTING_PAGES; i += 1) {
    if (outOfTime()) {
      console.warn(
        `[vendimeAl] stopping due to runtime budget max_runtime_ms=${maxRuntimeMs} collected=${rawItems.length}/${lim}`
      );
      break;
    }
    if (rawItems.length >= lim) break;
    if (postCandidatesProcessed >= MAX_POST_CANDIDATES) break;

    const listingUrl = listingQueue[i];
    const pageNumber = startPage + i;
    console.log(
      `[vendimeAl] listing page=${pageNumber} url=${listingUrl} collected=${rawItems.length}/${lim}`
    );

    let listingFetched = null;
    try {
      listingFetched = await fetchHtml(listingUrl, listingOptions);
    } catch (err) {
      console.warn(
        `[vendimeAl] listing fetch failed page=${pageNumber} url=${listingUrl} code=${getErrorCode(err) || "UNKNOWN"} msg=${cleanText(err?.message || "")}`
      );
      continue;
    }

    const listingFinalUrl = listingFetched.final_url || listingUrl;
    const $ = cheerio.load(listingFetched.html);
    const links = extractPostLinks($, listingFinalUrl);
    console.log(
      `[vendimeAl] listing parsed page=${pageNumber} url=${listingFinalUrl} links=${links.length} collected=${rawItems.length}/${lim}`
    );

    for (const link of links) {
      if (outOfTime()) {
        console.warn(
          `[vendimeAl] stopping due to runtime budget max_runtime_ms=${maxRuntimeMs} collected=${rawItems.length}/${lim} page=${pageNumber}`
        );
        break;
      }
      if (rawItems.length >= lim) break;
      if (postCandidatesProcessed >= MAX_POST_CANDIDATES) break;
      if (postSeen.has(link.url)) continue;
      postSeen.add(link.url);
      postCandidatesProcessed += 1;

      const postIndex = postCandidatesProcessed;
      const candidateTitleNorm = normalizeTitle(link.title || "");
      const candidatePathHasPattern = hasVendimePostPattern(link.url);
      const candidateTitleHasVendim = hasVendimInNormalizedTitle(candidateTitleNorm);
      if (!candidatePathHasPattern && !candidateTitleHasVendim) {
        diagnostics.skipped_not_vendim += 1;
        continue;
      }
      if (titleLooksBlocked(candidateTitleNorm)) {
        diagnostics.skipped_not_vendim += 1;
        continue;
      }

      let item = null;
      try {
        const remaining = Math.max(2000, maxRuntimeMs - (Date.now() - startedAtMs) - 500);
        const postOptions = {
          ...postOptionsBase,
          requestTimeoutMs: Math.min(postOptionsBase.requestTimeoutMs, remaining),
        };
        item = await scrapePostItem(link, postOptions);
      } catch (err) {
        console.warn(
          `[vendimeAl] post fetch failed idx=${postIndex} url=${link.url} code=${getErrorCode(err) || "UNKNOWN"} msg=${cleanText(err?.message || "")}`
        );
        continue;
      }
      if (!item) continue;
      if (itemSeen.has(item.source_url)) continue;

      const titleNorm = item.title_normalized || normalizeTitle(item.title);
      const hasPattern = hasVendimePostPattern(item.source_page_url || link.url);
      const hasVendimTitle = hasVendimInNormalizedTitle(titleNorm);
      if (!hasPattern && !hasVendimTitle) {
        diagnostics.skipped_not_vendim += 1;
        continue;
      }

      if (
        titleLooksBlocked(titleNorm) ||
        isGenericMapOrMunicipalityResource(titleNorm, item.source_url) ||
        isJunkPdf(item.source_url)
      ) {
        diagnostics.skipped_generic_resource += 1;
        continue;
      }

      if (!municipalityHintsMatchExpected(item.municipality_hints, expectedMunicipalityKey)) {
        diagnostics.skipped_not_municipality += 1;
        continue;
      }

      itemSeen.add(item.source_url);
      rawItems.push(item);
      if (rawItems.length % 10 === 0 || rawItems.length >= lim) {
        console.log(
          `[vendimeAl] collected=${rawItems.length}/${lim} latest_post_url=${item.source_page_url || link.url}`
        );
      }
    }

    if (rawItems.length >= lim) {
      console.log(
        `[vendimeAl] early-stop reached limit collected=${rawItems.length}/${lim} page=${pageNumber}`
      );
      break;
    }
    if (postCandidatesProcessed >= MAX_POST_CANDIDATES) {
      console.warn(
        `[vendimeAl] stopped at MAX_POST_CANDIDATES=${MAX_POST_CANDIDATES} collected=${rawItems.length}/${lim}`
      );
      break;
    }

    const nextPage = findNextPageUrl($, listingFinalUrl);
    if (nextPage) pushListing(nextPage);
  }

  const filteredItems =
    usedYearLinks || !year
      ? rawItems
      : rawItems.filter((item) => matchesYearHeuristic(item, year));

  return {
    url: landingUrl,
    method: "vendime_al",
    used_year_filter: Boolean(usedYearLinks),
    page_start: startPage,
    items: filteredItems.slice(0, lim),
    meta: diagnostics,
  };
}

module.exports = { scrapeVendimeAl };

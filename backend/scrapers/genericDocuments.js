// backend/scrapers/genericDocuments.js
const cheerio = require("cheerio");

const HTTP_403_COOLDOWN_MINUTES = (() => {
  const raw = Number.parseInt(String(process.env.HTTP_403_COOLDOWN_MINUTES || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 10080;
})();
const SCRAPE_REQUEST_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(String(process.env.SCRAPE_REQUEST_TIMEOUT_MS || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20000;
})();
const MAX_CLOUDFLARE_REDIRECTS = (() => {
  const raw = Number.parseInt(String(process.env.MAX_CLOUDFLARE_REDIRECTS || ""), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2;
})();

function normalizeTitle(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanText(t) {
  return String(t || "").replace(/\s+/g, " ").trim();
}

function makeAbsolute(baseUrl, href) {
  if (!href) return null;

  const h = String(href).trim();
  if (!h) return null;

  // reject obvious junk
  if (h === "*" || h === "#" || h === "/#" || h.startsWith("#")) return null;
  if (/^(mailto:|tel:|javascript:|data:)/i.test(h)) return null;

  try {
    return new URL(h, baseUrl).toString();
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

function isCloudflareChallengeUrl(url) {
  return String(url || "").toLowerCase().includes("__cf_chl");
}

function makeBlockedError(finalUrl, message) {
  const err = new Error(message || `Cloudflare challenge detected at ${finalUrl}`);
  err.code = "HTTP_403";
  err.last_error_type = "HTTP_403";
  err.homepage_status = "BLOCKED";
  err.feasibility = "C";
  err.cooldown_minutes = HTTP_403_COOLDOWN_MINUTES;
  err.final_url = finalUrl;
  return err;
}

function isProbablySameSite(baseUrl, candidateUrl) {
  try {
    const a = new URL(baseUrl);
    const b = new URL(candidateUrl);
    return a.hostname.toLowerCase() === b.hostname.toLowerCase();
  } catch {
    return false;
  }
}

function hasAllowedOfficeOrPdfExt(url) {
  const u = String(url || "").toLowerCase();
  return /\.(pdf|doc|docx|xls|xlsx)(\?|#|$)/i.test(u);
}

function unwrapViewerFileUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/\/viewer\.php$/i.test(parsed.pathname)) return null;

    const fileParam = parsed.searchParams.get("file");
    if (!fileParam) return null;

    const embedded = makeAbsolute(url, fileParam);
    if (!embedded) return null;
    if (!hasAllowedOfficeOrPdfExt(embedded)) return null;
    return embedded;
  } catch {
    return null;
  }
}

function resolveDocumentCandidateUrl(baseUrl, href) {
  const abs = makeAbsolute(baseUrl, href);
  if (!abs) return null;
  return unwrapViewerFileUrl(abs) || abs;
}

// ✅ strict “Vendime-like document” detection
function looksLikeDoc(url) {
  const u = String(url || "").toLowerCase();

  // ignore junk/static assets
  if (/\.(png|jpg|jpeg|webp|gif|svg|ico)(\?|#|$)/i.test(u)) return false;
  if (/\.(css|js|map)(\?|#|$)/i.test(u)) return false;
  if (/\.(woff|woff2|ttf|otf|eot)(\?|#|$)/i.test(u)) return false;
  if (/\.(mp4|webm|mov|avi|mp3|wav)(\?|#|$)/i.test(u)) return false;

  // direct doc extensions (what we actually want)
  if (/\.(pdf|doc|docx|rtf|xls|xlsx|zip|rar)(\?|#|$)/i.test(u)) return true;

  // uploads can contain docs, but only accept if it has a doc extension
  if (/\/wp-content\/uploads\//i.test(u)) {
    return /\.(pdf|doc|docx|rtf|xls|xlsx|zip|rar)(\?|#|$)/i.test(u);
  }

  // download endpoints / query params (some sites do this)
  if (/[?&](download|file|attachment_id)=/i.test(u)) return true;
  if (/\/download\/?/i.test(u)) return true;

  return false;
}

function buildItem({ baseUrl, linkUrl, titleText }) {
  const abs = makeAbsolute(baseUrl, linkUrl);
  if (!abs) return null;

  const anchorTitle = cleanText(titleText);
  const fn = filenameFromUrl(abs);
  const fallbackTitle = titleFromFilename(fn);

  const title = (!anchorTitle || isGenericTitle(anchorTitle))
    ? (fallbackTitle || anchorTitle || abs)
    : anchorTitle;

  // try extracting date from filename / url
  const published_date =
    parseDateFromText(fn) ||
    parseDateFromText(abs);

  return {
    title,
    title_normalized: normalizeTitle(title),
    source_url: abs,
    published_date: published_date || null,
    number: null,
  };
}


function isGenericTitle(s) {
  const t = String(s || "").trim().toLowerCase();
  return [
    "shkarko",
    "download",
    "pdf",
    "shiko vendimin",
    "kliko këtu",
    "klikoni këtu",
    "lexo më shumë",
    "read more",
  ].includes(t);
}

function filenameFromUrl(u) {
  try {
    const url = new URL(u);
    const seg = url.pathname.split("/").pop() || "";
    return decodeURIComponent(seg).replace(/\+/g, " ");
  } catch {
    return "";
  }
}

function titleFromFilename(fn) {
  if (!fn) return "";
  return fn
    .replace(/\.pdf(\?.*)?$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDateFromText(text) {
  const s = String(text || "");

  // dd.mm.yyyy or dd-mm-yyyy or dd/mm/yyyy
  let m = s.match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/);
  if (m) {
    const dd = String(m[1]).padStart(2, "0");
    const mm = String(m[2]).padStart(2, "0");
    const yyyy = m[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  // yyyy-mm-dd etc.
  m = s.match(/(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
  if (m) {
    const yyyy = m[1];
    const mm = String(m[2]).padStart(2, "0");
    const dd = String(m[3]).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

// Extract URLs from onclick="window.open('...')" etc.
function extractUrlsFromOnclick(onclick) {
  const s = String(onclick || "");
  const urls = [];

  // grab anything URL-ish, we'll filter via looksLikeDoc afterwards
  const re = /(https?:\/\/[^\s"'<>]+|\/wp-content\/uploads\/[^\s"'<>]+)/gi;
  const m = s.match(re) || [];
  for (const x of m) urls.push(x);
  return urls;
}

// ✅ Extract doc links from many attribute places (not just <a href>)
function extractDocLinksFromHtml({ baseUrl, html, pageTitleFallback = "" }) {
  const $ = cheerio.load(html);
  const out = [];

  // 1) normal anchors
  $("a").each((_, el) => {
    const href = $(el).attr("href");
    const abs = resolveDocumentCandidateUrl(baseUrl, href);
    if (!abs) return;
    if (!looksLikeDoc(abs)) return;

    const item = buildItem({
      baseUrl,
      linkUrl: abs,
      titleText: cleanText($(el).text()) || pageTitleFallback,
    });
    if (item) out.push(item);
  });

  // 2) iframe/embed/object/source
  $("iframe, embed, object, source").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data");
    const abs = resolveDocumentCandidateUrl(baseUrl, src);
    if (!abs) return;
    if (!looksLikeDoc(abs)) return;

    const item = buildItem({ baseUrl, linkUrl: abs, titleText: pageTitleFallback });
    if (item) out.push(item);
  });

  // 3) data-* attributes
  $("[data-href],[data-url],[data-file],[data-src]").each((_, el) => {
    const cand =
      $(el).attr("data-href") ||
      $(el).attr("data-url") ||
      $(el).attr("data-file") ||
      $(el).attr("data-src");

    const abs = resolveDocumentCandidateUrl(baseUrl, cand);
    if (!abs) return;
    if (!looksLikeDoc(abs)) return;

    const txt = cleanText($(el).text()) || pageTitleFallback;
    const item = buildItem({ baseUrl, linkUrl: abs, titleText: txt });
    if (item) out.push(item);
  });

  // 4) onclick handlers
  $("[onclick]").each((_, el) => {
    const onclick = $(el).attr("onclick");
    const urls = extractUrlsFromOnclick(onclick);

    for (const u of urls) {
      const abs = resolveDocumentCandidateUrl(baseUrl, u);
      if (!abs) continue;
      if (!looksLikeDoc(abs)) continue;

      const txt = cleanText($(el).text()) || pageTitleFallback;
      const item = buildItem({ baseUrl, linkUrl: abs, titleText: txt });
      if (item) out.push(item);
    }
  });

  // 5) last resort: scan raw HTML for doc-ish URLs
  const re = /(https?:\/\/[^\s"'<>]+|\/wp-content\/uploads\/[^\s"'<>]+)/gi;
  const raw = html.match(re) || [];
  for (const x of raw) {
    const abs = resolveDocumentCandidateUrl(baseUrl, x);
    if (!abs) continue;
    if (!looksLikeDoc(abs)) continue;

    const item = buildItem({ baseUrl, linkUrl: abs, titleText: pageTitleFallback });
    if (item) out.push(item);
  }

  return out;
}

// Candidate post link discovery (kept, but safer)
function extractCandidatePostLinks({ baseUrl, html, maxPosts = 15 }) {
  const $ = cheerio.load(html);
  const links = new Set();

  const selectors = [
    ".entry-title a",
    ".post-title a",
    "h1 a",
    "h2 a",
    "h3 a",
    ".elementor-post__title a",
    "a.elementor-post__read-more",
    "a.elementor-post__thumbnail__link",
    ".elementor-widget-posts a",
    "article a",
  ];

  function addLink(href) {
    const abs = makeAbsolute(baseUrl, href);
    if (!abs) return;

    const low = abs.toLowerCase();
    if (!isProbablySameSite(baseUrl, abs)) return;
    if (/(\/category\/|\/tag\/|\?s=)/i.test(low)) return;
    if (low.includes("/wp-content/")) return;
    if (/\.(png|jpg|jpeg|webp|gif|svg|css|js|map)(\?|#|$)/i.test(low)) return;

    links.add(abs);
  }

  for (const sel of selectors) {
    $(sel).each((_, a) => addLink($(a).attr("href")));
    if (links.size >= maxPosts) break;
  }

  return Array.from(links).slice(0, maxPosts);
}

function extractVendimePostLinksFromListing({ baseUrl, html, maxPosts = 15 }) {
  const $ = cheerio.load(html);
  const links = new Set();
  const vendimeLikePath = /(^|[-_/])vendime(t|ve)?([-_/]|$)/i;

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const abs = makeAbsolute(baseUrl, href);
    if (!abs) return;
    if (!isProbablySameSite(baseUrl, abs)) return;

    let path = "";
    try {
      path = new URL(abs).pathname.toLowerCase();
    } catch {
      return;
    }
    if (/(\/category\/|\/tag\/)/i.test(path)) return;

    const low = abs.toLowerCase();
    if (!vendimeLikePath.test(path)) return;
    if (/\.(png|jpg|jpeg|webp|gif|svg|css|js|map)(\?|#|$)/i.test(low)) return;

    links.add(abs);
  });

  return Array.from(links).slice(0, maxPosts);
}

function looksLikePreferredPostDoc(url) {
  const u = String(url || "").toLowerCase();
  return (
    /\.(pdf|doc|docx|zip)(\?|#|$)/i.test(u) ||
    /\/wp-content\/uploads\//i.test(u)
  );
}

function pickBestDocumentFromPost({ postUrl, html }) {
  const allDocs = extractDocLinksFromHtml({ baseUrl: postUrl, html, pageTitleFallback: "" });
  if (!allDocs.length) return null;

  const preferred = allDocs.find((it) => looksLikePreferredPostDoc(it.source_url));
  return preferred || allDocs[0];
}

function findNextPageUrl({ baseUrl, html }) {
  const $ = cheerio.load(html);

  const relNext = $('link[rel="next"]').attr("href");
  if (relNext) return makeAbsolute(baseUrl, relNext);

  const aNext =
    $("a.next.page-numbers").attr("href") ||
    $("a.next").attr("href") ||
    $('a[rel="next"]').attr("href");

  if (aNext) return makeAbsolute(baseUrl, aNext);
  return null;
}

async function fetchHtml(url, options = {}) {
  const targetUrl = url;
  const timeoutMs = Number.isFinite(Number(options.requestTimeoutMs))
    ? Number(options.requestTimeoutMs)
    : SCRAPE_REQUEST_TIMEOUT_MS;
  const maxCloudflareRedirects = Number.isFinite(Number(options.maxCloudflareRedirects))
    ? Number(options.maxCloudflareRedirects)
    : MAX_CLOUDFLARE_REDIRECTS;
  const state = options.state || { cloudflareRedirectHits: 0 };
  const retryDelayMs = 500;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isConnectTimeout = (err) =>
    err?.code === "UND_ERR_CONNECT_TIMEOUT" ||
    err?.cause?.code === "UND_ERR_CONNECT_TIMEOUT";

  async function fetchWithTimeoutAndConnectRetry(targetUrl, options) {
    try {
      return await fetchOnce(targetUrl, options);
    } catch (err) {
      if (!isConnectTimeout(err)) throw err;
      await sleep(retryDelayMs);
      return fetchOnce(targetUrl, options);
    }
  }

  async function fetchOnce(targetUrl, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(targetUrl, {
        ...options,
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

  let res = await fetchWithTimeoutAndConnectRetry(targetUrl, {
    headers: headersA,
    redirect: "follow",
  });

  // Some sites (and vendime.al) may return 406/403 for botty headers — retry with a slightly different UA.
  if (res.status === 406 || res.status === 403) {
    const headersB = {
      ...headersA,
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    };
    if (res.status === 406) {
      res = await fetchWithTimeoutAndConnectRetry(targetUrl, {
        headers: headersB,
        redirect: "follow",
      });
    }
  }

  const finalUrl = String(res.url || url);
  if (res.status === 403) {
    throw makeBlockedError(finalUrl, `Cloudflare or bot block detected (HTTP 403) at ${finalUrl}`);
  }

  if (isCloudflareChallengeUrl(finalUrl)) {
    state.cloudflareRedirectHits = Number(state.cloudflareRedirectHits || 0) + 1;
    if (state.cloudflareRedirectHits > maxCloudflareRedirects) {
      throw makeBlockedError(
        finalUrl,
        `Cloudflare challenge loop detected (${state.cloudflareRedirectHits} > ${maxCloudflareRedirects}) at ${finalUrl}`
      );
    }
    throw makeBlockedError(finalUrl, `Cloudflare challenge detected at ${finalUrl}`);
  }

  if (!res.ok) {
    const err = new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    err.code = `HTTP_${res.status}`;
    err.final_url = finalUrl;
    throw err;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return {
    html: buf.toString("utf8"),
    final_url: finalUrl,
    status: res.status,
  };
}


async function scrapeGenericDocuments({
  url,
  limit = 50,
  requestTimeoutMs = SCRAPE_REQUEST_TIMEOUT_MS,
  maxCloudflareRedirects = MAX_CLOUDFLARE_REDIRECTS,
}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));

  const seenDocs = new Set();
  const items = [];
  const state = { cloudflareRedirectHits: 0 };

  const maxListingPages = 5;
  let pageUrl = url;

  for (let page = 1; page <= maxListingPages; page++) {
    const listingFetch = await fetchHtml(pageUrl, {
      requestTimeoutMs,
      maxCloudflareRedirects,
      state,
    });
    const listingHtml = listingFetch.html;

    // A) docs directly on listing
    const direct = extractDocLinksFromHtml({ baseUrl: pageUrl, html: listingHtml });
    for (const it of direct) {
      if (!it?.source_url) continue;
      if (seenDocs.has(it.source_url)) continue;
      seenDocs.add(it.source_url);
      items.push(it);
    }

    // B) follow post pages only if we still don’t have enough
    if (items.length < lim) {
      const postLinks = extractCandidatePostLinks({
        baseUrl: pageUrl,
        html: listingHtml,
        maxPosts: lim,
      });
      const needsVendimeFallback = direct.length === 0;
      const vendimePostLinks = needsVendimeFallback
        ? extractVendimePostLinksFromListing({ baseUrl: pageUrl, html: listingHtml, maxPosts: lim })
        : [];
      const mergedPostLinks = Array.from(new Set([...vendimePostLinks, ...postLinks])).slice(0, lim);

      for (const postUrl of mergedPostLinks) {
        if (items.length >= lim) break;

        let postHtml;
        try {
          const postFetch = await fetchHtml(postUrl, {
            requestTimeoutMs,
            maxCloudflareRedirects,
            state,
          });
          postHtml = postFetch.html;
        } catch {
          continue;
        }

        const best = pickBestDocumentFromPost({ postUrl, html: postHtml });
        if (!best?.source_url) continue;
        const ok =
          getHost(url) === getHost(best.source_url) ||
          isProbablySameSite(url, best.source_url);
        if (!ok) continue;

        if (seenDocs.has(best.source_url)) continue;
        seenDocs.add(best.source_url);
        items.push(best);
      }
    }

    if (items.length >= lim) break;

    // C) pagination
    const nextUrl = findNextPageUrl({ baseUrl: pageUrl, html: listingHtml });
    if (!nextUrl || nextUrl === pageUrl) break;
    pageUrl = nextUrl;
  }

  return { url, items: items.slice(0, lim) };
}

module.exports = { scrapeGenericDocuments };

// backend/scrapers/genericDocuments.js
const cheerio = require("cheerio");

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

function isProbablySameSite(baseUrl, candidateUrl) {
  try {
    const a = new URL(baseUrl);
    const b = new URL(candidateUrl);
    return a.hostname.toLowerCase() === b.hostname.toLowerCase();
  } catch {
    return false;
  }
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
    const abs = makeAbsolute(baseUrl, href);
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
    const abs = makeAbsolute(baseUrl, src);
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

    const abs = makeAbsolute(baseUrl, cand);
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
      const abs = makeAbsolute(baseUrl, u);
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
    const abs = makeAbsolute(baseUrl, x);
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

async function fetchHtml(url) {
  const headersA = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "sq-AL,sq;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };

  let res = await fetch(url, { headers: headersA, redirect: "follow" });

  // Some sites (and vendime.al) may return 406/403 for botty headers — retry with a slightly different UA.
  if (res.status === 406 || res.status === 403) {
    const headersB = {
      ...headersA,
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    };
    res = await fetch(url, { headers: headersB, redirect: "follow" });
  }

  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("utf8");
}


async function scrapeGenericDocuments({ url, limit = 50 }) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));

  const seenDocs = new Set();
  const items = [];

  const maxListingPages = 5;
  let pageUrl = url;

  for (let page = 1; page <= maxListingPages; page++) {
    const listingHtml = await fetchHtml(pageUrl);

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
        maxPosts: 20,
      });

      for (const postUrl of postLinks) {
        if (items.length >= lim * 2) break;

        let postHtml;
        try {
          postHtml = await fetchHtml(postUrl);
        } catch {
          continue;
        }

        const more = extractDocLinksFromHtml({
          baseUrl: postUrl,
          html: postHtml,
          pageTitleFallback: "",
        });

        for (const it of more) {
          if (!it?.source_url) continue;
          const ok =
            getHost(url) === getHost(it.source_url) ||
            isProbablySameSite(url, it.source_url);
          if (!ok) continue;

          if (seenDocs.has(it.source_url)) continue;
          seenDocs.add(it.source_url);
          items.push(it);
        }
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

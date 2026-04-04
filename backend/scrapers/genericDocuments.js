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
const KONSULTIME_MIXED_KEEP_RE =
  /\b(konsultim[a-z]*|konsultime[a-z]*|degjes[a-z]*|njoftim[a-z]*|proces\s*verbal[a-z]*|takim[a-z]*|projekt[a-z]*|draft[a-z]*|plan[a-z]*|strategji[a-z]*|buxhet[a-z]*|pba|pyetesor[a-z]*|anket[a-z]*|koment[a-z]*)\b/;

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

function normalizeForActionLabel(s) {
  return normalizeTitle(s).replace(/\s+/g, " ").trim();
}

const KONSULTIME_ACTION_LABELS = new Set(
  ["shiko", "lexo", "lexo me shume", "download", "shkarko", "view"].map((it) =>
    normalizeForActionLabel(it)
  )
);
const KONSULTIME_ULTRA_GENERIC_LABELS = new Set(
  ["njoftim", "njoftime", "bashkia"].map((it) => normalizeForActionLabel(it))
);
const GENERIC_TITLE_LABELS = new Set(
  [
    "shkarko",
    "download",
    "pdf",
    "shiko vendimin",
    "kliko ketu",
    "klikoni ketu",
    "lexo me shume",
    "read more",
    "shiko",
    "lexo",
    "view",
  ].map((it) => normalizeForActionLabel(it))
);

function isKonsultimeActionLabelTitle(s) {
  const normalized = normalizeForActionLabel(s);
  if (!normalized) return false;
  return KONSULTIME_ACTION_LABELS.has(normalized);
}

function normalizeMunicipalityContext(municipalityContext) {
  return normalizeTitle(String(municipalityContext || "").replace(/[-_]+/g, " "));
}

function isUltraGenericKonsultimeTitle(title, municipalityContext = "") {
  const normalizedTitle = normalizeTitle(title);
  if (!normalizedTitle) return false;
  if (KONSULTIME_ULTRA_GENERIC_LABELS.has(normalizedTitle)) return true;

  const municipalityNormalized = normalizeMunicipalityContext(municipalityContext);
  if (!municipalityNormalized) return false;
  return normalizedTitle === `bashkia ${municipalityNormalized}`;
}

function isInvalidKonsultimeTitle(s, municipalityContext = "") {
  const normalized = normalizeTitle(s);
  if (!normalized) return true;
  if (normalized.length < 4) return true;
  if (/^(https?:\/\/|www\.)/i.test(String(s || "").trim())) return true;
  if (isKonsultimeActionLabelTitle(s)) return true;
  if (isUltraGenericKonsultimeTitle(s, municipalityContext)) return true;
  return false;
}

function looksLikeUrlText(s) {
  const text = cleanText(s);
  if (!text) return false;
  return /^(https?:\/\/|www\.)/i.test(text);
}

function looksLikeKonsultimeMixed({ title = "", url = "", context = "" }) {
  const haystack = normalizeTitle(`${title} ${url} ${context}`.trim());
  if (!haystack) return false;
  return KONSULTIME_MIXED_KEEP_RE.test(haystack);
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

function buildItem({ baseUrl, linkUrl, titleText, sourcePageUrl = null }) {
  return buildItemWithOptions({
    baseUrl,
    linkUrl,
    titleText,
    sourcePageUrl,
    publishedDate: null,
  });
}

function buildItemWithOptions({ baseUrl, linkUrl, titleText, sourcePageUrl, publishedDate }) {
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
    publishedDate ||
    parseDateFromText(fn) ||
    parseDateFromText(abs);

  return {
    title,
    title_normalized: normalizeTitle(title),
    source_url: abs,
    source_page_url: sourcePageUrl ? makeAbsolute(baseUrl, sourcePageUrl) : null,
    published_date: published_date || null,
    number: null,
  };
}


function isGenericTitle(s) {
  const t = normalizeForActionLabel(s);
  if (!t) return false;
  return GENERIC_TITLE_LABELS.has(t);
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
    .replace(/\.(pdf|doc|docx|rtf|xls|xlsx|zip|rar)(\?.*)?$/i, "")
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

function extractLikelyDateFromHtml(html) {
  const $ = cheerio.load(html || "");

  const metaCandidates = [
    $('meta[property="article:published_time"]').attr("content"),
    $('meta[property="article:modified_time"]').attr("content"),
    $('meta[property="og:published_time"]').attr("content"),
    $('meta[name="date"]').attr("content"),
    $('meta[name="publish_date"]').attr("content"),
  ];
  for (const candidate of metaCandidates) {
    const parsed = parseDateFromText(candidate);
    if (parsed) return parsed;
  }

  const timeCandidates = [];
  $("time[datetime]").each((_, el) => {
    timeCandidates.push($(el).attr("datetime"));
    timeCandidates.push($(el).text());
  });
  for (const candidate of timeCandidates) {
    const parsed = parseDateFromText(candidate);
    if (parsed) return parsed;
  }

  const textDateCandidates = [];
  $(
    ".post-date, .entry-date, .published, .date, .elementor-post-date, .meta-date, .posted-on"
  ).each((_, el) => textDateCandidates.push($(el).text()));
  for (const candidate of textDateCandidates) {
    const parsed = parseDateFromText(candidate);
    if (parsed) return parsed;
  }

  const heading = cleanText($("h1").first().text()) || cleanText($("title").first().text());
  return parseDateFromText(heading);
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
function extractDocLinksFromHtml({
  baseUrl,
  html,
  pageTitleFallback = "",
  sourcePageUrl = null,
}) {
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
      sourcePageUrl: sourcePageUrl || baseUrl,
    });
    if (item) out.push(item);
  });

  // 2) iframe/embed/object/source
  $("iframe, embed, object, source").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data");
    const abs = resolveDocumentCandidateUrl(baseUrl, src);
    if (!abs) return;
    if (!looksLikeDoc(abs)) return;

    const item = buildItem({
      baseUrl,
      linkUrl: abs,
      titleText: pageTitleFallback,
      sourcePageUrl: sourcePageUrl || baseUrl,
    });
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
    const item = buildItem({
      baseUrl,
      linkUrl: abs,
      titleText: txt,
      sourcePageUrl: sourcePageUrl || baseUrl,
    });
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
      const item = buildItem({
        baseUrl,
        linkUrl: abs,
        titleText: txt,
        sourcePageUrl: sourcePageUrl || baseUrl,
      });
      if (item) out.push(item);
    }
  });

  // 5) last resort: scan raw HTML for doc-ish URLs
  if (out.length === 0) {
    const re = /(https?:\/\/[^\s"'<>]+|\/wp-content\/uploads\/[^\s"'<>]+)/gi;
    const raw = html.match(re) || [];
    for (const x of raw) {
      const abs = resolveDocumentCandidateUrl(baseUrl, x);
      if (!abs) continue;
      if (!looksLikeDoc(abs)) continue;

      const item = buildItem({
        baseUrl,
        linkUrl: abs,
        titleText: pageTitleFallback,
        sourcePageUrl: sourcePageUrl || baseUrl,
      });
      if (item) out.push(item);
    }
  }

  return out;
}

function isAssetLikeUrl(url) {
  return /\.(png|jpg|jpeg|webp|gif|svg|ico|css|js|map|woff2?|ttf|otf|eot)(\?|#|$)/i.test(
    String(url || "").toLowerCase()
  );
}

function extractNearbyListingHeading(html) {
  const $ = cheerio.load(html || "");
  return cleanText(
    $("caption").first().text() ||
      $("h1").first().text() ||
      $("h2").first().text() ||
      $(".wp-block-heading").first().text() ||
      $(".elementor-heading-title").first().text() ||
      $("title").first().text()
  );
}

function buildHeadingWithDateFallback({ heading, publishedDate, sourceUrl }) {
  const cleanHeading = cleanText(heading);
  if (!cleanHeading) return "";
  const dateCandidate = publishedDate || parseDateFromText(sourceUrl) || "";
  return cleanText(`${cleanHeading}${dateCandidate ? ` ${dateCandidate}` : ""}`);
}

function titleFromUrlSlug(url) {
  try {
    const parsed = new URL(String(url || ""));
    const parts = parsed.pathname.split("/").filter(Boolean);
    const slug = decodeURIComponent(parts[parts.length - 1] || "");
    return cleanText(slug.replace(/\.(html?)$/i, "").replace(/[_-]+/g, " "));
  } catch {
    return "";
  }
}

function refineKonsultimeItemTitle({ item, municipalityKey, listingHeading, listingTitle = "" }) {
  if (!item || !item.source_url) return null;
  const filenameCandidate = titleFromFilename(filenameFromUrl(item.source_url));
  const headingCandidate = buildHeadingWithDateFallback({
    heading: listingHeading,
    publishedDate: item.published_date || null,
    sourceUrl: item.source_url,
  });
  const listingTitleCandidate = cleanText(listingTitle);
  const urlSlugCandidate = titleFromUrlSlug(item.source_url);
  const candidates = [item.title || "", filenameCandidate, listingTitleCandidate, headingCandidate, urlSlugCandidate];
  const chosenTitle = candidates.find((title) => !isInvalidKonsultimeTitle(title, municipalityKey)) || "";
  if (!chosenTitle) return null;

  const publishedDate =
    item.published_date ||
    parseDateFromText(chosenTitle) ||
    parseDateFromText(item.source_url) ||
    null;
  return {
    ...item,
    title: chosenTitle,
    title_normalized: normalizeTitle(chosenTitle),
    published_date: publishedDate,
  };
}

function extractKonsultimeTableItems({ baseUrl, html, municipalityKey = "" }) {
  const $ = cheerio.load(html || "");
  const out = [];
  const pageContext = cleanText(
    $("h1").first().text() || $("title").first().text() || $("main").first().text()
  ).slice(0, 400);

  $("table tr").each((_, row) => {
    const $row = $(row);
    const $cells = $row.find("th, td");
    if (!$cells.length) return;

    const rowText = cleanText($row.text());
    if (!rowText) return;

    let linkUrl = null;
    let linkText = "";
    $row.find("a[href]").each((__, a) => {
      if (linkUrl) return;
      const href = $(a).attr("href");
      const abs = resolveDocumentCandidateUrl(baseUrl, href);
      if (!abs) return;
      if (isAssetLikeUrl(abs)) return;
      if (!looksLikeDoc(abs) && !isProbablySameSite(baseUrl, abs)) return;
      linkUrl = abs;
      linkText = cleanText($(a).text());
    });

    if (!linkUrl) return;

    const nonEmptyCells = [];
    $cells.each((__, cell) => {
      const txt = cleanText($(cell).text());
      if (txt) nonEmptyCells.push(txt);
    });

    const meaningfulCellCandidates = nonEmptyCells
      .filter((txt) => !parseDateFromText(txt))
      .filter((txt) => !isInvalidKonsultimeTitle(txt, municipalityKey))
      .filter((txt) => !looksLikeUrlText(txt))
      .sort((a, b) => b.length - a.length);

    const bestCellTitle = meaningfulCellCandidates[0] || "";
    const filenameFallback = titleFromFilename(filenameFromUrl(linkUrl));
    const filenameCandidate = isInvalidKonsultimeTitle(filenameFallback, municipalityKey)
      ? ""
      : filenameFallback;
    const secondaryCellCandidate = meaningfulCellCandidates.find((txt) => txt !== bestCellTitle) || "";

    const tableEl = $row.closest("table");
    const captionText = cleanText(tableEl.find("caption").first().text());
    let headingNearby = captionText;
    if (!headingNearby && tableEl.length) {
      const previousHeading = tableEl
        .prevAll("h1, h2, h3, h4, .wp-block-heading, .elementor-heading-title")
        .first();
      headingNearby = cleanText(previousHeading.text());
    }
    const rowDateCandidate = nonEmptyCells.map((txt) => parseDateFromText(txt)).find((x) => !!x) || "";
    const headingWithDateRaw = headingNearby
      ? cleanText(`${headingNearby}${rowDateCandidate ? ` ${rowDateCandidate}` : ""}`)
      : "";
    const headingWithDate = isInvalidKonsultimeTitle(headingWithDateRaw, municipalityKey)
      ? ""
      : headingWithDateRaw;
    const rowTextCandidate = isInvalidKonsultimeTitle(rowText, municipalityKey) ? "" : rowText;
    const linkTextCandidate = isInvalidKonsultimeTitle(linkText, municipalityKey) ? "" : linkText;

    const title =
      bestCellTitle ||
      filenameCandidate ||
      secondaryCellCandidate ||
      headingWithDate ||
      rowTextCandidate ||
      linkTextCandidate ||
      "";
    if (!title) return;
    const publishedDate =
      nonEmptyCells.map((txt) => parseDateFromText(txt)).find((x) => !!x) ||
      parseDateFromText(title) ||
      parseDateFromText(linkUrl);

    const looksLikeMixed = looksLikeKonsultimeMixed({
      title,
      url: linkUrl,
      context: `${rowText} ${pageContext}`,
    });

    if (!looksLikeMixed && !looksLikeDoc(linkUrl)) return;

    const item = buildItemWithOptions({
      baseUrl,
      linkUrl,
      titleText: title,
      sourcePageUrl: baseUrl,
      publishedDate,
    });
    if (!item) return;
    if (isInvalidKonsultimeTitle(item.title, municipalityKey)) return;
    out.push(item);
  });

  return out;
}

function extractKonsultimePostLinksFromListing({ baseUrl, html, maxPosts = 20 }) {
  const $ = cheerio.load(html || "");
  const seen = new Set();
  const out = [];

  const selectors = [
    "article a[href]",
    ".entry-title a[href]",
    ".post-title a[href]",
    ".elementor-post__title a[href]",
    ".elementor-widget-posts a[href]",
    ".elementor-widget-loop-grid a[href]",
    ".news-list a[href]",
    ".blog-list a[href]",
    "h2 a[href]",
    "h3 a[href]",
    "li a[href]",
  ];

  function addCandidate(href, title) {
    const abs = makeAbsolute(baseUrl, href);
    if (!abs) return;
    if (!isProbablySameSite(baseUrl, abs)) return;
    const low = abs.toLowerCase();
    if (seen.has(low)) return;
    if (isAssetLikeUrl(low) || looksLikeDoc(low)) return;
    if (/(\/category\/|\/tag\/|\?s=|\/feed\/|\/author\/|\/wp-json\/)/i.test(low)) return;

    const cleanTitle = cleanText(title);
    const titleOrUrlMatches = looksLikeKonsultimeMixed({
      title: cleanTitle,
      url: abs,
      context: "",
    });
    if (!titleOrUrlMatches) return;
    seen.add(low);
    out.push({ url: abs, title: cleanTitle });
  }

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      if (out.length >= maxPosts) return;
      addCandidate($(el).attr("href"), $(el).text());
    });
    if (out.length >= maxPosts) break;
  }

  return out.slice(0, maxPosts);
}

function buildKonsultimeHtmlItemFromPost({
  postUrl,
  html,
  listingUrl = null,
  listingTitle = "",
  listingHeading = "",
  municipalityKey = "",
}) {
  if (!isProbablySameSite(listingUrl || postUrl, postUrl)) return null;
  const $ = cheerio.load(html || "");
  const rawPageTitle =
    cleanText($("h1").first().text()) ||
    cleanText($(".entry-title").first().text()) ||
    cleanText($("title").first().text());
  const headingCandidate = buildHeadingWithDateFallback({
    heading: listingHeading,
    publishedDate: extractLikelyDateFromHtml(html),
    sourceUrl: postUrl,
  });
  const urlSlugCandidate = titleFromUrlSlug(postUrl);
  const titleCandidates = [
    rawPageTitle,
    cleanText(listingTitle),
    headingCandidate,
    urlSlugCandidate,
  ];
  const title =
    titleCandidates.find((candidate) => !isInvalidKonsultimeTitle(candidate, municipalityKey)) || "";
  if (!title) return null;
  const postTextSample = cleanText($("main, article, .entry-content, .post-content").first().text()).slice(
    0,
    600
  );
  if (!looksLikeKonsultimeMixed({ title, url: postUrl, context: postTextSample })) return null;

  const publishedDate =
    extractLikelyDateFromHtml(html) || parseDateFromText(title) || parseDateFromText(postUrl);

  return buildItemWithOptions({
    baseUrl: postUrl,
    linkUrl: postUrl,
    titleText: title,
    sourcePageUrl: listingUrl || postUrl,
    publishedDate,
  });
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
  const vendimeSupportPath =
    /(^|[-_/])(projekt-vendimet?|procesi-vendimmarres-i-keshillit|rregjistrat-e-keshillit-bashkiak)([-_/]|$)/i;
  const vendimeSupportText =
    /\b(vendime?|projekt vendime?t?|procesi vendimmarr[eë]s i k[eë]shillit|regjistrat e k[eë]shillit bashkiak)\b/i;

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
    const linkText = cleanText($(el).text());
    if (
      !vendimeLikePath.test(path) &&
      !vendimeSupportPath.test(path) &&
      !vendimeSupportText.test(linkText)
    ) {
      return;
    }
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

function pickBestDocumentFromPost({ postUrl, html, sourcePageUrl = null }) {
  const allDocs = extractDocLinksFromHtml({
    baseUrl: postUrl,
    html,
    pageTitleFallback: "",
    sourcePageUrl: sourcePageUrl || postUrl,
  });
  if (!allDocs.length) return null;

  const preferred = allDocs.find((it) => looksLikePreferredPostDoc(it.source_url));
  return preferred || allDocs[0];
}

function findNextPageUrl({ baseUrl, html, visitedPages = new Set() }) {
  const $ = cheerio.load(html);

  const relNext = $('link[rel="next"]').attr("href");
  if (relNext) {
    const abs = makeAbsolute(baseUrl, relNext);
    if (abs && !visitedPages.has(abs) && isProbablySameSite(baseUrl, abs)) return abs;
  }

  const aNext =
    $("a.next.page-numbers").attr("href") ||
    $("a.next").attr("href") ||
    $('a[rel="next"]').attr("href");

  if (aNext) {
    const abs = makeAbsolute(baseUrl, aNext);
    if (abs && !visitedPages.has(abs) && isProbablySameSite(baseUrl, abs)) return abs;
  }

  let currentPageNum = null;
  const currentPageText =
    $(".page-numbers.current").first().text() ||
    $(".pagination .current").first().text() ||
    $(".current.page-numbers").first().text();
  const parsedCurrent = Number.parseInt(String(currentPageText || "").trim(), 10);
  if (Number.isFinite(parsedCurrent) && parsedCurrent > 0) currentPageNum = parsedCurrent;

  let fallbackUrl = null;
  let bestForward = null;
  let bestForwardNum = Number.POSITIVE_INFINITY;
  $("a.page-numbers[href], .pagination a[href], .nav-links a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const abs = makeAbsolute(baseUrl, href);
    if (!abs) return;
    if (!isProbablySameSite(baseUrl, abs)) return;
    if (visitedPages.has(abs)) return;

    const txt = cleanText($(el).text());
    const pageNum = Number.parseInt(String(txt || "").trim(), 10);
    if (!fallbackUrl) fallbackUrl = abs;

    if (Number.isFinite(pageNum) && pageNum > 0) {
      if (currentPageNum === null) {
        if (pageNum < bestForwardNum) {
          bestForwardNum = pageNum;
          bestForward = abs;
        }
      } else if (pageNum > currentPageNum && pageNum < bestForwardNum) {
        bestForwardNum = pageNum;
        bestForward = abs;
      }
    }
  });

  if (bestForward) return bestForward;
  if (fallbackUrl) return fallbackUrl;
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
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), timeoutMs);
      try {
        res = await fetchWithTimeoutAndConnectRetry(targetUrl, {
          headers: headersB,
          redirect: "follow",
          signal: controller2.signal,
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
        clearTimeout(timer2);
      }
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
  targetUrl,
  year,
  limit = 50,
  municipalityKey,
  pageStart = 1,
  category = "Vendime",
  requestTimeoutMs = SCRAPE_REQUEST_TIMEOUT_MS,
  maxCloudflareRedirects = MAX_CLOUDFLARE_REDIRECTS,
}) {
  const startUrl = targetUrl || url;
  if (!startUrl) {
    throw new Error("Missing target URL for generic documents scraper");
  }
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));

  const seenSourceUrls = new Set();
  const seenPostUrls = new Set();
  const visitedListingPages = new Set();
  const items = [];
  const state = { cloudflareRedirectHits: 0 };
  const isVendimeCategory = String(category || "").trim().toLowerCase() === "vendime";
  const isKonsultimeCategory =
    String(category || "").trim().toLowerCase() === "konsultime publike";

  const maxListingPages = 5;
  let pageUrl = startUrl;
  let usedUrl = startUrl;
  void year;
  const normalizedMunicipalityKey = normalizeMunicipalityContext(municipalityKey);
  void pageStart;

  function addItemIfUnique(item) {
    const sourceUrl = String(item?.source_url || "").trim();
    if (!sourceUrl) return;
    if (seenSourceUrls.has(sourceUrl)) return;
    seenSourceUrls.add(sourceUrl);
    items.push(item);
  }

  for (let page = 1; page <= maxListingPages; page++) {
    if (!pageUrl || visitedListingPages.has(pageUrl)) break;
    visitedListingPages.add(pageUrl);

    const listingFetch = await fetchHtml(pageUrl, {
      requestTimeoutMs,
      maxCloudflareRedirects,
      state,
    });
    const listingUrl = listingFetch.final_url || pageUrl;
    if (page === 1) usedUrl = listingUrl;
    const listingHtml = listingFetch.html;
    const listingHeading = isKonsultimeCategory ? extractNearbyListingHeading(listingHtml) : "";

    if (isKonsultimeCategory) {
      const tableItems = extractKonsultimeTableItems({
        baseUrl: listingUrl,
        html: listingHtml,
        municipalityKey: normalizedMunicipalityKey,
      });
      for (const it of tableItems) addItemIfUnique(it);
    }

    const direct = extractDocLinksFromHtml({
      baseUrl: listingUrl,
      html: listingHtml,
      sourcePageUrl: listingUrl,
    });
    for (const it of direct) {
      if (!isKonsultimeCategory) {
        addItemIfUnique(it);
        continue;
      }
      const refined = refineKonsultimeItemTitle({
        item: it,
        municipalityKey: normalizedMunicipalityKey,
        listingHeading,
      });
      if (!refined) continue;
      addItemIfUnique(refined);
    }

    if (items.length < lim) {
      let mergedPostCandidates = [];
      if (isKonsultimeCategory) {
        mergedPostCandidates = extractKonsultimePostLinksFromListing({
          baseUrl: listingUrl,
          html: listingHtml,
          maxPosts: lim,
        });
      } else {
        const postLinks = extractCandidatePostLinks({
          baseUrl: listingUrl,
          html: listingHtml,
          maxPosts: lim,
        }).map((it) => ({ url: it, title: "" }));
        const vendimePostLinks = isVendimeCategory
        ? extractVendimePostLinksFromListing({
          baseUrl: listingUrl,
          html: listingHtml,
          maxPosts: lim,
        }).map((it) => ({ url: it, title: "" }))
        : []; 
        const byUrl = new Map();
        for (const candidate of [...vendimePostLinks, ...postLinks]) {
          const key = String(candidate.url || "").trim().toLowerCase();
          if (!key || byUrl.has(key)) continue;
          byUrl.set(key, candidate);
        }
        mergedPostCandidates = Array.from(byUrl.values()).slice(0, lim);
      }

      for (const candidate of mergedPostCandidates) {
        if (items.length >= lim) break;
        const postUrl = String(candidate.url || "").trim();
        if (!postUrl) continue;
        if (seenPostUrls.has(postUrl)) continue;
        seenPostUrls.add(postUrl);

        let postHtml;
        let resolvedPostUrl = postUrl;
        try {
          const postFetch = await fetchHtml(postUrl, {
            requestTimeoutMs,
            maxCloudflareRedirects,
            state,
          });
          postHtml = postFetch.html;
          resolvedPostUrl = postFetch.final_url || postUrl;
        } catch {
          continue;
        }

        const best = pickBestDocumentFromPost({
          postUrl: resolvedPostUrl,
          html: postHtml,
          sourcePageUrl: resolvedPostUrl,
        });
        if (best?.source_url) {
          if (
            isVendimeCategory &&
            !(
              getHost(startUrl) === getHost(best.source_url) ||
              isProbablySameSite(startUrl, best.source_url)
            )
          ) {
            continue;
          }
          if (!isKonsultimeCategory) {
            addItemIfUnique(best);
            continue;
          }
          const refinedBest = refineKonsultimeItemTitle({
            item: best,
            municipalityKey: normalizedMunicipalityKey,
            listingHeading,
            listingTitle: candidate.title || "",
          });
          if (!refinedBest) continue;
          addItemIfUnique(refinedBest);
          continue;
        }

        if (!isKonsultimeCategory) continue;
        const htmlItem = buildKonsultimeHtmlItemFromPost({
          postUrl: resolvedPostUrl,
          html: postHtml,
          listingUrl,
          listingTitle: candidate.title || "",
          listingHeading,
          municipalityKey: normalizedMunicipalityKey,
        });
        if (htmlItem) addItemIfUnique(htmlItem);
      }
    }

    if (items.length >= lim) break;

    const nextUrl = findNextPageUrl({
      baseUrl: listingUrl,
      html: listingHtml,
      visitedPages: visitedListingPages,
    });
    if (!nextUrl || nextUrl === pageUrl || visitedListingPages.has(nextUrl)) break;
    pageUrl = nextUrl;
  }

  return { url: startUrl, usedUrl, items: items.slice(0, lim) };
}

module.exports = { scrapeGenericDocuments };

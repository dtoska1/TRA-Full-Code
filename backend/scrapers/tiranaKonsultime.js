"use strict";

const cheerio = require("cheerio");
const { isLikelyDocumentAttachmentUrl } = require("../lib/documentAttachments");
const {
  classifyKind,
  cleanText,
  foldText,
  makeAbsolute,
  normalizeTitle,
} = require("./konsultimeUtils");

const DEFAULT_LISTING_URL = "https://tirana.al/kategori/konsultimi-publik";
const REGISTER_URL =
  "https://tirana.al/kategoria-e-publikimit/regjistri-i-projekt-akteve-per-konsultim";
const HEARING_INFO_URL =
  "https://tirana.al/kategoria-e-publikimit/informacion-mbi-degjesat-publike";
const SOURCE_ORIGIN = "tirana.al";
const YEAR_FLOOR = 2023;
const YEAR_FLOOR_DATE = `${YEAR_FLOOR}-01-01`;
const MAX_PAGES = 20;
const ARTICLE_SELECTOR = "section.grid ul.content-full.col-3 > li > a[href]";
const REGISTER_PATTERN = "regjistri-i-projektakteve-per-konsultim";
const SCRAPE_REQUEST_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(String(process.env.SCRAPE_REQUEST_TIMEOUT_MS || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20000;
})();
const HTTP_HEADERS = {
  "User-Agent": "TransparencyRadar/0.1 (+contact@transparency-radar.al)",
  "Accept-Language": "sq-AL,sq;q=0.9,en;q=0.8",
  Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
};

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

function isTiranaHost(host) {
  return host === SOURCE_ORIGIN || host === `www.${SOURCE_ORIGIN}`;
}

function normalizeTiranaUrl(href, baseUrl = DEFAULT_LISTING_URL) {
  const url = makeAbsolute(baseUrl, href);
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (!isTiranaHost(parsed.hostname.toLowerCase())) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeTiranaDocumentUrl(href, baseUrl = DEFAULT_LISTING_URL) {
  const url = makeAbsolute(baseUrl, href);
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (!isTiranaHost(parsed.hostname.toLowerCase())) return null;
    parsed.hostname = SOURCE_ORIGIN;
    parsed.hash = "";
    const normalizedUrl = parsed.toString();
    return isLikelyDocumentAttachmentUrl(normalizedUrl) ? normalizedUrl : null;
  } catch {
    return null;
  }
}

function normalizeTiranaArticleUrl(href, baseUrl = DEFAULT_LISTING_URL) {
  const url = normalizeTiranaUrl(href, baseUrl);
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith("/artikull/")) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function isLikelyChallengeHtml(html) {
  const folded = foldText(html).slice(0, 20000);
  return (
    folded.includes("checking your browser") ||
    folded.includes("cf-browser-verification") ||
    folded.includes("cloudflare") ||
    folded.includes("captcha") ||
    folded.includes("access denied")
  );
}

function labelFromDocumentUrl(sourceUrl) {
  try {
    const lastSegment = new URL(sourceUrl).pathname.split("/").filter(Boolean).pop() || "";
    const decoded = decodeURIComponent(lastSegment)
      .replace(/\.[a-z0-9]{2,5}$/i, "")
      .replace(/[-_]+/g, " ");
    return cleanText(decoded) || "Dokument";
  } catch {
    return "Dokument";
  }
}

function collectRawDocumentUrls(value) {
  return (
    String(value || "").match(
      /https?:\/\/[^\s"'<>]+?\.(?:pdf|docx?|zip)(?:[?#][^\s"'<>]*)?/gi,
    ) || []
  );
}

function collectTiranaKonsultimeDocuments($, pageUrl = DEFAULT_LISTING_URL) {
  const documents = [];
  const seen = new Set();
  const root = $("section#right.single-content, section.single-content, .single-content");

  function addDocument(url, label) {
    const normalizedUrl = normalizeTiranaDocumentUrl(url, pageUrl);
    if (!normalizedUrl || seen.has(normalizedUrl)) return;
    seen.add(normalizedUrl);
    documents.push({
      url: normalizedUrl,
      label: cleanText(label) || labelFromDocumentUrl(normalizedUrl),
    });
  }

  root.find("a[href]").each((_, el) => {
    const link = $(el);
    addDocument(link.attr("href") || "", link.text());
  });

  root.each((_, el) => {
    const node = $(el);
    const scopedHtml = `${node.html() || ""} ${node.text() || ""}`;
    for (const rawUrl of collectRawDocumentUrls(scopedHtml)) {
      addDocument(rawUrl, "");
    }
  });

  return documents;
}

function parseTiranaNumericDate(raw) {
  const match = cleanText(raw).match(/\b(\d{1,2})\s*[/.]\s*(\d{1,2})\s*[/.]\s*(\d{4})\b/);
  if (!match) return null;

  const [, dayRaw, monthRaw, year] = match;
  const day = Number.parseInt(dayRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseTiranaLabeledPublicationDate(raw) {
  const text = cleanText(raw);
  const folded = foldText(text);
  const labelIndex = folded.indexOf("data e publikimit");
  if (labelIndex < 0) return null;

  const nearbyText = text.slice(labelIndex, labelIndex + 260);
  return parseTiranaNumericDate(nearbyText);
}

function parseTiranaUploadTimestamp(value) {
  const match = String(value || "").match(/\b(\d{4})(\d{2})(\d{2})\d{6}[_-]/);
  if (!match) return null;

  const [, year, monthRaw, dayRaw] = match;
  const month = Number.parseInt(monthRaw, 10);
  const day = Number.parseInt(dayRaw, 10);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  return `${year}-${monthRaw}-${dayRaw}`;
}

function isMeaningfulTitle(value) {
  const title = cleanText(value);
  if (title.length < 4) return false;

  const folded = foldText(title);
  if (folded.startsWith("http")) return false;
  return !new Set(["link", "shkarko", "download", "doc", "docx", "word", "ketu", "kliko ketu"]).has(
    folded,
  );
}

function stripUrlLikeText(value) {
  return cleanText(String(value || "").replace(/https?:\/\/\S+/gi, " "));
}

function deriveDocumentTitle($, link, fallbackTitle) {
  const row = link.closest("tr");
  if (row.length) {
    const cells = row.children("td");
    for (let i = 0; i < cells.length; i += 1) {
      const text = stripUrlLikeText($(cells[i]).text());
      if (parseTiranaNumericDate(text)) continue;
      if (isMeaningfulTitle(text)) return text;
    }
  }

  const linkText = stripUrlLikeText(link.text());
  if (isMeaningfulTitle(linkText)) return linkText;

  return fallbackTitle;
}

function extractTiranaArticleSummary(rawBodyText, title = "") {
  const text = cleanText(rawBodyText);
  const folded = foldText(text);
  const labelIndex = folded.indexOf("data e publikimit");
  if (labelIndex >= 0) {
    const afterLabel = text.slice(labelIndex);
    const dateMatch = afterLabel.match(/\b\d{1,2}\s*[/.]\s*\d{1,2}\s*[/.]\s*\d{4}\b/);
    if (dateMatch) {
      const candidate = cleanText(afterLabel.slice(dateMatch.index + dateMatch[0].length));
      const withoutTitle = cleanText(candidate.replace(title, " "));
      if (withoutTitle.length >= 20) return withoutTitle.slice(0, 600);
    }
  }

  return "";
}

function parseTiranaArticleLinks(html, pageUrl = DEFAULT_LISTING_URL) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const links = [];

  $(ARTICLE_SELECTOR).each((_, el) => {
    const link = $(el);
    const sourceUrl = normalizeTiranaArticleUrl(link.attr("href") || "", pageUrl);
    const title = cleanText(link.text());
    if (!sourceUrl || !title || seen.has(sourceUrl)) return;
    seen.add(sourceUrl);
    links.push({ sourceUrl, title });
  });

  return links;
}

function parseTiranaArticleDetailHtml(html, finalUrl, sourcePageUrl = DEFAULT_LISTING_URL, listingTitle = "") {
  const sourceUrl = normalizeTiranaArticleUrl(finalUrl);
  if (!sourceUrl) return null;

  const $ = cheerio.load(html);
  const bodyText = $("body").text();
  const title =
    cleanText(listingTitle) ||
    cleanText($("h1").first().text()) ||
    cleanText($("title").first().text()).replace(/\s*-\s*Bashkia Tirane?\s*$/i, "");
  if (!title) return null;

  const publishedDate = parseTiranaLabeledPublicationDate(bodyText);
  if (!publishedDate || publishedDate < YEAR_FLOOR_DATE) return null;

  const summary = extractTiranaArticleSummary(bodyText, title);
  return {
    title,
    title_normalized: normalizeTitle(title),
    summary: summary || null,
    published_date: publishedDate,
    source_url: sourceUrl,
    source_page_url: sourcePageUrl,
    source_origin: SOURCE_ORIGIN,
    kind: classifyKind(title, `${summary} ${bodyText}`),
    is_unofficial_proxy: false,
  };
}

function getTiranaKonsultimeNextPageUrl(html, currentUrl = DEFAULT_LISTING_URL) {
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
    const nextUrl = normalizeTiranaUrl(href, currentUrl);
    if (!nextUrl) continue;
    if (nextUrl.split("#")[0] === currentWithoutHash) continue;
    return nextUrl;
  }

  return null;
}

function parseTiranaRegisterHtml(html, pageUrl = REGISTER_URL) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $("a[href]").each((_, el) => {
    const link = $(el);
    const sourceUrl = normalizeTiranaUrl(link.attr("href") || "", pageUrl);
    if (!sourceUrl || seen.has(sourceUrl)) return;

    let pathname = "";
    try {
      pathname = new URL(sourceUrl).pathname.toLowerCase();
    } catch {
      return;
    }
    if (!pathname.startsWith("/uploads/") || !pathname.includes(REGISTER_PATTERN)) return;

    const rowText = cleanText(link.closest("tr").text() || link.parent().text());
    const publishedDate = parseTiranaNumericDate(rowText) || parseTiranaUploadTimestamp(sourceUrl);
    if (!publishedDate || publishedDate < YEAR_FLOOR_DATE) return;

    const title = deriveDocumentTitle($, link, "Regjistri i projektakteve per konsultim publik");
    if (!isMeaningfulTitle(title)) return;

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

function parseTiranaHearingInfoHtml(html, pageUrl = HEARING_INFO_URL) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $("table tr").each((_, row) => {
    const cells = $(row).children("td");
    if (cells.length < 2) return;

    const publishedDate = parseTiranaNumericDate(cells.eq(0).text());
    if (!publishedDate || publishedDate < YEAR_FLOOR_DATE) return;

    const title = cleanText(cells.eq(1).text()) || "Informacion mbi degjesat publike";
    if (!isMeaningfulTitle(title)) return;

    const downloadCell = cells.length >= 3 ? cells.eq(2) : cells.eq(1);
    const link = downloadCell.find("a[href]").first().length
      ? downloadCell.find("a[href]").first()
      : cells.eq(1).find("a[href]").first();
    if (!link.length) return;

    const sourceUrl = normalizeTiranaUrl(link.attr("href") || "", pageUrl);
    if (!sourceUrl || seen.has(sourceUrl)) return;

    seen.add(sourceUrl);
    items.push({
      title,
      title_normalized: normalizeTitle(title),
      summary: null,
      published_date: publishedDate,
      source_url: sourceUrl,
      source_page_url: pageUrl,
      source_origin: SOURCE_ORIGIN,
      kind: classifyKind(title, "informacion mbi degjesat publike"),
      is_unofficial_proxy: false,
    });
  });

  return items;
}

function mergeTiranaKonsultimeItems(
  articleItems,
  hearingInfoItems,
  registerItems,
  { year = null, limit = 50 } = {},
) {
  const wantedYear = Number.isInteger(Number(year)) ? Number(year) : null;
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const seen = new Set();
  const deduped = [];
  let duplicateCount = 0;

  for (const item of [...articleItems, ...hearingInfoItems, ...registerItems]) {
    if (!item?.source_url) continue;
    if (seen.has(item.source_url)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(item.source_url);
    deduped.push(item);
  }

  deduped.sort((a, b) => {
    const dateCompare = String(b.published_date || "").localeCompare(String(a.published_date || ""));
    if (dateCompare !== 0) return dateCompare;
    return String(a.source_url || "").localeCompare(String(b.source_url || ""));
  });

  const items = [];
  for (const item of deduped) {
    if (items.length >= lim) break;
    if (wantedYear && Number(String(item.published_date).slice(0, 4)) !== wantedYear) continue;
    items.push(item);
  }

  return { items, duplicateCount };
}

function getTiranaKonsultimeItemSourceKind(item) {
  const sourcePageUrl = normalizeTiranaUrl(item?.source_page_url || "", DEFAULT_LISTING_URL);
  if (item?.kind === "draft_act" || sourcePageUrl === REGISTER_URL) return "register";
  if (sourcePageUrl === HEARING_INFO_URL) return "hearing_info";
  return "article";
}

async function scrapeTiranaKonsultime({ url, year, limit = 50, pageStart = 1 }) {
  const siteUrl = url || DEFAULT_LISTING_URL;
  const startPage = Math.max(1, Number(pageStart) || 1);
  const articleItems = [];
  const visitedPageUrls = new Set();
  let skippedMissingDate = 0;
  let skippedDetailFetch = 0;
  let pageUrl = siteUrl;

  for (let page = 1; pageUrl && page <= MAX_PAGES; page += 1) {
    if (visitedPageUrls.has(pageUrl)) break;
    visitedPageUrls.add(pageUrl);

    const fetched = await fetchHtml(pageUrl);
    if (!fetched.ok) {
      throw new Error(`Tirana konsultime listing fetch failed: HTTP ${fetched.status}`);
    }
    if (isLikelyChallengeHtml(fetched.html)) {
      throw new Error("Tirana official Konsultime scraper hit a bot/challenge page.");
    }

    const currentUrl = fetched.url || pageUrl;
    const articleLinks = page >= startPage ? parseTiranaArticleLinks(fetched.html, currentUrl) : [];
    if (page === startPage && articleLinks.length === 0) {
      throw new Error("Tirana official Konsultime scraper found no article links.");
    }

    for (const article of articleLinks) {
      let detailFetched = null;
      try {
        detailFetched = await fetchHtml(article.sourceUrl);
      } catch {
        skippedDetailFetch += 1;
        continue;
      }
      if (!detailFetched.ok) {
        skippedDetailFetch += 1;
        continue;
      }
      if (!parseTiranaLabeledPublicationDate(cheerio.load(detailFetched.html)("body").text())) {
        skippedMissingDate += 1;
        continue;
      }
      const item = parseTiranaArticleDetailHtml(
        detailFetched.html,
        detailFetched.url || article.sourceUrl,
        currentUrl,
        article.title,
      );
      if (item) articleItems.push(item);
    }

    const nextPageUrl = getTiranaKonsultimeNextPageUrl(fetched.html, currentUrl);
    if (!nextPageUrl || visitedPageUrls.has(nextPageUrl)) break;
    pageUrl = nextPageUrl;
  }

  let registerItems = [];
  try {
    const fetchedRegister = await fetchHtml(REGISTER_URL);
    if (fetchedRegister.ok && !isLikelyChallengeHtml(fetchedRegister.html)) {
      registerItems = parseTiranaRegisterHtml(fetchedRegister.html, fetchedRegister.url || REGISTER_URL);
    }
  } catch {
    registerItems = [];
  }

  let hearingInfoItems = [];
  try {
    const fetchedHearing = await fetchHtml(HEARING_INFO_URL);
    if (fetchedHearing.ok && !isLikelyChallengeHtml(fetchedHearing.html)) {
      hearingInfoItems = parseTiranaHearingInfoHtml(fetchedHearing.html, fetchedHearing.url || HEARING_INFO_URL);
    }
  } catch {
    hearingInfoItems = [];
  }

  const merged = mergeTiranaKonsultimeItems(articleItems, hearingInfoItems, registerItems, {
    year,
    limit,
  });

  let documentDetailPagesFetched = 0;
  let documentDetailFetchFailures = 0;
  const documentCountsBySource = {
    article: 0,
    register: 0,
    hearing_info: 0,
  };

  for (const item of merged.items) {
    const sourceKind = getTiranaKonsultimeItemSourceKind(item);
    item.documents = [];

    const directDocumentUrl = normalizeTiranaDocumentUrl(
      item.source_url,
      item.source_page_url || siteUrl,
    );
    if (directDocumentUrl) {
      item.documents = [
        {
          url: directDocumentUrl,
          label: cleanText(item.title) || labelFromDocumentUrl(directDocumentUrl),
        },
      ];
    } else {
      try {
        const detailFetched = await fetchHtml(item.source_url);
        if (detailFetched.ok && !isLikelyChallengeHtml(detailFetched.html)) {
          documentDetailPagesFetched += 1;
          const $ = cheerio.load(detailFetched.html);
          item.documents = collectTiranaKonsultimeDocuments(
            $,
            detailFetched.url || item.source_url,
          );
        } else {
          documentDetailFetchFailures += 1;
        }
      } catch {
        documentDetailFetchFailures += 1;
      }
    }

    documentCountsBySource[sourceKind] += item.documents.length;
  }

  return {
    url: siteUrl,
    items: merged.items,
    meta: {
      source_origin: SOURCE_ORIGIN,
      custom_official_scraper: true,
      visited_pages: visitedPageUrls.size,
      article_items: articleItems.length,
      hearing_info_items: hearingInfoItems.length,
      register_items: registerItems.length,
      skipped_missing_date: skippedMissingDate,
      skipped_detail_fetch: skippedDetailFetch,
      duplicate_source_urls: merged.duplicateCount,
      document_links:
        documentCountsBySource.article +
        documentCountsBySource.register +
        documentCountsBySource.hearing_info,
      article_document_links: documentCountsBySource.article,
      register_document_links: documentCountsBySource.register,
      hearing_info_document_links: documentCountsBySource.hearing_info,
      document_detail_pages_fetched: documentDetailPagesFetched,
      document_detail_fetch_failures: documentDetailFetchFailures,
    },
  };
}

module.exports = {
  classifyKind,
  collectTiranaKonsultimeDocuments,
  getTiranaKonsultimeNextPageUrl,
  mergeTiranaKonsultimeItems,
  normalizeTiranaArticleUrl,
  normalizeTiranaDocumentUrl,
  parseTiranaArticleDetailHtml,
  parseTiranaArticleLinks,
  parseTiranaHearingInfoHtml,
  parseTiranaLabeledPublicationDate,
  parseTiranaNumericDate,
  parseTiranaRegisterHtml,
  parseTiranaUploadTimestamp,
  scrapeTiranaKonsultime,
};

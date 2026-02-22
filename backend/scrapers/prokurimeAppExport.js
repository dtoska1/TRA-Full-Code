"use strict";

const cheerio = require("cheerio");
const { parse: parseCsvSync } = require("csv-parse/sync");
const {
  buildMunicipalityTermSet,
  matchAuthorityToMunicipality,
  normalizeText,
} = require("../lib/prokurimeAuthorityMatch");

const APP_EXPORT_PAGE_URLS = [
  "https://www.app.gov.al/eksportimi-i-procedurave-te-publikuara/",
  "https://www.app.gov.al/export-public-calls/",
];

const DEFAULT_TIMEOUT_MS = 20000;

const AUTHORITY_HEADER_KEYWORDS = [
  "autoriteti kontraktor",
  "autoritet kontraktor",
  "emri i autoritetit kontraktor",
  "contracting authority",
  "authority",
];

const TITLE_HEADER_KEYWORDS = [
  "objekti i kontrates",
  "object of contract",
  "object",
  "pershkrimi",
  "description",
  "title",
  "procedure",
];

const DATE_HEADER_KEYWORDS = [
  "data e publikimit",
  "publication date",
  "date of publication",
  "publikimit",
  "date",
  "data",
];

const DETAIL_HEADER_KEYWORDS = [
  "link",
  "url",
  "details",
  "detail",
  "notice",
  "njoftim",
  "document",
  "dokument",
  "file",
];

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stripBom(value) {
  const text = String(value || "");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function detectDelimiter(raw) {
  const text = stripBom(raw);
  let inQuotes = false;
  let commaCount = 0;
  let semicolonCount = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (inQuotes) continue;
    if (ch === ",") commaCount += 1;
    if (ch === ";") semicolonCount += 1;
    if (ch === "\n" || ch === "\r") break;
  }

  return semicolonCount > commaCount ? ";" : ",";
}

function parseCsvRecordsStrict(raw) {
  const delimiter = detectDelimiter(raw);
  try {
    const headerRows = parseCsvSync(raw, {
      bom: true,
      delimiter,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: false,
      to_line: 1,
    });
    if (!headerRows.length || !Array.isArray(headerRows[0])) {
      return { headers: [], records: [] };
    }

    const headers = headerRows[0].map((h) => String(h || "").trim());
    if (!headers.some(Boolean)) {
      throw new Error("Invalid CSV: header row is empty.");
    }

    const recordsRaw = parseCsvSync(raw, {
      bom: true,
      columns: true,
      delimiter,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: false,
    });

    const records = recordsRaw.map((record) => {
      const out = {};
      for (const [key, value] of Object.entries(record || {})) {
        out[String(key || "").trim()] = String(value || "").trim();
      }
      return out;
    });
    return { headers, records };
  } catch (err) {
    const message = String(err?.message || "Failed to parse CSV");
    throw new Error(`Invalid CSV: ${message}`);
  }
}

function hasYearToken({ href, text, year }) {
  const yearText = String(year);
  const hay = `${String(href || "")} ${String(text || "")}`.toLowerCase();
  const escapedYear = yearText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^0-9])${escapedYear}([^0-9]|$)`);
  return re.test(hay);
}

function discoverYearCsvUrlFromHtml({ html, pageUrl, year }) {
  const $ = cheerio.load(html || "");
  const candidates = [];

  $("a[href]").each((_, element) => {
    const href = String($(element).attr("href") || "").trim();
    if (!href) return;

    let absoluteUrl;
    try {
      absoluteUrl = new URL(href, pageUrl).toString();
    } catch {
      return;
    }

    const text = String($(element).text() || "").trim();
    const isYearCandidate = hasYearToken({ href: absoluteUrl, text, year });
    const lowerUrl = absoluteUrl.toLowerCase();

    let score = 0;
    if (isYearCandidate) score += 200;
    if (/\.csv(\?|#|$)/i.test(lowerUrl)) score += 120;
    if (lowerUrl.includes("exportdocument")) score += 80;
    if (lowerUrl.includes("/getdata/")) score += 40;
    if (/csv|excel|export/i.test(String(text || ""))) score += 20;
    if (score === 0) return;

    candidates.push({
      url: absoluteUrl,
      score,
      isYearCandidate,
    });
  });

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const yearOnly = candidates.filter((c) => c.isYearCandidate);
  if (!yearOnly.length) return null;
  return yearOnly[0].url;
}

async function fetchTextWithTimeout(url, { fetchImpl, requestTimeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html, text/csv, application/csv, text/plain;q=0.9, */*;q=0.8",
      },
    });

    const finalUrl = String(response.url || url);
    if (!response.ok) {
      const err = new Error(`Fetch failed: ${response.status} ${response.statusText}`);
      err.code = `HTTP_${response.status}`;
      err.final_url = finalUrl;
      throw err;
    }

    const text = await response.text();
    return { text, finalUrl };
  } catch (err) {
    if (err?.name === "AbortError") {
      const timeoutErr = new Error(`Request timed out after ${requestTimeoutMs}ms: ${url}`);
      timeoutErr.code = "TIMEOUT";
      timeoutErr.final_url = url;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function getHeaderEntries(record) {
  return Object.keys(record || {}).map((raw) => ({
    raw,
    normalized: normalizeText(raw),
  }));
}

function getValueByHeaderKeywords(record, headerEntries, keywords) {
  for (const keyword of keywords) {
    const normalizedKeyword = normalizeText(keyword);
    for (const entry of headerEntries) {
      if (!entry.normalized) continue;
      if (!entry.normalized.includes(normalizedKeyword)) continue;
      const value = String(record[entry.raw] || "").trim();
      if (value) return value;
    }
  }
  return "";
}

function extractUrlFromValue(value, baseUrl) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const direct = raw.match(/https?:\/\/[^\s<>"']+/i);
  if (direct && direct[0]) return direct[0];

  if (/^\//.test(raw) || raw.startsWith("./")) {
    try {
      return new URL(raw, baseUrl).toString();
    } catch {
      return "";
    }
  }

  return "";
}

function parseKnownDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const yyyy = Number(m[1]);
    const mm = Number(m[2]);
    const dd = Number(m[3]);
    const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (
      dt.getUTCFullYear() === yyyy &&
      dt.getUTCMonth() === mm - 1 &&
      dt.getUTCDate() === dd
    ) {
      return `${m[1]}-${m[2]}-${m[3]}`;
    }
    return null;
  }

  m = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = Number(m[3]);
    const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (
      dt.getUTCFullYear() === yyyy &&
      dt.getUTCMonth() === mm - 1 &&
      dt.getUTCDate() === dd
    ) {
      return `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
  }

  return null;
}

async function discoverExportCsvForYear({
  year,
  fetchImpl,
  requestTimeoutMs,
  pageUrls = APP_EXPORT_PAGE_URLS,
}) {
  let lastError = null;
  for (const pageUrl of pageUrls) {
    try {
      const pageFetch = await fetchTextWithTimeout(pageUrl, {
        fetchImpl,
        requestTimeoutMs,
      });
      const exportCsvUrl = discoverYearCsvUrlFromHtml({
        html: pageFetch.text,
        pageUrl: pageFetch.finalUrl || pageUrl,
        year,
      });
      if (!exportCsvUrl) {
        lastError = new Error(`No year-specific CSV link found on ${pageFetch.finalUrl || pageUrl}`);
        continue;
      }

      return {
        sourcePageUrl: pageFetch.finalUrl || pageUrl,
        exportCsvUrl,
      };
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  throw new Error(`Could not discover APP export CSV link for year ${year}`);
}

async function scrapeProkurimeAppExport({
  year,
  limit = 50,
  municipalityContext,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  pageUrls = APP_EXPORT_PAGE_URLS,
}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const municipalityTerms = buildMunicipalityTermSet(municipalityContext || {});
  if (!municipalityTerms.length) {
    throw new Error("Missing municipality term context for APP prokurime matching.");
  }

  const discovered = await discoverExportCsvForYear({
    year,
    fetchImpl,
    requestTimeoutMs,
    pageUrls,
  });
  const csvFetch = await fetchTextWithTimeout(discovered.exportCsvUrl, {
    fetchImpl,
    requestTimeoutMs,
  });
  const parsed = parseCsvRecordsStrict(csvFetch.text);

  const items = [];
  let rowsMatched = 0;
  let skippedNoMunicipalityMatch = 0;

  for (let idx = 0; idx < parsed.records.length; idx += 1) {
    const record = parsed.records[idx];
    const headers = getHeaderEntries(record);
    const authority = getValueByHeaderKeywords(record, headers, AUTHORITY_HEADER_KEYWORDS);
    const authorityMatch = matchAuthorityToMunicipality({
      authority,
      municipalityTerms,
    });
    if (!authorityMatch.matched) {
      skippedNoMunicipalityMatch += 1;
      continue;
    }
    rowsMatched += 1;

    if (items.length >= lim) continue;

    const titleRaw =
      getValueByHeaderKeywords(record, headers, TITLE_HEADER_KEYWORDS) ||
      `Prokurime APP ${year} row ${idx + 1}`;
    const publishedDateRaw = getValueByHeaderKeywords(record, headers, DATE_HEADER_KEYWORDS);
    const publishedDate = parseKnownDate(publishedDateRaw);

    let detailUrl = "";
    const detailCandidate = getValueByHeaderKeywords(record, headers, DETAIL_HEADER_KEYWORDS);
    detailUrl = extractUrlFromValue(detailCandidate, discovered.sourcePageUrl);
    if (!detailUrl) {
      for (const value of Object.values(record)) {
        detailUrl = extractUrlFromValue(value, discovered.sourcePageUrl);
        if (detailUrl) break;
      }
    }

    const sourceUrl = detailUrl || discovered.exportCsvUrl;
    const title = String(titleRaw).trim();

    items.push({
      title,
      title_normalized: normalizeTitle(title),
      source_url: sourceUrl,
      source_page_url: discovered.sourcePageUrl,
      source_origin: "app.gov.al",
      published_date: publishedDate,
      number: null,
    });
  }

  return {
    url: discovered.sourcePageUrl,
    items,
    meta: {
      source_page_url: discovered.sourcePageUrl,
      export_csv_url: discovered.exportCsvUrl,
      rows_total: parsed.records.length,
      rows_matched: rowsMatched,
      skipped_no_municipality_match: skippedNoMunicipalityMatch,
    },
  };
}

module.exports = {
  scrapeProkurimeAppExport,
  __test: {
    APP_EXPORT_PAGE_URLS,
    discoverYearCsvUrlFromHtml,
    parseCsvRecordsStrict,
    parseKnownDate,
    discoverExportCsvForYear,
  },
};

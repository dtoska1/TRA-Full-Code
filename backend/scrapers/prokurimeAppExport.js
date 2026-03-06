"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
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
const PROKURIME_APP_FIXTURES_DIR = path.join(__dirname, "..", "test", "fixtures");

const DEFAULT_TIMEOUT_MS = 20000;

const AUTHORITY_HEADER_KEYWORDS = [
  "autoriteti kontraktor",
  "autoritet kontraktor",
  "autoriteti kontraktues",
  "autoritet kontraktues",
  "emri i autoritetit kontraktor",
  "emri i autoritetit kontraktues",
  "contracting authority",
  "authority",
];

const TITLE_HEADER_KEYWORDS = [
  "objekti i kontrates",
  "objekti i prokurimit",
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

const PROCEDURE_ID_HEADER_KEYWORDS = [
  "numri i references",
  "nr i references",
  "nr reference",
  "reference no",
  "reference number",
  "procedure id",
  "id procedure",
];

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeProcedureId(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim();
}

function buildProkurimeAppDedupKey({
  year,
  municipalityId,
  procedureId,
  publishedDate,
  title,
  titleNormalized,
}) {
  const municipalityPart = String(municipalityId || "").trim() || "unknown";
  const yearPart = Number.isInteger(Number(year)) ? String(Number(year)) : "unknown";
  const procedurePart = normalizeProcedureId(procedureId);

  if (procedurePart) {
    return `prokurime|app|${yearPart}|${municipalityPart}|${procedurePart}`;
  }

  const datePart = publishedDate || "unknown";
  const titleNorm = titleNormalized || normalizeTitle(title) || "untitled";
  const titleHash = crypto.createHash("sha1").update(titleNorm).digest("hex").slice(0, 12);
  return `prokurime|app|${yearPart}|${municipalityPart}|d:${datePart}|t:${titleHash}`;
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

function isTruthyEnvFlag(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function readFixtureText(name) {
  const fixturePath = path.join(PROKURIME_APP_FIXTURES_DIR, name);
  return fs.readFileSync(fixturePath, "utf8");
}

function makeFixtureResponse(status, url, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "ERROR",
    url,
    async text() {
      return text;
    },
  };
}

function normalizeComparableUrl(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
}

function createFixtureFetchImpl({ year }) {
  const sqHtml = readFixtureText("app_export_page_sq.html");
  const enHtml = readFixtureText("app_export_page_en.html");
  const csvByYear = new Map([
    [2025, `\uFEFF${readFixtureText("app_export_sample_2025.csv")}`],
  ]);
  const sqPageKey = normalizeComparableUrl(APP_EXPORT_PAGE_URLS[0]);
  const enPageKey = normalizeComparableUrl(APP_EXPORT_PAGE_URLS[1]);

  return async (url) => {
    const rawUrl = String(url || "");
    const normalizedUrl = normalizeComparableUrl(rawUrl);
    if (normalizedUrl === sqPageKey) {
      return makeFixtureResponse(200, APP_EXPORT_PAGE_URLS[0], sqHtml);
    }
    if (normalizedUrl === enPageKey) {
      return makeFixtureResponse(200, APP_EXPORT_PAGE_URLS[1], enHtml);
    }

    let parsed = null;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return makeFixtureResponse(404, rawUrl, "not found");
    }

    if (
      String(parsed.hostname || "").toLowerCase().endsWith("app.gov.al") &&
      String(parsed.pathname || "").toLowerCase() === "/getdata/exportdocument"
    ) {
      const requestedYear = Number.parseInt(String(parsed.searchParams.get("year") || ""), 10);
      const csvRaw = csvByYear.get(requestedYear);
      if (!csvRaw) {
        return makeFixtureResponse(
          404,
          parsed.toString(),
          `fixture missing for APP export year ${requestedYear}`
        );
      }
      return makeFixtureResponse(200, parsed.toString(), csvRaw);
    }

    return makeFixtureResponse(404, rawUrl, "not found");
  };
}

function resolveMunicipalityContexts({ municipalityContext, municipalityContexts }) {
  const rawContexts = [];
  if (Array.isArray(municipalityContexts) && municipalityContexts.length > 0) {
    rawContexts.push(...municipalityContexts);
  } else if (municipalityContext) {
    rawContexts.push(municipalityContext);
  }

  const normalized = rawContexts
    .map((ctx) => {
      const municipalityId = String(ctx?.municipalityId || "").trim() || null;
      const nameKey = String(ctx?.nameKey || "")
        .trim()
        .toLowerCase();
      return {
        municipalityId,
        nameKey,
        municipalityTerms: buildMunicipalityTermSet(ctx || {}),
      };
    })
    .filter((ctx) => ctx.municipalityTerms.length > 0);

  normalized.sort((a, b) => {
    if (a.nameKey < b.nameKey) return -1;
    if (a.nameKey > b.nameKey) return 1;
    const aId = a.municipalityId || "";
    const bId = b.municipalityId || "";
    return aId.localeCompare(bId);
  });

  return normalized;
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
  offset = null,
  municipalityContext,
  municipalityContexts,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  pageUrls = APP_EXPORT_PAGE_URLS,
}) {
  const hasLimit = !(limit === null || limit === undefined || String(limit).trim() === "");
  const parsedLimit = Number(limit);
  const lim = hasLimit
    ? Math.max(1, Math.min(200, Number.isFinite(parsedLimit) ? parsedLimit : 50))
    : null;
  const hasOffset = !(offset === null || offset === undefined || String(offset).trim() === "");
  const parsedOffset = hasOffset ? Number(offset) : 0;
  if (hasOffset && (!Number.isInteger(parsedOffset) || parsedOffset < 0)) {
    throw new Error("Invalid offset. offset must be an integer >= 0.");
  }
  const rowOffset = hasOffset ? parsedOffset : 0;
  const contextConfigs = resolveMunicipalityContexts({
    municipalityContext,
    municipalityContexts,
  });
  if (!contextConfigs.length) {
    throw new Error("Missing municipality term context for APP prokurime matching.");
  }
  const effectiveFetchImpl = isTruthyEnvFlag(process.env.PROKURIME_APP_FIXTURE)
    ? createFixtureFetchImpl({ year })
    : fetchImpl;

  const discovered = await discoverExportCsvForYear({
    year,
    fetchImpl: effectiveFetchImpl,
    requestTimeoutMs,
    pageUrls,
  });
  const csvFetch = await fetchTextWithTimeout(discovered.exportCsvUrl, {
    fetchImpl: effectiveFetchImpl,
    requestTimeoutMs,
  });
  const parsed = parseCsvRecordsStrict(csvFetch.text);
  const totalRows = parsed.records.length;
  const rowWindowStart = hasOffset ? Math.min(rowOffset, totalRows) : 0;
  const rowWindowSize = lim === null ? Math.max(0, totalRows - rowWindowStart) : lim;
  const rowWindowEnd = hasOffset
    ? Math.min(totalRows, rowWindowStart + rowWindowSize)
    : totalRows;
  const rowWindowMode = hasOffset;

  const items = [];
  let rowsMatched = 0;
  let skippedNoMunicipalityMatch = 0;

  for (let idx = rowWindowStart; idx < rowWindowEnd; idx += 1) {
    const record = parsed.records[idx];
    const headers = getHeaderEntries(record);
    const authority = getValueByHeaderKeywords(record, headers, AUTHORITY_HEADER_KEYWORDS);
    let matchedContext = null;
    for (const contextConfig of contextConfigs) {
      const authorityMatch = matchAuthorityToMunicipality({
        authority,
        municipalityTerms: contextConfig.municipalityTerms,
      });
      if (!authorityMatch.matched) continue;
      matchedContext = contextConfig;
      break;
    }

    if (!matchedContext) {
      skippedNoMunicipalityMatch += 1;
      continue;
    }
    rowsMatched += 1;

    if (!rowWindowMode && lim !== null && items.length >= lim) continue;

    const titleRaw =
      getValueByHeaderKeywords(record, headers, TITLE_HEADER_KEYWORDS) ||
      `Prokurime APP ${year} row ${idx + 1}`;
    const publishedDateRaw = getValueByHeaderKeywords(record, headers, DATE_HEADER_KEYWORDS);
    const publishedDate = parseKnownDate(publishedDateRaw);
    const procedureId = getValueByHeaderKeywords(record, headers, PROCEDURE_ID_HEADER_KEYWORDS);

    let detailUrl = "";
    const detailCandidate = getValueByHeaderKeywords(record, headers, DETAIL_HEADER_KEYWORDS);
    detailUrl = extractUrlFromValue(detailCandidate, discovered.sourcePageUrl);
    if (!detailUrl) {
      for (const value of Object.values(record)) {
        detailUrl = extractUrlFromValue(value, discovered.sourcePageUrl);
        if (detailUrl) break;
      }
    }

    const normalizedProcedureId = normalizeProcedureId(procedureId);
    const sourceUrl = detailUrl
      ? detailUrl
      : normalizedProcedureId
        ? `${discovered.exportCsvUrl}#procedure=${encodeURIComponent(normalizedProcedureId)}`
        : discovered.exportCsvUrl;
    const title = String(titleRaw).trim();

    const item = {
      title,
      title_normalized: normalizeTitle(title),
      procedure_id: procedureId || null,
      source_url: sourceUrl,
      source_page_url: discovered.sourcePageUrl,
      source_origin: "app.gov.al",
      published_date: publishedDate,
      number: null,
    };
    if (matchedContext.municipalityId !== null) {
      item.municipality_id = matchedContext.municipalityId;
    }
    if (matchedContext.nameKey) {
      item.municipality_name_key = matchedContext.nameKey;
    }
    if (matchedContext.municipalityId !== null) {
      item.dedup_key = buildProkurimeAppDedupKey({
        year,
        municipalityId: matchedContext.municipalityId,
        procedureId,
        publishedDate,
        title,
        titleNormalized: item.title_normalized,
      });
    }

    items.push(item);
  }

  return {
    url: discovered.sourcePageUrl,
    items,
    meta: {
      source_page_url: discovered.sourcePageUrl,
      export_csv_url: discovered.exportCsvUrl,
      rows_total: totalRows,
      rows_matched: rowsMatched,
      skipped_no_municipality_match: skippedNoMunicipalityMatch,
      row_window_start: rowWindowStart,
      row_window_end: rowWindowEnd,
      rows_processed: rowWindowEnd - rowWindowStart,
      next_offset: rowWindowEnd < totalRows ? rowWindowEnd : null,
    },
  };
}

module.exports = {
  scrapeProkurimeAppExport,
  buildProkurimeAppDedupKey,
  parseCsvRecordsStrict,
  normalizeProcedureId,
  __test: {
    APP_EXPORT_PAGE_URLS,
    discoverYearCsvUrlFromHtml,
    parseCsvRecordsStrict,
    parseKnownDate,
    discoverExportCsvForYear,
    normalizeProcedureId,
    buildProkurimeAppDedupKey,
  },
};

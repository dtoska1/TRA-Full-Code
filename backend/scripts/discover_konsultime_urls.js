"use strict";

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const { Pool } = require("pg");

require("dotenv").config({
  path: process.env.DOTENV_CONFIG_PATH || path.join(__dirname, "..", ".env"),
  quiet: true,
});

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set. Expected backend/.env or DOTENV_CONFIG_PATH.");
  process.exit(2);
}

const REQUEST_TIMEOUT_MS = 10_000;
const CONCURRENCY = 3;
const MAX_REDIRECTS = 5;
const MAX_HOMEPAGE_CANDIDATES = 20;
const MAX_TOTAL_CANDIDATES_TO_VALIDATE = 28;
const OUTPUT_PATH = path.join(__dirname, "..", "tmp", "konsultime_discovery.json");
const USER_AGENT = "TransparencyRadarBot/1.0 (+https://github.com/dtoska1/Transparency-Radar-Albania)";

const KONSULTIME_KEYWORDS = [
  "konsultim",
  "konsultime",
  "konsultimi publik",
  "konsultim publik",
  "njoftim dhe konsultim publik",
  "regjistri elektronik",
];

const COMMON_PATHS = [
  "/konsultim",
  "/konsultime",
  "/konsultim-publik",
  "/konsultime-publike",
  "/konsultimi-publik",
  "/njoftime-dhe-konsultim-publik",
  "/regjistri-elektronik",
  "/degjesa",
  "/degjesa-publike",
  "/transparenca/konsultime",
  "/transparence/konsultime",
  "/category/konsultime",
  "/kategoria/konsultime",
];

const DOCUMENT_EXT_RE =
  /\.(pdf|doc|docx|xls|xlsx|zip|rar|7z|ppt|pptx|rtf|odt|ods|odp)(\?|#|$)/i;

function normalizeHost(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

function isSameHost(a, b) {
  return normalizeHost(a) === normalizeHost(b);
}

function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSkippableHref(href) {
  const h = String(href || "").trim().toLowerCase();
  return (
    !h ||
    h.startsWith("#") ||
    h.startsWith("mailto:") ||
    h.startsWith("tel:") ||
    h.startsWith("javascript:") ||
    h.startsWith("data:")
  );
}

function isDocumentUrl(url) {
  return DOCUMENT_EXT_RE.test(String(url || "").trim().toLowerCase());
}

function keywordHitCount(input) {
  const haystack = normalizeText(input);
  if (!haystack) return 0;

  let count = 0;
  for (const keyword of KONSULTIME_KEYWORDS) {
    if (haystack.includes(normalizeText(keyword))) count += 1;
  }
  return count;
}

function explicitPhraseBoost(input) {
  const haystack = normalizeText(input);
  if (!haystack) return 0;
  let boost = 0;
  if (haystack.includes("konsultimi publik") || haystack.includes("konsultim publik")) boost += 20;
  if (haystack.includes("njoftim dhe konsultim publik")) boost += 24;
  if (haystack.includes("regjistri elektronik")) boost += 24;
  return boost;
}

function pathScore(urlValue) {
  const haystack = normalizeText(urlValue);
  if (!haystack) return 0;
  let score = 0;
  if (/\/konsultim([/?#-]|$)/.test(haystack)) score += 34;
  if (/\/konsultime([/?#-]|$)/.test(haystack)) score += 34;
  if (/konsultim-publik|konsultimi-publik|konsultime-publike/.test(haystack)) score += 30;
  if (/njoftime-dhe-konsultim-publik/.test(haystack)) score += 34;
  if (/regjistri-elektronik/.test(haystack)) score += 30;
  if (/\/category\/konsultime|\/kategoria\/konsultime/.test(haystack)) score += 20;
  if (/transparen/.test(haystack)) score += 8;
  return score;
}

function scoreInitialCandidate(candidate) {
  const combined = `${candidate.text || ""} ${candidate.href || ""} ${candidate.url || ""}`;
  let score = 0;
  score += keywordHitCount(combined) * 16;
  score += pathScore(candidate.url || "");
  score += explicitPhraseBoost(combined);
  if (candidate.method === "homepage_link") score += 8;
  if (candidate.method === "common_path") score += 12;
  return score;
}

function extractListSignals(html) {
  const $ = cheerio.load(html || "");
  const liCount = $("li").length;
  const articleCount = $("article").length;
  const rowClassCount = $("[class*='row'], [class*='list'], [class*='post']").length;
  const newsyAnchors = $("a")
    .toArray()
    .map((el) => normalizeText($(el).text()))
    .filter((text) => text.length >= 18 && text.length <= 260).length;

  let listSignalScore = 0;
  if (liCount >= 8) listSignalScore += 8;
  if (articleCount >= 2) listSignalScore += 8;
  if (rowClassCount >= 3) listSignalScore += 8;
  if (newsyAnchors >= 5) listSignalScore += 10;

  return {
    listSignalScore,
    evidence: [
      `li_count=${liCount}`,
      `article_count=${articleCount}`,
      `row_or_list_nodes=${rowClassCount}`,
      `linked_title_like_nodes=${newsyAnchors}`,
    ],
  };
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtmlSameHost(startUrl, allowedHost) {
  let currentUrl = startUrl;

  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    let response;
    try {
      response = await fetchWithTimeout(currentUrl);
    } catch (err) {
      const isTimeout = err && (err.name === "AbortError" || err.code === "ABORT_ERR");
      return {
        ok: false,
        status: null,
        final_url: currentUrl,
        error: isTimeout ? "timeout" : "network_error",
        error_message: String(err && err.message ? err.message : err),
      };
    }

    const status = Number(response.status || 0);
    if (status >= 300 && status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return {
          ok: false,
          status,
          final_url: currentUrl,
          error: "redirect_without_location",
        };
      }

      let redirectedUrl;
      try {
        redirectedUrl = new URL(location, currentUrl).toString();
      } catch {
        return {
          ok: false,
          status,
          final_url: currentUrl,
          error: "bad_redirect_url",
        };
      }

      let redirectedHost;
      try {
        redirectedHost = new URL(redirectedUrl).hostname;
      } catch {
        return {
          ok: false,
          status,
          final_url: redirectedUrl,
          error: "bad_redirect_host",
        };
      }

      if (!isSameHost(allowedHost, redirectedHost)) {
        return {
          ok: false,
          status,
          final_url: currentUrl,
          redirect_to: redirectedUrl,
          error: "cross_domain_redirect",
        };
      }

      currentUrl = redirectedUrl;
      continue;
    }

    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const htmlLike = status === 200 && (contentType.includes("text/html") || contentType === "");

    return {
      ok: htmlLike,
      status,
      final_url: currentUrl,
      html: body,
      content_type: contentType,
      error: htmlLike ? null : status === 200 ? "non_html_content" : `http_${status}`,
    };
  }

  return {
    ok: false,
    status: null,
    final_url: startUrl,
    error: "too_many_redirects",
  };
}

function extractHomepageCandidates(html, pageUrl, baseHost) {
  const $ = cheerio.load(html || "");
  const out = [];

  $("a[href]").each((_, element) => {
    const hrefRaw = String($(element).attr("href") || "").trim();
    if (isSkippableHref(hrefRaw)) return;

    let absoluteUrl;
    try {
      absoluteUrl = new URL(hrefRaw, pageUrl).toString();
    } catch {
      return;
    }

    if (isDocumentUrl(absoluteUrl)) return;

    let host;
    try {
      host = new URL(absoluteUrl).hostname;
    } catch {
      return;
    }
    if (!isSameHost(baseHost, host)) return;

    const anchorText = String($(element).text() || "").replace(/\s+/g, " ").trim();
    const combined = `${anchorText} ${hrefRaw} ${absoluteUrl}`;
    if (keywordHitCount(combined) === 0) return;

    out.push({
      method: "homepage_link",
      text: anchorText,
      href: hrefRaw,
      url: absoluteUrl,
    });
  });

  return out;
}

function buildCommonPathCandidates(startUrl, baseHost) {
  const out = [];
  for (const pathValue of COMMON_PATHS) {
    let absoluteUrl;
    try {
      absoluteUrl = new URL(pathValue, startUrl).toString();
    } catch {
      continue;
    }

    if (isDocumentUrl(absoluteUrl)) continue;

    let host;
    try {
      host = new URL(absoluteUrl).hostname;
    } catch {
      continue;
    }
    if (!isSameHost(baseHost, host)) continue;

    out.push({
      method: "common_path",
      text: "",
      href: pathValue,
      url: absoluteUrl,
    });
  }
  return out;
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];

  for (const candidate of candidates) {
    const normalized = normalizeUrl(candidate.final_url || candidate.url);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ ...candidate, url: normalized });
  }

  return out;
}

async function validateCandidate(candidate, baseHost) {
  const fetched = await fetchHtmlSameHost(candidate.url, baseHost);
  const finalUrl = normalizeUrl(fetched.final_url || candidate.url) || candidate.url;
  if (isDocumentUrl(finalUrl)) {
    return {
      ...candidate,
      valid: false,
      score: 0,
      final_url: finalUrl,
      evidence: ["document_url_blocked"],
      error: "document_url_blocked",
      http_status: fetched.status,
    };
  }

  const combined = `${candidate.text || ""} ${candidate.href || ""} ${candidate.url || ""}`;
  const pageText = normalizeText(fetched.html || "");
  const initialScore = scoreInitialCandidate(candidate);
  const keywordHitsCombined = keywordHitCount(combined);
  const keywordHitsPage = keywordHitCount(pageText);
  const phraseBoost = explicitPhraseBoost(`${combined} ${pageText}`);
  const pathBoost = pathScore(finalUrl);
  const listSignals = extractListSignals(fetched.html || "");

  const score =
    initialScore +
    keywordHitsCombined * 6 +
    keywordHitsPage * 18 +
    pathBoost +
    phraseBoost +
    listSignals.listSignalScore;

  const valid = fetched.ok && fetched.status === 200 && keywordHitsPage > 0;
  const evidence = [
    `method=${candidate.method}`,
    `keyword_hits_link=${keywordHitsCombined}`,
    `keyword_hits_page=${keywordHitsPage}`,
    `path_score=${pathBoost}`,
    `phrase_boost=${phraseBoost}`,
    `list_signal_score=${listSignals.listSignalScore}`,
    ...listSignals.evidence,
  ];

  return {
    ...candidate,
    valid,
    score,
    final_url: finalUrl,
    http_status: fetched.status,
    error: fetched.error || null,
    error_message: fetched.error_message || null,
    evidence,
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  if (items.length === 0) return [];
  const output = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      output[current] = await mapper(items[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = [];
  for (let i = 0; i < workerCount; i += 1) workers.push(worker());
  await Promise.all(workers);
  return output;
}

async function discoverForMunicipality(row) {
  const baseUrl = String(row.base_url || "").trim();
  const finalUrl = String(row.final_url || "").trim();
  const startUrl = finalUrl || baseUrl;

  const record = {
    source_registry_id: row.source_registry_id,
    municipality_id: row.municipality_id,
    name_key: row.name_key,
    name_sq: row.name_sq,
    base_url: baseUrl || null,
    start_url: startUrl || null,
    best_url: null,
    score: 0,
    evidence: [],
    confirmed: false,
    errors: [],
    top_candidates: [],
  };

  if (!startUrl) {
    record.errors.push("missing_start_url");
    return record;
  }

  let baseHost;
  try {
    baseHost = new URL(startUrl).hostname;
  } catch {
    record.errors.push("invalid_start_url");
    return record;
  }

  const homepage = await fetchHtmlSameHost(startUrl, baseHost);
  if (!homepage.ok) {
    record.errors.push(homepage.error || "homepage_fetch_failed");
    if (homepage.status) record.errors.push(`homepage_status_${homepage.status}`);
  }

  const homepageCandidates = homepage.ok
    ? dedupeCandidates(extractHomepageCandidates(homepage.html || "", homepage.final_url || startUrl, baseHost))
        .map((candidate) => ({ ...candidate, initial_score: scoreInitialCandidate(candidate) }))
        .sort((a, b) => b.initial_score - a.initial_score)
        .slice(0, MAX_HOMEPAGE_CANDIDATES)
    : [];

  const commonPathCandidates = dedupeCandidates(buildCommonPathCandidates(startUrl, baseHost));
  const combined = dedupeCandidates([...homepageCandidates, ...commonPathCandidates]).slice(
    0,
    MAX_TOTAL_CANDIDATES_TO_VALIDATE
  );

  if (combined.length === 0) {
    record.errors.push("no_seed_candidates");
    return record;
  }

  const validated = [];
  for (const candidate of combined) {
    const result = await validateCandidate(candidate, baseHost);
    if (result.valid) validated.push(result);
  }

  const ranked = dedupeCandidates(validated).sort((a, b) => b.score - a.score);
  record.top_candidates = ranked.slice(0, 3).map((candidate) => ({
    url: candidate.final_url || candidate.url,
    score: candidate.score,
    method: candidate.method,
    evidence: candidate.evidence,
  }));

  if (ranked.length === 0) {
    record.errors.push("no_valid_konsultime_candidates");
    return record;
  }

  const best = ranked[0];
  record.best_url = best.final_url || best.url;
  record.score = best.score;
  record.evidence = best.evidence;
  return record;
}

function printSummary(candidates) {
  const missingBefore = candidates.length;
  const discovered = candidates.filter((item) => item.best_url).length;
  const stillMissing = candidates.filter((item) => !item.best_url).map((item) => item.name_key);

  console.log(`Missing konsultime_url before discovery: ${missingBefore}`);
  console.log(`Discovered best_url candidates: ${discovered}`);
  console.log(`Still missing candidates (no best_url): ${stillMissing.length}`);
  if (stillMissing.length > 0) {
    for (const key of stillMissing) console.log(`- ${key}`);
  }
}

async function main() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    options: "-c client_encoding=UTF8",
  });

  try {
    const query = `
      SELECT
        sr.id AS source_registry_id,
        sr.municipality_id,
        sr.base_url,
        sr.final_url,
        m.name_key,
        m.name_sq
      FROM source_registry sr
      JOIN municipalities m ON m.id = sr.municipality_id
      WHERE sr.is_primary = TRUE
        AND (sr.konsultime_url IS NULL OR btrim(sr.konsultime_url) = '')
      ORDER BY m.name_key ASC
    `;
    const { rows } = await pool.query(query);
    const candidates = await mapWithConcurrency(rows, CONCURRENCY, discoverForMunicipality);

    const payload = {
      generated_at: new Date().toISOString(),
      request_timeout_ms: REQUEST_TIMEOUT_MS,
      concurrency: CONCURRENCY,
      notes: [
        "No database writes are performed by this script.",
        "Review best_url candidates and set confirmed=true before apply.",
      ],
      candidates,
      stats: {
        missing_before: rows.length,
        discovered: candidates.filter((item) => item.best_url).length,
        still_missing: candidates.filter((item) => !item.best_url).length,
      },
    };

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    printSummary(candidates);
    console.log(`Wrote discovery file: ${OUTPUT_PATH}`);
  } catch (err) {
    console.error("ERROR:", err && err.message ? err.message : err);
    process.exit(1);
  } finally {
    try {
      await pool.end();
    } catch {
      // ignore
    }
  }
}

main();


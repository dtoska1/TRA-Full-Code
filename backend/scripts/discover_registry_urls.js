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
const USER_AGENT = "TransparencyRadarBot/1.0 (+https://github.com/dtoska1/Transparency-Radar-Albania)";

const CATEGORY_CONFIG = {
  prokurime: {
    displayName: "Prokurime",
    columnName: "prokurime_url",
    outputName: "prokurime",
    commonPaths: [
      "/prokurime",
      "/prokurim",
      "/tendera",
      "/tender",
      "/prokurime-publike",
      "/njoftime/prokurime",
      "/category/prokurime",
      "/kategoria/prokurime",
      "/transparenca/prokurime",
    ],
    keywordPatterns: [
      { label: "prokurim", re: /\bprokurim[a-z-]*\b/g, points: 38 },
      { label: "procurement", re: /\bprocurement\b/g, points: 28 },
      { label: "tender", re: /\btender[a-z-]*\b/g, points: 28 },
      { label: "njoftim", re: /\bnjoftim[a-z-]*\b/g, points: 18 },
    ],
  },
  konsultime: {
    displayName: "Konsultime publike",
    columnName: "konsultime_url",
    outputName: "konsultime",
    commonPaths: [
      "/konsultime",
      "/konsultim",
      "/konsultim-publik",
      "/konsultime-publike",
      "/degjesa-publike",
      "/degjesa",
      "/category/konsultime",
      "/kategoria/konsultime",
      "/transparenca/konsultime",
    ],
    keywordPatterns: [
      { label: "konsultim", re: /\bkonsultim[a-z-]*\b/g, points: 36 },
      { label: "konsultime", re: /\bkonsultime[a-z-]*\b/g, points: 36 },
      { label: "konsultim_publik", re: /\bkonsultim[a-z-]*\s+publik[a-z-]*\b/g, points: 28 },
      { label: "degjesa", re: /\bdegjes[a-z-]*\b/g, points: 26 },
    ],
  },
};

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
    const u = new URL(rawUrl);
    u.hash = "";
    return u.toString();
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

function parseArgs(argv) {
  let categoryArg = "";
  let scopeArg = "all";
  let includeExisting = false;
  let scopeMode = "all";

  const rawArgs = argv.slice(2);
  for (let idx = 0; idx < rawArgs.length; idx += 1) {
    const arg = String(rawArgs[idx] || "").trim();
    if (!arg) continue;

    if (arg.startsWith("--category=")) {
      categoryArg = arg.slice("--category=".length);
      continue;
    }
    if (arg === "--category") {
      categoryArg = String(rawArgs[idx + 1] || "").trim();
      idx += 1;
      continue;
    }
    if (arg.startsWith("--scope=")) {
      scopeArg = arg.slice("--scope=".length);
      scopeMode = "scope";
      continue;
    }
    if (arg === "--scope") {
      scopeArg = String(rawArgs[idx + 1] || "").trim();
      scopeMode = "scope";
      idx += 1;
      continue;
    }
    if (arg.startsWith("--only=")) {
      scopeArg = arg.slice("--only=".length);
      scopeMode = "only";
      continue;
    }
    if (arg === "--only") {
      scopeArg = String(rawArgs[idx + 1] || "").trim();
      scopeMode = "only";
      idx += 1;
      continue;
    }
    if (arg === "--include-existing") {
      includeExisting = true;
      continue;
    }
    if (arg.startsWith("--include-existing=")) {
      const rawValue = String(arg.slice("--include-existing=".length)).trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(rawValue)) includeExisting = true;
      if (["0", "false", "no", "off"].includes(rawValue)) includeExisting = false;
      continue;
    }

    if (!categoryArg && (arg === "prokurime" || arg === "konsultime")) {
      categoryArg = arg;
      continue;
    }
    if (scopeArg === "all") {
      scopeArg = arg;
      scopeMode = "scope";
    }
  }

  const categoryKey = String(categoryArg || "").trim().toLowerCase();
  if (!CATEGORY_CONFIG[categoryKey]) {
    console.error(
      'ERROR: category is required. Use "prokurime" or "konsultime". Example: node scripts/discover_registry_urls.js --category=prokurime'
    );
    process.exit(2);
  }

  const scope = String(scopeArg || "all").trim().toLowerCase();
  if (scope !== "all" && !/^[a-z0-9-]+$/.test(scope)) {
    console.error('ERROR: scope must be "all" or a canonical municipality name_key (a-z0-9-).');
    process.exit(2);
  }

  return {
    categoryKey,
    config: CATEGORY_CONFIG[categoryKey],
    scope,
    scopeKey: scope === "all" ? null : scope,
    scopeMode,
    includeExisting,
  };
}

function findKeywordHits(input, config) {
  const haystack = normalizeText(input);
  if (!haystack) return [];

  const out = [];
  for (const pattern of config.keywordPatterns) {
    pattern.re.lastIndex = 0;
    if (pattern.re.test(haystack)) out.push(pattern.label);
  }
  return out;
}

function scoreCandidate(candidate, config) {
  const text = normalizeText(candidate.text || "");
  const href = normalizeText(candidate.href || "");
  const url = normalizeText(candidate.url || "");
  const all = `${text} ${href} ${url}`.trim();

  let score = 0;
  const hitSet = new Set();
  for (const pattern of config.keywordPatterns) {
    pattern.re.lastIndex = 0;
    const matches = all.match(pattern.re);
    if (!matches) continue;

    hitSet.add(pattern.label);
    const countBoost = Math.min(matches.length, 3);
    score += pattern.points + (countBoost - 1) * 8;
  }

  if (hitSet.size >= 2) score += 20;
  if (hitSet.size >= 3) score += 12;
  if (/transparen|program|publik|njoftime/.test(all)) score += 8;
  if (/\/category\/|\/kategoria\//.test(url)) score += 6;
  if (candidate.method === "homepage_link") score += 8;
  if (candidate.method === "common_path") score += 16;

  return {
    score,
    keyword_hits: Array.from(hitSet.values()),
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

    let html = "";
    try {
      html = await response.text();
    } catch {
      html = "";
    }

    return {
      ok: status === 200,
      status,
      final_url: currentUrl,
      html,
      content_type: response.headers.get("content-type") || "",
      error: status === 200 ? null : `http_${status}`,
    };
  }

  return {
    ok: false,
    status: null,
    final_url: startUrl,
    error: "too_many_redirects",
  };
}

function extractHomepageCandidates(html, pageUrl, baseHost, config) {
  const $ = cheerio.load(html || "");
  const out = [];

  $("a[href]").each((_, a) => {
    const hrefRaw = String($(a).attr("href") || "").trim();
    if (isSkippableHref(hrefRaw)) return;

    let absoluteUrl;
    try {
      absoluteUrl = new URL(hrefRaw, pageUrl).toString();
    } catch {
      return;
    }

    let host;
    try {
      host = new URL(absoluteUrl).hostname;
    } catch {
      return;
    }

    if (!isSameHost(baseHost, host)) return;

    const text = String($(a).text() || "").replace(/\s+/g, " ").trim();
    const keywordHits = findKeywordHits(`${text} ${hrefRaw} ${absoluteUrl}`, config);
    if (keywordHits.length === 0) return;

    out.push({
      method: "homepage_link",
      text,
      href: hrefRaw,
      url: absoluteUrl,
    });
  });

  return out;
}

function buildCommonPathCandidates(baseUrl, baseHost, config) {
  const out = [];
  for (const p of config.commonPaths) {
    let absoluteUrl;
    try {
      absoluteUrl = new URL(p, baseUrl).toString();
    } catch {
      continue;
    }

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
      href: p,
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

function confidenceFromScore(score) {
  if (!Number.isFinite(score) || score <= 0) return 0;
  const scaled = Math.min(0.99, Math.max(0.05, score / 220));
  return Math.round(scaled * 100) / 100;
}

async function validateCandidate(candidate, baseHost, config) {
  const fetched = await fetchHtmlSameHost(candidate.url, baseHost);
  const keywordHitsOnPage = fetched.status === 200 ? findKeywordHits(fetched.html || "", config) : [];
  const scored = scoreCandidate(candidate, config);

  const score = scored.score + (keywordHitsOnPage.length > 0 ? 52 : 0);
  const confidence = confidenceFromScore(score);
  const valid = fetched.status === 200 && keywordHitsOnPage.length > 0;

  return {
    ...candidate,
    final_url: fetched.final_url || candidate.url,
    http_status: fetched.status,
    error: fetched.error || null,
    error_message: fetched.error_message || null,
    score,
    confidence,
    keyword_hits: scored.keyword_hits,
    page_keyword_hits: keywordHitsOnPage,
    valid,
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

async function discoverForMunicipality(row, config) {
  const baseUrl = String(row.base_url || "").trim();
  const startUrl = String(row.start_url || row.base_url || "").trim();
  const existingUrl = String(row[config.columnName] || "").trim();

  const record = {
    municipality_id: row.municipality_id,
    source_registry_id: row.source_registry_id,
    name_key: row.name_key,
    name_sq: row.name_sq,
    base_url: baseUrl || null,
    start_url: startUrl || null,
    existing_url: existingUrl || null,
    confirmed: false,
    selected_url: null,
    recommended_url: null,
    recommended_confidence: null,
    recommended_score: null,
    recommended_method: null,
    candidates: [],
    errors: [],
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
  const validatedHomepage = [];
  if (homepage.ok) {
    const homepageCandidatesRaw = extractHomepageCandidates(
      homepage.html || "",
      homepage.final_url || startUrl,
      baseHost,
      config
    );

    const homepageCandidates = dedupeCandidates(homepageCandidatesRaw)
      .map((candidate) => {
        const scored = scoreCandidate(candidate, config);
        return { ...candidate, score: scored.score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_HOMEPAGE_CANDIDATES);

    for (const candidate of homepageCandidates) {
      validatedHomepage.push(await validateCandidate(candidate, baseHost, config));
    }
  } else {
    record.errors.push(homepage.error || "homepage_fetch_failed");
    if (homepage.status) record.errors.push(`homepage_status_${homepage.status}`);
  }

  const validHomepage = validatedHomepage.filter((c) => c.valid);
  if (validHomepage.length === 0) {
    const commonPathCandidates = dedupeCandidates(buildCommonPathCandidates(startUrl, baseHost, config));
    const validatedPaths = [];
    for (const candidate of commonPathCandidates) {
      validatedPaths.push(await validateCandidate(candidate, baseHost, config));
    }
    record.candidates = validatedPaths.filter((c) => c.valid).sort((a, b) => b.score - a.score);
  } else {
    record.candidates = validHomepage.sort((a, b) => b.score - a.score);
  }

  record.candidates = dedupeCandidates(record.candidates);

  if (record.candidates.length > 0) {
    const best = record.candidates[0];
    record.recommended_url = best.final_url || best.url;
    record.recommended_confidence = best.confidence;
    record.recommended_score = best.score;
    record.recommended_method = best.method;
  } else {
    record.errors.push(`no_${config.outputName}_candidates`);
  }

  return record;
}

function printRankedList(records, config) {
  const ranked = records
    .filter((r) => r.recommended_url)
    .map((r) => ({
      name_key: r.name_key,
      name_sq: r.name_sq,
      url: r.recommended_url,
      confidence: Number(r.recommended_confidence || 0),
      score: Number(r.recommended_score || 0),
      method: r.recommended_method || "-",
    }))
    .sort((a, b) => b.score - a.score);

  console.log("");
  console.log(`Ranked ${config.displayName} URL suggestions`);
  if (ranked.length === 0) {
    console.log("- none");
    return;
  }

  for (let i = 0; i < ranked.length; i += 1) {
    const item = ranked[i];
    console.log(
      `${String(i + 1).padStart(2, " ")}. ${item.name_key} (${item.name_sq}) | score=${item.score} | confidence=${item.confidence} | method=${item.method}`
    );
    console.log(`    ${item.url}`);
  }
}

async function main() {
  const { categoryKey, config, scope, scopeKey, scopeMode, includeExisting } = parseArgs(process.argv);
  const outputPath = path.join(__dirname, "..", "tmp", `registry_discovery_${config.outputName}.json`);
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
        sr.${config.columnName} AS existing_url,
        m.name_key,
        m.name_sq
      FROM source_registry sr
      JOIN municipalities m ON m.id = sr.municipality_id
      WHERE sr.is_primary = TRUE
        AND ($1::text IS NULL OR m.name_key = $1::text)
      ORDER BY m.name_key ASC
    `;

    const { rows } = await pool.query(query, [scopeKey]);
    const includeScopedExisting = Boolean(scopeKey && includeExisting);
    const skippedExisting = [];
    const targets = rows
      .filter((row) => {
        const existingUrl = String(row.existing_url || "").trim();
        const hasExisting = existingUrl.length > 0;
        if (!hasExisting) return true;
        if (includeScopedExisting) return true;
        skippedExisting.push({
          name_key: row.name_key,
          existing_url: existingUrl,
        });
        return false;
      })
      .map((row) => ({
      ...row,
      start_url: String(row.final_url || "").trim() || String(row.base_url || "").trim(),
      [config.columnName]: row.existing_url,
    }));

    console.log(`Category: ${config.displayName}`);
    console.log(
      `Target municipalities: ${targets.length} (scope=${scope}, include_existing=${includeScopedExisting})`
    );
    if (scopeMode === "only" && scopeKey && targets.length === 0 && skippedExisting.length > 0) {
      const skip = skippedExisting[0];
      console.log(
        `Skipped ${scopeKey}: ${config.columnName} already set (${skip.existing_url}). Use --include-existing to force re-discovery.`
      );
    }

    const records = await mapWithConcurrency(targets, CONCURRENCY, (row) =>
      discoverForMunicipality(row, config)
    );

    const recommended = records.filter((r) => r.recommended_url).length;
    const highConfidence = records.filter((r) => Number(r.recommended_confidence || 0) >= 0.7).length;
    const noRecommendation = records.length - recommended;

    const payload = {
      generated_at_utc: new Date().toISOString(),
      category: config.displayName,
      category_key: categoryKey,
      source_registry_column: config.columnName,
      scope,
      include_existing: includeScopedExisting,
      request_timeout_ms: REQUEST_TIMEOUT_MS,
      concurrency: CONCURRENCY,
      notes: [
        "No database writes are performed by this script.",
        "Set confirmed=true per record (and optionally selected_url) before running apply_registry_urls.js.",
      ],
      records,
      stats: {
        total_targets: records.length,
        recommended,
        high_confidence: highConfidence,
        no_recommendation: noRecommendation,
      },
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    printRankedList(records, config);
    console.log("");
    console.log(`Wrote discovery file: ${outputPath}`);
    console.log(
      `Recommended: ${recommended} | High confidence (>=0.70): ${highConfidence} | No recommendation: ${noRecommendation}`
    );
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

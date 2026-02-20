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
const MAX_HOMEPAGE_CANDIDATES = 20;
const MAX_REDIRECTS = 5;
const OUTPUT_PATH = path.join(__dirname, "..", "tmp", "vendime_discovery.json");
const USER_AGENT = "TransparencyRadarBot/1.0 (+https://github.com/dtoska1/Transparency-Radar-Albania)";

const COMMON_PATHS = [
  "/vendime",
  "/vendimet",
  "/vendime-te-keshillit",
  "/vendime-te-keshillit-bashkiak",
  "/vendime-te-keshillit-bashkiak-2",
  "/vendime-keshilli",
  "/vendime-keshillit",
  "/keshilli-bashkiak/vendime",
  "/category/vendime",
  "/kategoria/vendime",
  "/transparenca/vendime",
  "/transparence/vendime",
];

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

function scoreCandidate(candidate) {
  const text = String(candidate.text || "").toLowerCase();
  const href = String(candidate.href || "").toLowerCase();
  const url = String(candidate.url || "").toLowerCase();
  const all = `${text} ${href} ${url}`;

  let score = 0;
  if (/vendime-te-keshillit-bashkiak/.test(all)) score += 140;
  if (/vendime-te-keshillit/.test(all)) score += 120;
  if (/vendime-keshilli|vendime-keshillit/.test(all)) score += 90;
  if (/\/vendime([/?#-]|$)/.test(url)) score += 75;
  if (/category\/vendime|kategoria\/vendime/.test(url)) score += 55;
  if (/vendim/.test(text)) score += 45;
  if (/vendim/.test(href)) score += 50;
  if (/vendim/.test(url)) score += 50;
  if (/keshill/.test(all)) score += 25;
  if (candidate.method === "homepage_link") score += 10;
  if (candidate.method === "common_path") score += 20;
  return score;
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

function extractHomepageCandidates(html, pageUrl, baseHost) {
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
    const haystack = `${text} ${hrefRaw} ${absoluteUrl}`.toLowerCase();
    if (!/vendim/.test(haystack)) return;

    out.push({
      method: "homepage_link",
      text,
      href: hrefRaw,
      url: absoluteUrl,
    });
  });

  return out;
}

function buildCommonPathCandidates(baseUrl, baseHost) {
  const out = [];
  for (const p of COMMON_PATHS) {
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
  for (const c of candidates) {
    const normalized = normalizeUrl(c.final_url || c.url);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ ...c, url: normalized });
  }
  return out;
}

function htmlContainsVendim(html) {
  const text = cheerio
    .load(html || "")
    .text()
    .replace(/\s+/g, " ")
    .toLowerCase();
  return /vendim/.test(text);
}

async function validateCandidate(candidate, baseHost) {
  const fetched = await fetchHtmlSameHost(candidate.url, baseHost);
  const hasVendimText = fetched.status === 200 && htmlContainsVendim(fetched.html || "");
  const validated = {
    ...candidate,
    final_url: fetched.final_url || candidate.url,
    http_status: fetched.status,
    has_vendim_text: hasVendimText,
    error: fetched.error || null,
    error_message: fetched.error_message || null,
  };
  validated.score = scoreCandidate(validated) + (hasVendimText ? 100 : 0);
  validated.valid = fetched.status === 200 && hasVendimText;
  return validated;
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

  const workers = [];
  const workerCount = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < workerCount; i += 1) workers.push(worker());
  await Promise.all(workers);
  return output;
}

async function discoverForMunicipality(row) {
  const baseUrl = String(row.base_url || "").trim();
  const record = {
    municipality_id: row.municipality_id,
    source_registry_id: row.source_registry_id,
    name_key: row.name_key,
    name_sq: row.name_sq,
    base_url: baseUrl,
    confirmed: false,
    selected_vendime_url: null,
    suggested_vendime_url: null,
    suggestion_score: null,
    suggestion_method: null,
    candidates: [],
    errors: [],
  };

  if (!baseUrl) {
    record.errors.push("missing_base_url");
    return record;
  }

  let baseHost;
  try {
    baseHost = new URL(baseUrl).hostname;
  } catch {
    record.errors.push("invalid_base_url");
    return record;
  }

  const homepage = await fetchHtmlSameHost(baseUrl, baseHost);
  const validatedHomepage = [];
  if (homepage.ok) {
    const homepageCandidatesRaw = extractHomepageCandidates(
      homepage.html || "",
      homepage.final_url || baseUrl,
      baseHost
    );
    const homepageCandidates = dedupeCandidates(homepageCandidatesRaw)
      .map((c) => ({ ...c, score: scoreCandidate(c) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_HOMEPAGE_CANDIDATES);

    for (const candidate of homepageCandidates) {
      validatedHomepage.push(await validateCandidate(candidate, baseHost));
    }
  } else {
    record.errors.push(homepage.error || "homepage_fetch_failed");
    if (homepage.status) record.errors.push(`homepage_status_${homepage.status}`);
  }

  const validHomepage = validatedHomepage.filter((c) => c.valid);
  if (validHomepage.length === 0) {
    const commonPathCandidates = dedupeCandidates(buildCommonPathCandidates(baseUrl, baseHost));
    const validatedPaths = [];
    for (const candidate of commonPathCandidates) {
      validatedPaths.push(await validateCandidate(candidate, baseHost));
    }
    record.candidates = validatedPaths.filter((c) => c.valid).sort((a, b) => b.score - a.score);
  } else {
    record.candidates = validHomepage.sort((a, b) => b.score - a.score);
  }

  record.candidates = dedupeCandidates(record.candidates);

  if (record.candidates.length > 0) {
    const best = record.candidates[0];
    record.suggested_vendime_url = best.final_url || best.url;
    record.suggestion_score = best.score;
    record.suggestion_method = best.method;
  } else if (validatedHomepage.some((c) => !c.valid && c.error)) {
    record.errors.push("no_valid_candidates_from_homepage");
  } else {
    record.errors.push("no_vendime_candidates");
  }

  return record;
}

function parseScopeArg() {
  const arg = String(process.argv[2] || "").trim().toLowerCase();
  if (!arg || arg === "all") {
    return { arg: arg || "all", key: null };
  }
  if (!/^[a-z0-9-]+$/.test(arg)) {
    console.error("ERROR: argument must be a canonical name_key (a-z0-9-) or \"all\".");
    process.exit(2);
  }
  return { arg, key: arg };
}

function printRankedList(records) {
  const ranked = records
    .filter((r) => r.suggested_vendime_url)
    .map((r) => ({
      name_key: r.name_key,
      name_sq: r.name_sq,
      url: r.suggested_vendime_url,
      score: r.suggestion_score || 0,
      method: r.suggestion_method || "-",
    }))
    .sort((a, b) => b.score - a.score);

  console.log("");
  console.log("Ranked vendime URL suggestions");
  if (ranked.length === 0) {
    console.log("- none");
    return;
  }

  for (let i = 0; i < ranked.length; i += 1) {
    const item = ranked[i];
    console.log(
      `${String(i + 1).padStart(2, " ")}. ${item.name_key} (${item.name_sq}) | score=${item.score} | method=${item.method}`
    );
    console.log(`    ${item.url}`);
  }
}

async function main() {
  const { arg, key } = parseScopeArg();
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
        m.name_key,
        m.name_sq
      FROM source_registry sr
      JOIN municipalities m ON m.id = sr.municipality_id
      WHERE sr.is_primary = TRUE
        AND (sr.vendime_url IS NULL OR btrim(sr.vendime_url) = '')
        AND ($1::text IS NULL OR m.name_key = $1::text)
      ORDER BY m.name_key ASC
    `;

    const { rows } = await pool.query(query, [key]);
    console.log(`Target municipalities: ${rows.length} (scope=${arg})`);

    const records = await mapWithConcurrency(rows, CONCURRENCY, discoverForMunicipality);
    const suggestedCount = records.filter((r) => r.suggested_vendime_url).length;
    const noSuggestionCount = records.length - suggestedCount;

    const output = {
      generated_at_utc: new Date().toISOString(),
      scope: arg,
      concurrency: CONCURRENCY,
      request_timeout_ms: REQUEST_TIMEOUT_MS,
      notes: [
        "No database writes are performed by this script.",
        "Set confirmed=true per entry (and optionally selected_vendime_url) before running apply_vendime_url.js.",
      ],
      records,
      stats: {
        total_targets: rows.length,
        suggested: suggestedCount,
        no_suggestion: noSuggestionCount,
      },
    };

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");

    printRankedList(records);
    console.log("");
    console.log(`Wrote discovery file: ${OUTPUT_PATH}`);
    console.log(`Suggested: ${suggestedCount} | No suggestion: ${noSuggestionCount}`);
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

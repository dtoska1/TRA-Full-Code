#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const SUPPORTED_CATEGORIES = ["Vendime", "Prokurime", "Konsultime publike"];
const DEFAULTS = {
  category: "Konsultime publike",
  year: new Date().getUTCFullYear(),
  limit: 50,
  batch: 10,
  sleep_ms: 800,
  resume: true,
  stop_on_error: false,
};

const API_BASE = "http://localhost:5050";
const RATE_LIMIT_RETRY_MS = 65000;
const RATE_LIMIT_MAX_RETRIES = 2;

function parseArgs(argv) {
  const out = {};
  const tokens = argv.slice(2);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i] || "");
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    const eqIdx = body.indexOf("=");
    if (eqIdx !== -1) {
      out[body.slice(0, eqIdx)] = body.slice(eqIdx + 1);
      continue;
    }
    const next = tokens[i + 1];
    if (next !== undefined && !String(next).startsWith("--")) {
      out[body] = String(next);
      i += 1;
      continue;
    }
    out[body] = true;
  }
  return out;
}

function toInt(value, fallback) {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

function resolveCategory(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "vendime") return "Vendime";
  if (raw === "prokurime") return "Prokurime";
  if (raw === "konsultime publike" || raw === "konsultime-publike" || raw === "konsultime") {
    return "Konsultime publike";
  }
  return null;
}

function categorySlug(category) {
  return String(category || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeErrorMessage(message) {
  const raw = String(message || "").replace(/[\r\n\t]+/g, " ").trim();
  if (!raw) return "Unknown error";
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <REDACTED>")
    .slice(0, 500);
}

function ensureLocalhostUrl(urlValue) {
  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new Error(`Invalid URL: ${urlValue}`);
  }
  if (parsed.protocol !== "http:") {
    throw new Error("Only http://localhost targets are allowed for batch runner");
  }
  if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("Batch runner is restricted to localhost targets");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function readProgressFile(progressPath) {
  if (!fs.existsSync(progressPath)) {
    return {
      version: 1,
      created_at_utc: nowIso(),
      updated_at_utc: nowIso(),
      last_run: null,
      municipalities: {},
    };
  }

  try {
    const data = JSON.parse(fs.readFileSync(progressPath, "utf8"));
    if (!data || typeof data !== "object") throw new Error("invalid json");
    if (!data.municipalities || typeof data.municipalities !== "object") {
      data.municipalities = {};
    }
    return data;
  } catch {
    return {
      version: 1,
      created_at_utc: nowIso(),
      updated_at_utc: nowIso(),
      last_run: null,
      municipalities: {},
    };
  }
}

function writeProgressFile(progressPath, data) {
  fs.mkdirSync(path.dirname(progressPath), { recursive: true });
  data.updated_at_utc = nowIso();
  fs.writeFileSync(progressPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, message: `Non-JSON response: HTTP ${response.status}` };
  }
  return { response, json };
}

async function postScrapeWithRetries({ targetUrl, adminToken, municipalityKey }) {
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt += 1) {
    const { response, json } = await fetchJson(targetUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
    });

    if (response.status !== 429) {
      return { response, json };
    }

    if (attempt >= RATE_LIMIT_MAX_RETRIES) {
      return { response, json };
    }

    const resetRaw = Number.parseInt(String(response.headers.get("ratelimit-reset") || ""), 10);
    const headerWaitMs = Number.isFinite(resetRaw) && resetRaw > 0 ? resetRaw * 1000 : 0;
    const waitMs = Math.max(RATE_LIMIT_RETRY_MS, headerWaitMs);
    console.log(
      `[WARN] ${municipalityKey} hit scrape rate limit (429). Retrying in ${waitMs}ms (${attempt + 1}/${RATE_LIMIT_MAX_RETRIES + 1})`
    );
    await sleep(waitMs);
  }

  return {
    response: { ok: false, status: 429 },
    json: { ok: false, message: "Too many scrape requests, please try again later." },
  };
}

async function loadMunicipalities(baseUrl) {
  const { response, json } = await fetchJson(`${baseUrl}/api/municipalities`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok || !json?.ok || !Array.isArray(json.items)) {
    throw new Error(
      sanitizeErrorMessage(json?.message || `Failed to load municipalities (HTTP ${response.status})`)
    );
  }
  return json.items;
}

function buildRunUrl(baseUrl, municipalityKey, category, year, limit) {
  const url = new URL(`${baseUrl}/api/scrape/run`);
  url.searchParams.set("municipality", String(municipalityKey));
  url.searchParams.set("category", category);
  url.searchParams.set("year", String(year));
  url.searchParams.set("limit", String(limit));
  return url.toString();
}

function shouldSkipOnResume(previous, category, year, limit) {
  if (!previous) return false;
  if (previous.status !== "ok") return false;
  return (
    String(previous.category) === String(category) &&
    Number(previous.year) === Number(year) &&
    Number(previous.limit) === Number(limit)
  );
}

function classifyRetryLater({ status, json }) {
  const httpStatus = Number(status);
  const errorCode = String(json?.error || "").trim().toLowerCase();
  const message = String(json?.message || "").trim().toLowerCase();
  const lastErrorTypeRaw = String(json?.last_error_type || "").trim().toUpperCase();
  const isCooldown = errorCode === "cooldown" || message.includes("source is in cooldown");
  const isRateLimited =
    httpStatus === 429 ||
    lastErrorTypeRaw === "HTTP_429" ||
    message.includes("too many scrape requests");

  if (!isCooldown && !isRateLimited) return null;

  return {
    reason: isCooldown ? "cooldown" : "rate_limited",
    http_status: Number.isFinite(httpStatus) ? httpStatus : null,
    last_error_type: lastErrorTypeRaw || (isCooldown ? "COOLDOWN" : "HTTP_429"),
    cooldown_until_utc: json?.cooldown_until_utc ? String(json.cooldown_until_utc) : null,
  };
}

async function run() {
  const args = parseArgs(process.argv);
  const category = resolveCategory(args.category || DEFAULTS.category);
  if (!category || !SUPPORTED_CATEGORIES.includes(category)) {
    console.error(`ERROR: --category must be one of: ${SUPPORTED_CATEGORIES.join(", ")}`);
    process.exit(1);
  }

  const year = Math.max(2000, Math.min(2100, toInt(args.year, DEFAULTS.year)));
  const limit = Math.max(1, Math.min(200, toInt(args.limit, DEFAULTS.limit)));
  const batchSize = Math.max(1, toInt(args.batch, DEFAULTS.batch));
  const sleepMs = Math.max(0, toInt(args.sleep_ms, DEFAULTS.sleep_ms));
  const resume = toBool(args.resume, DEFAULTS.resume);
  const stopOnError = toBool(args.stop_on_error, DEFAULTS.stop_on_error);
  const baseUrl = ensureLocalhostUrl(API_BASE);
  const resolvedConfig = {
    category,
    year,
    limit,
    batch: batchSize,
    sleep_ms: sleepMs,
    resume,
    stop_on_error: stopOnError,
    base_url: baseUrl,
  };
  const progressPath = path.join(
    __dirname,
    "..",
    "tmp",
    `run_registry_${categorySlug(category)}_progress.json`
  );

  const adminToken = String(process.env.ADMIN_TOKEN || "").trim();
  if (!adminToken) {
    console.error("ERROR: ADMIN_TOKEN env var is required. Set it in backend/.env before running.");
    process.exit(1);
  }

  const progress = readProgressFile(progressPath);
  progress.last_run = {
    started_at_utc: nowIso(),
    category,
    year,
    limit,
    batch: batchSize,
    sleep_ms: sleepMs,
    resume,
    stop_on_error: stopOnError,
    base_url: baseUrl,
  };
  writeProgressFile(progressPath, progress);

  const municipalities = await loadMunicipalities(baseUrl);
  const total = municipalities.length;
  const totalBatches = Math.ceil(total / batchSize);
  let okCount = 0;
  let errorCount = 0;
  let retryLaterCount = 0;
  let skippedCount = 0;
  let stoppedMunicipality = null;

  console.log("Running registry category ingestion batch");
  console.log(`- Target: ${baseUrl}`);
  console.log(`- resolved_config=${JSON.stringify(resolvedConfig)}`);
  console.log(`- Category: ${category}`);
  console.log(`- Municipalities: ${total}`);
  console.log(`- year=${year} limit=${limit} batch=${batchSize} sleep_ms=${sleepMs}`);
  console.log(`- resume=${resume} stop_on_error=${stopOnError}`);
  console.log(`- progress_file=${progressPath}`);

  for (let i = 0; i < municipalities.length; i += 1) {
    const municipality = municipalities[i];
    const municipalityId = municipality.id;
    const municipalityName = String(municipality.name_sq || municipalityId);
    const municipalityKey = String(municipality.name_key || municipalityId);
    const batchNumber = Math.floor(i / batchSize) + 1;

    if (i % batchSize === 0) {
      console.log(`\nBatch ${batchNumber} / ${totalBatches}`);
    }

    const previous = progress.municipalities[municipalityKey];
    if (resume && shouldSkipOnResume(previous, category, year, limit)) {
      skippedCount += 1;
      console.log(`[SKIP] ${municipalityKey} (already ok for ${category} year=${year}, limit=${limit})`);
      continue;
    }

    const started = Date.now();
    const targetUrl = buildRunUrl(baseUrl, municipalityKey, category, year, limit);

    try {
      const { response, json } = await postScrapeWithRetries({
        targetUrl,
        adminToken,
        municipalityKey,
      });

      if (!response.ok || !json?.ok) {
        const message = sanitizeErrorMessage(json?.message || `HTTP ${response.status}`);
        const retryLater = classifyRetryLater({ status: response.status, json });
        if (retryLater) {
          progress.municipalities[municipalityKey] = {
            municipality_id: municipalityId,
            municipality_name: municipalityName,
            status: "retry_later",
            last_run_utc: nowIso(),
            category,
            year,
            limit,
            parsed_rows_total: Number(json?.parsed_rows_total ?? 0),
            parsed_rows_kept: Number(json?.parsed_rows_kept ?? 0),
            inserted: Number(json?.inserted ?? 0),
            published_updated: Number(json?.published_updated ?? 0),
            skipped_no_municipality_match: Number(json?.skipped_no_municipality_match ?? 0),
            http_status: retryLater.http_status,
            last_error_type: retryLater.last_error_type,
            cooldown_until_utc: retryLater.cooldown_until_utc,
            retry_later_reason: retryLater.reason,
            error_message: message,
          };
          writeProgressFile(progressPath, progress);
          retryLaterCount += 1;
          console.log(
            `[RETRY_LATER] ${municipalityKey} (${response.status}) reason=${retryLater.reason} ${message}`
          );
        } else {
          progress.municipalities[municipalityKey] = {
            municipality_id: municipalityId,
            municipality_name: municipalityName,
            status: "error",
            last_run_utc: nowIso(),
            category,
            year,
            limit,
            parsed_rows_total: Number(json?.parsed_rows_total ?? 0),
            parsed_rows_kept: Number(json?.parsed_rows_kept ?? 0),
            inserted: Number(json?.inserted ?? 0),
            published_updated: Number(json?.published_updated ?? 0),
            skipped_no_municipality_match: Number(json?.skipped_no_municipality_match ?? 0),
            error_message: message,
          };
          writeProgressFile(progressPath, progress);
          errorCount += 1;
          console.log(`[ERROR] ${municipalityKey} (${response.status}) ${message}`);
          if (stopOnError) {
            stoppedMunicipality = municipalityKey;
            break;
          }
        }
      } else {
        const entry = {
          municipality_id: municipalityId,
          municipality_name: municipalityName,
          status: "ok",
          last_run_utc: nowIso(),
          category,
          year,
          limit,
          parsed_rows_total: Number(json.parsed_rows_total ?? 0),
          parsed_rows_kept: Number(json.parsed_rows_kept ?? 0),
          inserted: Number(json.inserted ?? 0),
          published_updated: Number(json.published_updated ?? 0),
          skipped_no_municipality_match: Number(json.skipped_no_municipality_match ?? 0),
          error_message: null,
        };
        progress.municipalities[municipalityKey] = entry;
        writeProgressFile(progressPath, progress);
        okCount += 1;
        console.log(
          `[OK] ${municipalityKey} kept=${entry.parsed_rows_kept} inserted=${entry.inserted} skipped_no_muni=${entry.skipped_no_municipality_match} ms=${Date.now() - started}`
        );
      }
    } catch (err) {
      const message = sanitizeErrorMessage(err?.message || "Request failed");
      progress.municipalities[municipalityKey] = {
        municipality_id: municipalityId,
        municipality_name: municipalityName,
        status: "error",
        last_run_utc: nowIso(),
        category,
        year,
        limit,
        parsed_rows_total: 0,
        parsed_rows_kept: 0,
        inserted: 0,
        published_updated: 0,
        skipped_no_municipality_match: 0,
        error_message: message,
      };
      writeProgressFile(progressPath, progress);
      errorCount += 1;
      console.log(`[ERROR] ${municipalityKey} ${message}`);
      if (stopOnError) {
        stoppedMunicipality = municipalityKey;
        break;
      }
    }

    if (sleepMs > 0 && i < municipalities.length - 1) {
      await sleep(sleepMs);
    }
  }

  progress.last_run.finished_at_utc = nowIso();
  progress.last_run.summary = {
    ok: okCount,
    error: errorCount,
    retry_later: retryLaterCount,
    skipped: skippedCount,
    total,
    stopped_on: stoppedMunicipality,
  };
  writeProgressFile(progressPath, progress);

  console.log("");
  console.log("Run completed.");
  console.log(`- ok=${okCount}`);
  console.log(`- error=${errorCount}`);
  console.log(`- retry_later=${retryLaterCount}`);
  console.log(`- skipped=${skippedCount}`);
  if (stoppedMunicipality) {
    console.log(`- stopped_on=${stoppedMunicipality}`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Batch run failed:", sanitizeErrorMessage(err?.message || err));
  process.exit(1);
});

#!/usr/bin/env node
"use strict";

const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const {
  loadProgress,
  saveProgress,
  shouldSleep,
  backoffOn429,
} = require("../lib/runnerProgress");
const {
  appendFailedOffset,
  buildFailureInfo,
  isSkippableScrapeFailure,
  normalizeFailedOffsets,
  sanitizeMessage,
} = require("../lib/runnerFailure");

const API_BASE = process.env.API_BASE || process.env.SMOKE_BASE_URL || "http://localhost:5050";

function parseArgs(argv) {
  const out = {};
  for (const token of argv.slice(2)) {
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    const eqIdx = body.indexOf("=");
    if (eqIdx === -1) out[body] = true;
    else out[body.slice(0, eqIdx)] = body.slice(eqIdx + 1);
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

function nowIso() {
  return new Date().toISOString();
}

function hasArg(args, key) {
  return Object.prototype.hasOwnProperty.call(args, key);
}

function normalizeProgress(existing, year) {
  const nextOffset = existing.next_offset === null
    ? null
    : Math.max(0, toInt(existing.next_offset, toInt(existing.last_offset, 0)));
  const lastError =
    existing.last_error && typeof existing.last_error === "object"
      ? {
          type: String(existing.last_error.type || "").trim() || "UNKNOWN",
          message: sanitizeMessage(existing.last_error.message || ""),
          at_utc: String(existing.last_error.at_utc || nowIso()),
        }
      : null;

  return {
    year,
    mode: "nationwide",
    next_offset: nextOffset,
    total_seen: Math.max(0, toInt(existing.total_seen, toInt(existing.parsed_rows_total_sum, 0))),
    total_inserted: Math.max(0, toInt(existing.total_inserted, 0)),
    total_skipped: Math.max(0, toInt(existing.total_skipped, 0)),
    failed_offsets: normalizeFailedOffsets(existing.failed_offsets),
    last_ok_utc: existing.last_ok_utc || existing.updatedAt || null,
    last_error: lastError,
  };
}

async function run() {
  const args = parseArgs(process.argv);
  const year = Math.max(2000, Math.min(2100, toInt(args.year, new Date().getUTCFullYear())));
  const limit = Math.max(1, Math.min(200, toInt(args.limit, 80)));
  const sleepMs = Math.max(0, toInt(args.sleep_ms, 1200));
  const maxTimeouts = Math.max(1, toInt(args.max_timeouts, 10));
  const maxRuntimeMs = Math.max(0, toInt(args.max_runtime_ms, 0));
  const resume = toBool(args.resume, true);
  const forcePublish = toBool(args.force_publish, false);
  const pageStart = Math.max(1, toInt(args.page_start, 1));
  const hasOffset = hasArg(args, "offset");
  const hasStartOffset = hasArg(args, "start_offset");
  const hasExplicitOffset = hasOffset || hasStartOffset;
  const explicitOffset = Math.max(0, toInt(hasOffset ? args.offset : args.start_offset, 0));
  const adminToken = String(process.env.ADMIN_TOKEN || "").trim();

  if (!adminToken) {
    console.error("ERROR: ADMIN_TOKEN env var is required. Set it in backend/.env before running.");
    process.exit(1);
  }

  const progressPath = path.join(__dirname, "..", "tmp", `vendime_progress_${year}.json`);
  const defaults = {
    year,
    mode: "nationwide",
    next_offset: 0,
    total_seen: 0,
    total_inserted: 0,
    total_skipped: 0,
    failed_offsets: [],
    last_ok_utc: null,
    last_error: null,
  };
  const loadedProgress = loadProgress(progressPath, defaults);
  let progress = normalizeProgress(loadedProgress, year);
  const startedAtMs = Date.now();

  let offset = 0;
  if (hasExplicitOffset) {
    offset = explicitOffset;
    progress = { ...defaults, year, mode: "nationwide", next_offset: offset };
  } else if (resume) {
    if (progress.next_offset === null) {
      console.log(`year=${year} already complete (next_offset=null) progress_file=${progressPath}`);
      return;
    }
    offset = Math.max(0, toInt(progress.next_offset, 0));
  }

  if (!resume && !hasExplicitOffset) {
    progress = { ...defaults, year, mode: "nationwide", next_offset: 0 };
    offset = 0;
  }

  if (progress.next_offset === null && !hasExplicitOffset && resume) {
    console.log(`year=${year} already complete (next_offset=null) progress_file=${progressPath}`);
    return;
  }

  let retryAttempt = 0;
  let runFailedOffsets = 0;

  function recordFailedOffsetSkip({ response, payload, message }) {
    const failure = buildFailureInfo({
      statusCode: response?.status,
      payload,
      fallbackMessage: message,
    });
    const failedAt = nowIso();
    const nextOffset = offset + 1;

    progress.next_offset = nextOffset;
    progress.last_error = {
      type: failure.type,
      message: failure.message,
      at_utc: failedAt,
    };
    appendFailedOffset(progress, {
      year,
      category: "Vendime",
      offset,
      next_offset: nextOffset,
      limit,
      municipality_id: failure.municipality_id,
      municipality: failure.municipality,
      status: failure.status,
      type: failure.type,
      message: failure.message,
      at_utc: failedAt,
    });
    saveProgress(progressPath, progress);

    runFailedOffsets += 1;
    console.warn(
      `year=${year} offset=${offset} limit=${limit} page_start=${pageStart} failed_offset_skip=true municipality_id=${failure.municipality_id || "unknown"} municipality=${failure.municipality || "unknown"} status=${failure.status || "unknown"} type=${failure.type} run_timeouts=${runFailedOffsets}/${maxTimeouts} next_offset=${nextOffset}`
    );

    offset = nextOffset;
    retryAttempt = 0;
    if (runFailedOffsets >= maxTimeouts) {
      console.warn(
        `year=${year} max_timeouts_reached=true run_timeouts=${runFailedOffsets} max_timeouts=${maxTimeouts} next_offset=${nextOffset} progress_file=${progressPath}`
      );
      return true;
    }
    return false;
  }

  while (true) {
    if (maxRuntimeMs > 0 && Date.now() - startedAtMs >= maxRuntimeMs) {
      progress.next_offset = offset;
      saveProgress(progressPath, progress);
      console.log(
        `year=${year} runtime_limit_reached=true max_runtime_ms=${maxRuntimeMs} next_offset=${offset} progress_file=${progressPath}`
      );
      return;
    }

    const url = new URL(`${API_BASE}/api/scrape/run`);
    url.searchParams.set("category", "Vendime");
    url.searchParams.set("year", String(year));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("page_start", String(pageStart));
    if (forcePublish) url.searchParams.set("force_publish", "true");

    let response;
    try {
      response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
      });
    } catch (err) {
      progress.next_offset = offset;
      progress.last_error = {
        type: String(err?.code || "FETCH_ERROR").toUpperCase(),
        message: sanitizeMessage(err?.message || "Request failed"),
        at_utc: nowIso(),
      };
      saveProgress(progressPath, progress);
      throw err;
    }

    if (response.status === 429) {
      const delayMs = backoffOn429({
        attempt: retryAttempt,
        baseMs: 10_000,
        maxMs: 60_000,
      });
      retryAttempt += 1;
      console.warn(
        `year=${year} offset=${offset} limit=${limit} page_start=${pageStart} status=429 backoff_ms=${delayMs} retrying=true`
      );
      await shouldSleep(delayMs);
      continue;
    }

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      const message = "Non-JSON response";
      if (
        isSkippableScrapeFailure({
          statusCode: response.status,
          payload: null,
          message,
        })
      ) {
        if (recordFailedOffsetSkip({ response, payload: null, message })) return;
        continue;
      }
      progress.next_offset = offset;
      progress.last_error = {
        type: `HTTP_${response.status}`,
        message,
        at_utc: nowIso(),
      };
      saveProgress(progressPath, progress);
      throw new Error(`HTTP ${response.status}: ${message}`);
    }

    if (!response.ok || !payload?.ok) {
      const message = sanitizeMessage(payload?.message || payload?.error || "Request failed");
      if (
        isSkippableScrapeFailure({
          statusCode: response.status,
          payload,
          message,
        })
      ) {
        if (recordFailedOffsetSkip({ response, payload, message })) return;
        continue;
      }
      progress.next_offset = offset;
      progress.last_error = {
        type: `HTTP_${response.status}`,
        message,
        at_utc: nowIso(),
      };
      saveProgress(progressPath, progress);
      throw new Error(`HTTP ${response.status}: ${message}`);
    }
    retryAttempt = 0;

    const seen = Math.max(0, toInt(payload.parsed_rows_total, 0));
    const inserted = Math.max(0, toInt(payload.inserted, 0));
    const skipped = Math.max(0, toInt(payload.skipped, Math.max(0, seen - inserted)));
    const skippedMissingDate = Math.max(0, toInt(payload.skipped_missing_date, 0));
    const skippedWrongYear = Math.max(0, toInt(payload.skipped_wrong_year, 0));
    const nextOffset = payload.next_offset === null ? null : Math.max(0, toInt(payload.next_offset, 0));

    progress.total_seen += seen;
    progress.total_inserted += inserted;
    progress.total_skipped += skipped;
    progress.next_offset = nextOffset;
    progress.last_ok_utc = nowIso();
    progress.last_error = null;
    saveProgress(progressPath, progress);

    console.log(
      `year=${year} offset=${offset} limit=${limit} page_start=${pageStart} seen=${seen} inserted=${inserted} skipped=${skipped} skipped_missing_date=${skippedMissingDate} skipped_wrong_year=${skippedWrongYear} total_seen=${progress.total_seen} total_inserted=${progress.total_inserted} total_skipped=${progress.total_skipped} next_offset=${nextOffset === null ? "null" : nextOffset}`
    );

    if (nextOffset === null) break;
    offset = nextOffset;
    await shouldSleep(sleepMs);
  }
}

run().catch((error) => {
  console.error(`ERROR: ${sanitizeMessage(error?.message || error)}`);
  process.exit(1);
});

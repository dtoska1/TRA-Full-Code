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

const API_BASE = process.env.API_BASE || process.env.SMOKE_BASE_URL || "http://localhost:5050";
const TIMEOUT_RETRY_BACKOFF_MS = [5000, 15000, 45000];
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const TIMEOUT_NETWORK_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"]);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = String(argv[i] || "").trim();
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    const eqIdx = body.indexOf("=");
    if (eqIdx === -1) {
      const key = body;
      const nextToken = String(argv[i + 1] || "").trim();
      if (nextToken && !nextToken.startsWith("--")) {
        out[key] = nextToken;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out[body.slice(0, eqIdx)] = body.slice(eqIdx + 1);
    }
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

function sanitizeMessage(message) {
  const raw = String(message || "").replace(/[\r\n\t]+/g, " ").trim();
  return raw.slice(0, 400);
}

function normalizeCountsByMunicipality(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, rawCount] of Object.entries(value)) {
    const municipalityId = String(key || "").trim();
    if (!municipalityId) continue;
    out[municipalityId] = Math.max(0, toInt(rawCount, 0));
  }
  return out;
}

function extractMunicipalityIdFromText(...inputs) {
  for (const input of inputs) {
    const text = String(input || "");
    if (!text) continue;
    const match = text.match(UUID_RE);
    if (match && match[0]) return String(match[0]).toLowerCase();
  }
  return null;
}

function isTimeoutLikeError({ statusCode, errorCode, message, scrapeError, lastErrorType }) {
  const status = Number(statusCode);
  if (status === 504) return true;

  const code = String(errorCode || "").trim().toUpperCase();
  if (TIMEOUT_NETWORK_CODES.has(code)) return true;

  const type = String(lastErrorType || "").trim().toUpperCase();
  if (type === "TIMEOUT" || type === "HTTP_504") return true;

  const haystack = `${String(message || "")} ${String(scrapeError || "")}`.toLowerCase();
  return haystack.includes("timeout");
}

function isBlockedLikeError({ statusCode, errorCode, message, scrapeError, lastErrorType }) {
  const status = Number(statusCode);
  if (status === 403) return true;

  const code = String(errorCode || "").trim().toUpperCase();
  if (code === "HTTP_403") return true;

  const type = String(lastErrorType || "").trim().toUpperCase();
  if (type === "HTTP_403") return true;

  const haystack = `${String(message || "")} ${String(scrapeError || "")}`.toUpperCase();
  return haystack.includes("HTTP_403");
}

function normalizeProgress(existing, year) {
  const nextOffset =
    existing.next_offset === null
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
    timeouts_total: Math.max(0, toInt(existing.timeouts_total, 0)),
    timeouts_by_municipality: normalizeCountsByMunicipality(existing.timeouts_by_municipality),
    last_timeout_municipality_id:
      String(existing.last_timeout_municipality_id || "").trim() || null,
    last_timeout_at_utc: String(existing.last_timeout_at_utc || "").trim() || null,
    blocked_total: Math.max(0, toInt(existing.blocked_total, 0)),
    blocked_by_municipality: normalizeCountsByMunicipality(existing.blocked_by_municipality),
    last_blocked_municipality_id:
      String(existing.last_blocked_municipality_id || "").trim() || null,
    last_blocked_at_utc: String(existing.last_blocked_at_utc || "").trim() || null,
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
  const hasOffset = hasArg(args, "offset");
  const hasStartOffset = hasArg(args, "start_offset");
  const hasExplicitOffset = hasOffset || hasStartOffset;
  const explicitOffset = Math.max(0, toInt(hasOffset ? args.offset : args.start_offset, 0));
  const adminToken = String(process.env.ADMIN_TOKEN || "").trim();

  if (!adminToken) {
    throw new Error("ADMIN_TOKEN env var is required. Set it in backend/.env before running.");
  }

  const progressPath = path.join(__dirname, "..", "tmp", `konsultime_progress_${year}.json`);
  const defaults = {
    year,
    mode: "nationwide",
    next_offset: 0,
    total_seen: 0,
    total_inserted: 0,
    total_skipped: 0,
    timeouts_total: 0,
    timeouts_by_municipality: {},
    last_timeout_municipality_id: null,
    last_timeout_at_utc: null,
    blocked_total: 0,
    blocked_by_municipality: {},
    last_blocked_municipality_id: null,
    last_blocked_at_utc: null,
    last_ok_utc: null,
    last_error: null,
  };
  const loadedProgress = loadProgress(progressPath, defaults);
  let progress = normalizeProgress(loadedProgress, year);
  if (Number(progress.year) !== Number(year)) {
    console.warn(
      `WARN: progress year mismatch (file has ${progress.year}, cli has ${year}); overriding to cli year`
    );
    progress.year = year;
  }
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
  let runTimeouts = 0;
  let stopReason = "completed";

  function printFinalSummary(reason) {
    console.log(
      `summary year=${year} reason=${reason} total_seen=${progress.total_seen} total_inserted=${progress.total_inserted} total_skipped=${progress.total_skipped} timeouts_total=${progress.timeouts_total} blocked_total=${progress.blocked_total} next_offset=${progress.next_offset === null ? "null" : progress.next_offset} progress_file=${progressPath}`
    );
  }

  function recordBlockedSoftSkip({ municipalityId, reasonType, reasonMessage }) {
    const blockedMunicipalityId = municipalityId || "unknown";
    const blockedAt = nowIso();
    const forcedNextOffset = offset + 1;

    progress.blocked_total += 1;
    progress.blocked_by_municipality[blockedMunicipalityId] =
      Math.max(0, toInt(progress.blocked_by_municipality[blockedMunicipalityId], 0)) + 1;
    progress.last_blocked_municipality_id = blockedMunicipalityId;
    progress.last_blocked_at_utc = blockedAt;
    progress.next_offset = forcedNextOffset;
    progress.last_error = {
      type: "HTTP_403",
      message: sanitizeMessage(
        `${String(reasonType || "HTTP_403").trim() || "HTTP_403"} soft-skip at offset=${offset} municipality_id=${blockedMunicipalityId} ${String(reasonMessage || "").trim()}`
      ),
      at_utc: blockedAt,
    };
    saveProgress(progressPath, progress);

    offset = forcedNextOffset;
    retryAttempt = 0;
    console.warn(
      `year=${year} offset=${offset - 1} limit=${limit} blocked_skip=true municipality_id=${blockedMunicipalityId} blocked_total=${progress.blocked_total} next_offset=${forcedNextOffset}`
    );
  }

  while (true) {
    if (maxRuntimeMs > 0 && Date.now() - startedAtMs >= maxRuntimeMs) {
      progress.next_offset = offset;
      saveProgress(progressPath, progress);
      console.log(
        `year=${year} runtime_limit_reached=true max_runtime_ms=${maxRuntimeMs} next_offset=${offset} progress_file=${progressPath}`
      );
      stopReason = "runtime_limit_reached";
      break;
    }

    const url = new URL(`${API_BASE}/api/scrape/run`);
    url.searchParams.set("category", "Konsultime publike");
    url.searchParams.set("year", String(year));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(limit));

    let shouldContinueOuterLoop = false;
    let successfulPayload = null;

    for (let timeoutAttempt = 0; timeoutAttempt <= TIMEOUT_RETRY_BACKOFF_MS.length; timeoutAttempt += 1) {
      let response = null;
      let payload = null;
      let text = "";
      let statusCode = null;
      let errorCode = "";
      let message = "";
      let scrapeError = "";
      let lastErrorType = "";
      let municipalityIdFromError = null;

      try {
        response = await fetch(url.toString(), {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
        });
      } catch (err) {
        statusCode = null;
        errorCode = String(err?.code || "").trim().toUpperCase();
        message = sanitizeMessage(err?.message || "Request failed");
        scrapeError = sanitizeMessage(err?.scrape_error || "");
        lastErrorType = String(err?.last_error_type || "").trim().toUpperCase();
        municipalityIdFromError = extractMunicipalityIdFromText(
          err?.message,
          err?.scrape_error,
          err?.timeout_label
        );

        const timeoutLike = isTimeoutLikeError({
          statusCode,
          errorCode,
          message,
          scrapeError,
          lastErrorType,
        });
        const blockedLike = isBlockedLikeError({
          statusCode,
          errorCode,
          message,
          scrapeError,
          lastErrorType,
        });

        if (blockedLike) {
          recordBlockedSoftSkip({
            municipalityId: municipalityIdFromError || "unknown",
            reasonType: errorCode || lastErrorType || "HTTP_403",
            reasonMessage: message || scrapeError || "Blocked by bot/Cloudflare protection",
          });
          shouldContinueOuterLoop = true;
          break;
        }

        if (timeoutLike && timeoutAttempt < TIMEOUT_RETRY_BACKOFF_MS.length) {
          const backoffMs = TIMEOUT_RETRY_BACKOFF_MS[timeoutAttempt];
          console.warn(
            `year=${year} offset=${offset} limit=${limit} timeout_retry_attempt=${timeoutAttempt + 1}/${TIMEOUT_RETRY_BACKOFF_MS.length} backoff_ms=${backoffMs}`
          );
          await shouldSleep(backoffMs);
          continue;
        }

        if (timeoutLike) {
          const municipalityId = municipalityIdFromError || "unknown";
          const timeoutAt = nowIso();
          const forcedNextOffset = offset + 1;

          progress.timeouts_total += 1;
          progress.timeouts_by_municipality[municipalityId] =
            Math.max(0, toInt(progress.timeouts_by_municipality[municipalityId], 0)) + 1;
          progress.last_timeout_municipality_id = municipalityId;
          progress.last_timeout_at_utc = timeoutAt;
          progress.next_offset = forcedNextOffset;
          progress.last_error = {
            type: "TIMEOUT",
            message: sanitizeMessage(
              `Timeout after retries at offset=${offset} municipality_id=${municipalityId}`
            ),
            at_utc: timeoutAt,
          };
          saveProgress(progressPath, progress);

          runTimeouts += 1;
          offset = forcedNextOffset;
          retryAttempt = 0;
          console.warn(
            `year=${year} offset=${offset - 1} limit=${limit} timeout_skip=true municipality_id=${municipalityId} run_timeouts=${runTimeouts}/${maxTimeouts} next_offset=${forcedNextOffset}`
          );

          if (runTimeouts >= maxTimeouts) {
            console.warn(
              `year=${year} max_timeouts_reached=true run_timeouts=${runTimeouts} max_timeouts=${maxTimeouts} next_offset=${forcedNextOffset} progress_file=${progressPath}`
            );
            stopReason = "max_timeouts_reached";
            printFinalSummary(stopReason);
            return;
          }

          shouldContinueOuterLoop = true;
          break;
        }

        progress.next_offset = offset;
        progress.last_error = {
          type: errorCode || "FETCH_ERROR",
          message,
          at_utc: nowIso(),
        };
        saveProgress(progressPath, progress);
        throw err;
      }

      statusCode = Number(response.status || 0);

      if (statusCode === 429) {
        const delayMs = backoffOn429({
          attempt: retryAttempt,
          baseMs: 10_000,
          maxMs: 60_000,
        });
        retryAttempt += 1;
        console.warn(
          `year=${year} offset=${offset} limit=${limit} status=429 backoff_ms=${delayMs} retrying=true`
        );
        await shouldSleep(delayMs);
        shouldContinueOuterLoop = true;
        break;
      }

      try {
        text = await response.text();
      } catch {
        text = "";
      }

      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }

      if (!payload) {
        message = sanitizeMessage(`HTTP ${statusCode}: Non-JSON response`);
        scrapeError = "";
        lastErrorType = "";
        municipalityIdFromError = extractMunicipalityIdFromText(text, message);
      } else {
        message = sanitizeMessage(payload?.message || payload?.error || `HTTP ${statusCode}: Request failed`);
        scrapeError = sanitizeMessage(payload?.scrape_error || "");
        lastErrorType = String(payload?.last_error_type || "").trim().toUpperCase();
        errorCode = String(payload?.cause || "").trim().toUpperCase();
        municipalityIdFromError = extractMunicipalityIdFromText(
          payload?.message,
          payload?.scrape_error,
          payload?.last_error_type
        );
      }

      const requestFailed = !response.ok || !payload?.ok;
      if (requestFailed) {
        const timeoutLike = isTimeoutLikeError({
          statusCode,
          errorCode,
          message,
          scrapeError,
          lastErrorType,
        });
        const blockedLike = isBlockedLikeError({
          statusCode,
          errorCode,
          message,
          scrapeError,
          lastErrorType,
        });

        if (blockedLike) {
          recordBlockedSoftSkip({
            municipalityId: municipalityIdFromError || "unknown",
            reasonType: lastErrorType || `HTTP_${statusCode}`,
            reasonMessage: message || scrapeError || "Blocked by bot/Cloudflare protection",
          });
          shouldContinueOuterLoop = true;
          break;
        }

        if (timeoutLike && timeoutAttempt < TIMEOUT_RETRY_BACKOFF_MS.length) {
          const backoffMs = TIMEOUT_RETRY_BACKOFF_MS[timeoutAttempt];
          console.warn(
            `year=${year} offset=${offset} limit=${limit} timeout_retry_attempt=${timeoutAttempt + 1}/${TIMEOUT_RETRY_BACKOFF_MS.length} backoff_ms=${backoffMs}`
          );
          await shouldSleep(backoffMs);
          continue;
        }

        if (timeoutLike) {
          const municipalityId = municipalityIdFromError || "unknown";
          const timeoutAt = nowIso();
          const forcedNextOffset = offset + 1;

          progress.timeouts_total += 1;
          progress.timeouts_by_municipality[municipalityId] =
            Math.max(0, toInt(progress.timeouts_by_municipality[municipalityId], 0)) + 1;
          progress.last_timeout_municipality_id = municipalityId;
          progress.last_timeout_at_utc = timeoutAt;
          progress.next_offset = forcedNextOffset;
          progress.last_error = {
            type: "TIMEOUT",
            message: sanitizeMessage(
              `Timeout after retries at offset=${offset} municipality_id=${municipalityId}`
            ),
            at_utc: timeoutAt,
          };
          saveProgress(progressPath, progress);

          runTimeouts += 1;
          offset = forcedNextOffset;
          retryAttempt = 0;
          console.warn(
            `year=${year} offset=${offset - 1} limit=${limit} timeout_skip=true municipality_id=${municipalityId} run_timeouts=${runTimeouts}/${maxTimeouts} next_offset=${forcedNextOffset}`
          );

          if (runTimeouts >= maxTimeouts) {
            console.warn(
              `year=${year} max_timeouts_reached=true run_timeouts=${runTimeouts} max_timeouts=${maxTimeouts} next_offset=${forcedNextOffset} progress_file=${progressPath}`
            );
            stopReason = "max_timeouts_reached";
            printFinalSummary(stopReason);
            return;
          }

          shouldContinueOuterLoop = true;
          break;
        }

        progress.next_offset = offset;
        progress.last_error = {
          type: `HTTP_${statusCode}`,
          message,
          at_utc: nowIso(),
        };
        saveProgress(progressPath, progress);
        throw new Error(`HTTP ${statusCode}: ${message}`);
      }

      successfulPayload = payload;
      retryAttempt = 0;
      break;
    }

    if (shouldContinueOuterLoop) continue;
    if (!successfulPayload) {
      progress.next_offset = offset;
      progress.last_error = {
        type: "UNKNOWN_ERROR",
        message: "No successful payload and no retry directive.",
        at_utc: nowIso(),
      };
      saveProgress(progressPath, progress);
      throw new Error("No successful payload and no retry directive.");
    }

    const seen = Math.max(0, toInt(successfulPayload.parsed_rows_total, 0));
    const inserted = Math.max(0, toInt(successfulPayload.inserted, 0));
    const updated = Math.max(0, toInt(successfulPayload.updated, 0));
    const skipped = Math.max(0, toInt(successfulPayload.skipped, Math.max(0, seen - inserted - updated)));
    const skippedMissingDate = Math.max(0, toInt(successfulPayload.skipped_missing_date, 0));
    const skippedWrongYear = Math.max(0, toInt(successfulPayload.skipped_wrong_year, 0));
    const nextOffset =
      successfulPayload.next_offset === null
        ? null
        : Math.max(0, toInt(successfulPayload.next_offset, 0));

    progress.total_seen += seen;
    progress.total_inserted += inserted;
    progress.total_skipped += skipped;
    progress.next_offset = nextOffset;
    progress.last_ok_utc = nowIso();
    progress.last_error = null;
    saveProgress(progressPath, progress);

    console.log(
      `year=${year} offset=${offset} limit=${limit} seen=${seen} inserted=${inserted} updated=${updated} skipped=${skipped} skipped_missing_date=${skippedMissingDate} skipped_wrong_year=${skippedWrongYear} total_seen=${progress.total_seen} total_inserted=${progress.total_inserted} total_skipped=${progress.total_skipped} timeouts_total=${progress.timeouts_total} blocked_total=${progress.blocked_total} next_offset=${nextOffset === null ? "null" : nextOffset}`
    );

    if (nextOffset === null) {
      stopReason = "completed";
      break;
    }
    offset = nextOffset;
    await shouldSleep(sleepMs);
  }

  printFinalSummary(stopReason);
}

run().catch((error) => {
  console.error(`ERROR: ${sanitizeMessage(error?.message || error)}`);
  process.exitCode = 1;
});

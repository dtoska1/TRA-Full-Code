"use strict";

const TIMEOUT_NETWORK_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"]);

function toInt(value, fallback) {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeMessage(message) {
  const raw = String(message || "").replace(/[\r\n\t]+/g, " ").trim();
  return raw.slice(0, 400);
}

function normalizeFailedOffsets(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({
      year: toInt(entry.year, null),
      category: String(entry.category || "").trim() || null,
      offset: Math.max(0, toInt(entry.offset, 0)),
      next_offset:
        entry.next_offset === null ? null : Math.max(0, toInt(entry.next_offset, 0)),
      limit: Math.max(0, toInt(entry.limit, 0)),
      municipality_id: String(entry.municipality_id || "").trim() || null,
      municipality: String(entry.municipality || "").trim() || null,
      status: entry.status === null ? null : toInt(entry.status, null),
      type: String(entry.type || "").trim() || "UNKNOWN",
      message: sanitizeMessage(entry.message || ""),
      at_utc: String(entry.at_utc || "").trim() || nowIso(),
    }));
}

function buildFailureInfo({ statusCode, payload, fallbackMessage }) {
  const status = Number(statusCode);
  const lastErrorType = String(payload?.last_error_type || "").trim().toUpperCase();
  const cause = String(payload?.cause || "").trim().toUpperCase();
  const type = lastErrorType || cause || (Number.isFinite(status) ? `HTTP_${status}` : "FETCH_ERROR");
  const message = sanitizeMessage(
    payload?.message ||
      payload?.scrape_error ||
      payload?.error ||
      fallbackMessage ||
      "Request failed"
  );

  return {
    status: Number.isFinite(status) ? status : null,
    type,
    message,
    municipality_id: String(payload?.municipality_id || "").trim() || null,
    municipality: String(payload?.municipality || "").trim() || null,
  };
}

function isTimeoutLikeFailure({ statusCode, type, message, scrapeError, errorCode }) {
  const status = Number(statusCode);
  if (status === 504) return true;

  const normalizedType = String(type || "").trim().toUpperCase();
  if (normalizedType === "TIMEOUT" || normalizedType === "HTTP_504") return true;

  const normalizedCode = String(errorCode || "").trim().toUpperCase();
  if (TIMEOUT_NETWORK_CODES.has(normalizedCode)) return true;

  const haystack = `${String(message || "")} ${String(scrapeError || "")}`.toLowerCase();
  return haystack.includes("timeout");
}

function isBlockedLikeFailure({ statusCode, type, message, scrapeError, errorCode }) {
  const status = Number(statusCode);
  if (status === 403) return true;

  const normalizedType = String(type || "").trim().toUpperCase();
  const normalizedCode = String(errorCode || "").trim().toUpperCase();
  if (normalizedType === "HTTP_403" || normalizedCode === "HTTP_403") return true;

  const haystack = `${String(message || "")} ${String(scrapeError || "")}`.toUpperCase();
  return haystack.includes("HTTP_403");
}

function isSkippableScrapeFailure({ statusCode, payload, message, errorCode }) {
  const status = Number(statusCode);
  const statusKnown = Number.isFinite(status) && status > 0;
  if ([400, 401, 429].includes(status)) return false;
  if (status === 503 && String(payload?.error || "").trim() === "server_misconfigured") {
    return false;
  }
  if (!statusKnown) return false;

  const type = String(payload?.last_error_type || payload?.cause || errorCode || "").trim().toUpperCase();
  const scrapeError = sanitizeMessage(payload?.scrape_error || "");
  const errorMessage = sanitizeMessage(
    message || payload?.message || payload?.error || scrapeError || `HTTP ${status}`
  );

  if (isTimeoutLikeFailure({ statusCode: status, type, message: errorMessage, scrapeError, errorCode })) {
    return true;
  }
  if (isBlockedLikeFailure({ statusCode: status, type, message: errorMessage, scrapeError, errorCode })) {
    return true;
  }
  if (status >= 500 && status <= 599) return true;
  return false;
}

function appendFailedOffset(progress, entry) {
  const failedOffsets = normalizeFailedOffsets(progress.failed_offsets);
  failedOffsets.push({
    year: toInt(entry.year, null),
    category: String(entry.category || "").trim() || null,
    offset: Math.max(0, toInt(entry.offset, 0)),
    next_offset:
      entry.next_offset === null ? null : Math.max(0, toInt(entry.next_offset, 0)),
    limit: Math.max(0, toInt(entry.limit, 0)),
    municipality_id: String(entry.municipality_id || "").trim() || null,
    municipality: String(entry.municipality || "").trim() || null,
    status: entry.status === null ? null : toInt(entry.status, null),
    type: String(entry.type || "").trim() || "UNKNOWN",
    message: sanitizeMessage(entry.message || ""),
    at_utc: String(entry.at_utc || "").trim() || nowIso(),
  });
  progress.failed_offsets = failedOffsets;
  return failedOffsets[failedOffsets.length - 1];
}

module.exports = {
  appendFailedOffset,
  buildFailureInfo,
  isBlockedLikeFailure,
  isSkippableScrapeFailure,
  isTimeoutLikeFailure,
  normalizeFailedOffsets,
  sanitizeMessage,
};

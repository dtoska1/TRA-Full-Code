"use strict";

const DOWN_ERROR_TYPES = new Set([
  "UPSTREAM_DOWN",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function normalizeUpper(value) {
  return String(value || "").trim().toUpperCase();
}

function isMissingVendimeUrl(value) {
  return !String(value || "").trim();
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function classifyVendimeStatus(row) {
  const homepageStatus = normalizeUpper(row.homepage_status);
  const lastErrorType = normalizeUpper(row.last_error_type);

  if (homepageStatus === "BLOCKED" || lastErrorType === "HTTP_403") return "BLOCKED";
  if (homepageStatus === "ERROR" || lastErrorType === "TIMEOUT") return "ERROR";
  if (homepageStatus === "DOWN" || DOWN_ERROR_TYPES.has(lastErrorType)) return "DOWN";
  if (isMissingVendimeUrl(row.vendime_url)) return "UNKNOWN";
  return "OK";
}

function sortByNameKey(items) {
  return items.sort((a, b) => String(a.name_key).localeCompare(String(b.name_key)));
}

function summarizeVendimeStatusRows(rows, generatedAtUtc = new Date().toISOString()) {
  const counts = { OK: 0, BLOCKED: 0, DOWN: 0, ERROR: 0, UNKNOWN: 0 };
  const blocked = [];
  const down = [];
  const error = [];
  const unknown = [];

  for (const row of rows) {
    const status = classifyVendimeStatus(row);
    counts[status] += 1;

    const item = {
      name_key: row.name_key,
      url: isMissingVendimeUrl(row.vendime_url) ? null : String(row.vendime_url).trim(),
      cooldown_until_utc: toIsoOrNull(row.cooldown_until_utc),
      last_error_type: row.last_error_type || null,
      homepage_status: row.homepage_status || null,
      feasibility: row.feasibility || null,
    };

    if (status === "BLOCKED") blocked.push(item);
    if (status === "DOWN") down.push(item);
    if (status === "ERROR") error.push(item);
    if (status === "UNKNOWN") unknown.push(item);
  }

  sortByNameKey(blocked);
  sortByNameKey(down);
  sortByNameKey(error);
  sortByNameKey(unknown);

  return {
    generated_at_utc: generatedAtUtc,
    total: rows.length,
    counts,
    blocked,
    down,
    error,
    unknown,
  };
}

async function fetchVendimeStatusRows(pool) {
  const query = `
    SELECT
      m.name_key,
      sr.vendime_url,
      sr.homepage_status,
      sr.last_error_type,
      sr.last_checked_utc,
      sr.cooldown_until_utc,
      sr.feasibility
    FROM municipalities m
    LEFT JOIN LATERAL (
      SELECT
        vendime_url,
        homepage_status,
        last_error_type,
        last_checked_utc,
        cooldown_until_utc,
        feasibility
      FROM source_registry sr
      WHERE sr.municipality_id = m.id
        AND sr.is_primary = TRUE
      ORDER BY sr.updated_at DESC
      LIMIT 1
    ) sr ON TRUE
    ORDER BY m.name_key ASC;
  `;

  const result = await pool.query(query);
  return result.rows;
}

async function fetchVendimeStatusSummary(pool, generatedAtUtc = new Date().toISOString()) {
  const rows = await fetchVendimeStatusRows(pool);
  return summarizeVendimeStatusRows(rows, generatedAtUtc);
}

module.exports = {
  DOWN_ERROR_TYPES,
  classifyVendimeStatus,
  fetchVendimeStatusRows,
  fetchVendimeStatusSummary,
  summarizeVendimeStatusRows,
};

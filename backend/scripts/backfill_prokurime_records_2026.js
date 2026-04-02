#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const { Pool } = require("pg");
const { rebuildProkurimeRecordForItem } = require("../lib/prokurimeRecords");

const API_BASE = process.env.API_BASE || process.env.SMOKE_BASE_URL || "http://localhost:5050";
const REPORT_DEFAULT = path.join(
  __dirname,
  "..",
  "tmp",
  "prokurime_2026_record_backfill_report.json"
);

function parseArgs(argv) {
  const out = {
    year: 2026,
    limit: 0,
    report: REPORT_DEFAULT,
    invalidateCache: true,
    timeoutMs: 20000,
  };

  for (const token of argv.slice(2)) {
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    const eqIndex = body.indexOf("=");
    const key = eqIndex === -1 ? body : body.slice(0, eqIndex);
    const value = eqIndex === -1 ? "true" : body.slice(eqIndex + 1);
    if (key === "year") out.year = Number.parseInt(value, 10);
    if (key === "limit") out.limit = Math.max(0, Number.parseInt(value, 10) || 0);
    if (key === "report" && value) out.report = path.resolve(process.cwd(), value);
    if (key === "timeout-ms") out.timeoutMs = Math.max(1000, Number.parseInt(value, 10) || 20000);
    if (key === "invalidate-cache") {
      out.invalidateCache = ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
    }
  }
  return out;
}

async function invalidateDashboardCache(adminToken) {
  if (!adminToken) return false;
  const response = await fetch(`${API_BASE}/api/admin/cache/dashboard-prokurime-pie/invalidate`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
  });
  return response.ok;
}

async function loadRepairCandidates(pool, year, limit) {
  const params = [`${year}-01-01`, `${year + 1}-01-01`];
  let limitSql = "";
  if (limit > 0) {
    params.push(limit);
    limitSql = `LIMIT $${params.length}`;
  }

  const result = await pool.query(
    `
    SELECT
      i.id AS item_id,
      i.municipality_id,
      lower(m.name_key) AS municipality_key,
      i.title,
      i.published_date,
      i.source_url,
      pr.item_id AS record_item_id,
      pr.amount_value,
      pr.amount_currency
    FROM items i
    JOIN municipalities m
      ON m.id = i.municipality_id
    LEFT JOIN prokurime_records pr
      ON pr.item_id = i.id
    WHERE i.category = 'Prokurime'
      AND i.published_date >= $1::date
      AND i.published_date < $2::date
      AND (
        pr.item_id IS NULL
        OR pr.amount_value IS NULL
        OR pr.amount_currency IS NULL
      )
    ORDER BY lower(m.name_key) ASC, i.published_date ASC NULLS LAST, i.id ASC
    ${limitSql}
    `,
    params
  );
  return result.rows;
}

async function main() {
  const args = parseArgs(process.argv);
  const adminToken = String(process.env.ADMIN_TOKEN || "").trim();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const report = {
    generated_at_utc: new Date().toISOString(),
    year: args.year,
    api_base: API_BASE,
    total_candidates: 0,
    upserted_count: 0,
    skipped_count: 0,
    cache_invalidated: false,
    reasons: {},
    items: [],
  };

  try {
    const candidates = await loadRepairCandidates(pool, args.year, args.limit);
    report.total_candidates = candidates.length;
    const exportPayloadCache = new Map();

    for (const candidate of candidates) {
      const result = await rebuildProkurimeRecordForItem({
        db: pool,
        item: {
          itemId: String(candidate.item_id || "").trim(),
          municipalityId: String(candidate.municipality_id || "").trim(),
          sourceUrl: String(candidate.source_url || "").trim(),
          title: String(candidate.title || "").trim(),
          publishedDate: candidate.published_date,
          procedureId: null,
        },
        requestTimeoutMs: args.timeoutMs,
        exportPayloadCache,
      });

      const reason = String(result.reason || "unknown");
      report.reasons[reason] = Number(report.reasons[reason] || 0) + 1;
      if (result.status === "upserted") report.upserted_count += 1;
      else report.skipped_count += 1;

      report.items.push({
        item_id: String(candidate.item_id || "").trim(),
        municipality_id: String(candidate.municipality_id || "").trim(),
        municipality_key: String(candidate.municipality_key || "").trim(),
        title: String(candidate.title || "").trim(),
        published_date: candidate.published_date,
        previous_record_present: Boolean(candidate.record_item_id),
        previous_amount_value: candidate.amount_value === null ? null : Number(candidate.amount_value),
        previous_amount_currency:
          candidate.amount_currency === null ? null : String(candidate.amount_currency),
        result_status: result.status,
        result_reason: reason,
        match_strategy: result.matchStrategy || null,
        amount_value: result.amountValue === undefined ? null : result.amountValue,
        amount_currency: result.amountCurrency === undefined ? null : result.amountCurrency,
      });
    }

    if (args.invalidateCache) {
      report.cache_invalidated = await invalidateDashboardCache(adminToken);
    }

    fs.mkdirSync(path.dirname(args.report), { recursive: true });
    fs.writeFileSync(args.report, JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify(
        {
          ok: true,
          report: args.report,
          total_candidates: report.total_candidates,
          upserted_count: report.upserted_count,
          skipped_count: report.skipped_count,
          cache_invalidated: report.cache_invalidated,
          reasons: report.reasons,
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`ERROR: ${String(err?.message || err)}`);
  process.exit(1);
});

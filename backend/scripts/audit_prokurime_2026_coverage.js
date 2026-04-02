#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const { Pool } = require("pg");
const { scrapeProkurimeAppExport } = require("../scrapers/prokurimeAppExport");
const {
  PROKURIME_AUTHORITY_HEADER_KEYWORDS,
  fetchProkurimeExportPayload,
  getRecordValueByHeaderKeywords,
  normalizeHeaderToken,
} = require("../lib/prokurimeRecords");
const {
  buildMunicipalityTermSet,
  matchAuthorityToMunicipalityAcrossContexts,
} = require("../lib/prokurimeAuthorityMatch");

const API_BASE = process.env.API_BASE || process.env.SMOKE_BASE_URL || "http://localhost:5050";
const YEAR_DEFAULT = 2026;
const OUTPUT_DEFAULT = path.join(__dirname, "..", "tmp", "prokurime_2026_coverage.json");
const REQUEST_TIMEOUT_MS = 20000;

function parseArgs(argv) {
  const out = {
    year: YEAR_DEFAULT,
    output: OUTPUT_DEFAULT,
    invalidateCache: false,
  };
  for (const token of argv.slice(2)) {
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    const eqIndex = body.indexOf("=");
    const key = eqIndex === -1 ? body : body.slice(0, eqIndex);
    const value = eqIndex === -1 ? "true" : body.slice(eqIndex + 1);
    if (key === "year") out.year = Number.parseInt(value, 10);
    if (key === "output" && value) out.output = path.resolve(process.cwd(), value);
    if (key === "invalidate-cache") out.invalidateCache = ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
  }
  return out;
}

function normalizeAuthorityText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsTermSequence(text, termVariant) {
  if (!text || !termVariant) return false;
  const escaped = String(termVariant).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(text);
}

async function invalidateDashboardCache(adminToken) {
  if (!adminToken) return;
  const response = await fetch(`${API_BASE}/api/admin/cache/dashboard-prokurime-pie/invalidate`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Cache invalidation failed with HTTP ${response.status}`);
  }
}

async function loadMunicipalityContexts(pool) {
  const municipalityResult = await pool.query(
    `
    SELECT id AS municipality_id, lower(name_key) AS municipality_key, name_sq
    FROM municipalities
    ORDER BY lower(name_key) ASC, id ASC
    `
  );
  const aliasResult = await pool.query(
    `
    SELECT municipality_id, lower(alias_key) AS alias_key
    FROM municipality_key_aliases
    ORDER BY municipality_id ASC, lower(alias_key) ASC
    `
  );
  const aliasByMunicipalityId = new Map();
  for (const row of aliasResult.rows) {
    const municipalityId = String(row.municipality_id || "").trim();
    const aliasKey = String(row.alias_key || "").trim();
    if (!municipalityId || !aliasKey) continue;
    const list = aliasByMunicipalityId.get(municipalityId) || [];
    list.push(aliasKey);
    aliasByMunicipalityId.set(municipalityId, list);
  }

  return municipalityResult.rows.map((row) => ({
    municipalityId: String(row.municipality_id || "").trim(),
    nameKey: String(row.municipality_key || "").trim(),
    nameSq: String(row.name_sq || "").trim(),
    aliasKeys: aliasByMunicipalityId.get(String(row.municipality_id || "").trim()) || [],
  }));
}

async function loadDbCoverage(pool, year) {
  const result = await pool.query(
    `
    WITH municipalities_cte AS (
      SELECT id, lower(name_key) AS municipality_key, name_sq
      FROM municipalities
    ),
    item_rows AS (
      SELECT
        i.id,
        i.municipality_id,
        i.title,
        i.published_date,
        i.source_url
      FROM items i
      WHERE i.category = 'Prokurime'
        AND i.published_date >= $1::date
        AND i.published_date < $2::date
    )
    SELECT
      m.id AS municipality_id,
      m.municipality_key,
      m.name_sq,
      COUNT(ir.id)::int AS items_found,
      COUNT(pr.item_id)::int AS records_found,
      COUNT(*) FILTER (
        WHERE pr.item_id IS NOT NULL
          AND pr.amount_value IS NOT NULL
          AND COALESCE(NULLIF(btrim(upper(pr.amount_currency)), ''), 'ALL') = 'ALL'
      )::int AS records_with_amount_all,
      COUNT(*) FILTER (
        WHERE pr.item_id IS NOT NULL
          AND pr.amount_value IS NULL
      )::int AS records_missing_amount_count,
      COUNT(*) FILTER (
        WHERE pr.item_id IS NOT NULL
          AND pr.amount_value IS NOT NULL
          AND COALESCE(NULLIF(btrim(upper(pr.amount_currency)), ''), 'ALL') <> 'ALL'
      )::int AS records_non_all_currency_count,
      COALESCE(
        SUM(
          CASE
            WHEN pr.amount_value IS NOT NULL
             AND COALESCE(NULLIF(btrim(upper(pr.amount_currency)), ''), 'ALL') = 'ALL'
            THEN pr.amount_value
            ELSE 0
          END
        ),
        0
      )::numeric(18,2)::text AS total_amount_all
    FROM municipalities_cte m
    LEFT JOIN item_rows ir
      ON ir.municipality_id = m.id
    LEFT JOIN prokurime_records pr
      ON pr.item_id = ir.id
    GROUP BY m.id, m.municipality_key, m.name_sq
    ORDER BY m.municipality_key ASC
    `,
    [`${year}-01-01`, `${year + 1}-01-01`]
  );
  return result.rows;
}

async function loadDashboardCoverage(municipalityKeys, year) {
  const rows = [];
  for (const municipalityKey of municipalityKeys) {
    const url = new URL(`${API_BASE.replace(/\/+$/, "")}/api/dashboard/prokurime/pie`);
    url.searchParams.set("municipality", municipalityKey);
    url.searchParams.set("year", String(year));
    url.searchParams.set("top", "5");

    let statusCode = 0;
    let totalAmount = null;
    let payload = null;
    let errorMessage = null;
    try {
      const response = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
        },
      });
      statusCode = response.status;
      payload = await response.json().catch(() => null);
      if (response.ok && payload && typeof payload.total_amount === "number") {
        totalAmount = payload.total_amount;
      } else if (payload && payload.message) {
        errorMessage = String(payload.message);
      } else if (!response.ok) {
        errorMessage = `HTTP ${response.status}`;
      }
    } catch (err) {
      errorMessage = String(err?.message || err || "request_failed");
    }

    rows.push({
      municipality_key: municipalityKey,
      status_code: statusCode,
      dashboard_total_amount: totalAmount,
      error_message: errorMessage,
      homepage_state: Number(totalAmount || 0) > 0 ? "populated" : "zero",
    });
  }
  return rows;
}

async function loadLiveSourceSignals(year, municipalityContexts) {
  const matchedResult = await scrapeProkurimeAppExport({
    year,
    limit: null,
    municipalityContexts,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  });
  const matchedCountByMunicipality = new Map();
  for (const item of matchedResult.items) {
    const municipalityKey = String(item.municipality_name_key || "").trim().toLowerCase();
    if (!municipalityKey) continue;
    matchedCountByMunicipality.set(
      municipalityKey,
      Number(matchedCountByMunicipality.get(municipalityKey) || 0) + 1
    );
  }

  const candidateMentionCountByMunicipality = new Map();
  const exportPayload = await fetchProkurimeExportPayload({
    exportUrl: `https://www.app.gov.al/GetData/ExportDocument?year=${year}`,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (exportPayload.kind === "csv") {
    const contexts = municipalityContexts.map((context) => ({
      ...context,
      municipalityTerms: buildMunicipalityTermSet(context),
    }));
    for (const record of exportPayload.records) {
      const authority = getRecordValueByHeaderKeywords(record, PROKURIME_AUTHORITY_HEADER_KEYWORDS);
      const matched = matchAuthorityToMunicipalityAcrossContexts({
        authority,
        municipalityContexts: contexts,
      });
      if (matched?.matched) continue;

      const normalizedAuthority = normalizeAuthorityText(authority);
      if (!normalizedAuthority) continue;
      for (const context of contexts) {
        const municipalityKey = String(context.nameKey || "").trim().toLowerCase();
        if (!municipalityKey) continue;
        const found = (context.municipalityTerms || []).some((term) =>
          containsTermSequence(normalizedAuthority, normalizeAuthorityText(term))
        );
        if (!found) continue;
        candidateMentionCountByMunicipality.set(
          municipalityKey,
          Number(candidateMentionCountByMunicipality.get(municipalityKey) || 0) + 1
        );
      }
    }
  }

  return {
    matchedCountByMunicipality,
    candidateMentionCountByMunicipality,
    meta: matchedResult.meta || null,
  };
}

function determineStatusAndReason(row) {
  const dbAmount = Number(row.total_amount_all || 0);
  const dashboardAmount = Number(row.dashboard_total_amount || 0);

  if (Number(row.dashboard_status_code || 0) !== 200) {
    return {
      status: "error",
      reason: "dashboard_http_error",
    };
  }

  if (dashboardAmount > 0 && dbAmount <= 0) {
    return {
      status: "error",
      reason: "dashboard_mismatch",
    };
  }

  if (dbAmount > 0) {
    const diff = Math.abs(dbAmount - dashboardAmount);
    if (diff <= 0.01) {
      return {
        status: "populated",
        reason: null,
      };
    }
    return {
      status: "error",
      reason: dashboardAmount === 0 ? "cache_stale" : "dashboard_mismatch",
    };
  }

  if (Number(row.items_found || 0) === 0) {
    if (Number(row.matched_source_rows || 0) > 0) {
      return {
        status: "zero_real",
        reason: "no_items_2026",
      };
    }
    if (Number(row.candidate_source_rows || 0) > 0) {
      return {
        status: "zero_real",
        reason: "municipality_match_gap",
      };
    }
    return {
      status: "zero_real",
      reason: "no_source_rows",
    };
  }

  if (Number(row.records_found || 0) === 0) {
    return {
      status: "zero_real",
      reason: "items_missing_records",
    };
  }

  if (Number(row.records_with_amount_all || 0) === 0) {
    if (Number(row.records_missing_amount_count || 0) > 0) {
      return {
        status: "zero_real",
        reason: "records_missing_amount",
      };
    }
    if (Number(row.records_non_all_currency_count || 0) > 0) {
      return {
        status: "zero_real",
        reason: "currency_not_all",
      };
    }
  }

  return {
    status: "error",
    reason: "dashboard_mismatch",
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const adminToken = String(process.env.ADMIN_TOKEN || "").trim();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    if (args.invalidateCache) {
      await invalidateDashboardCache(adminToken);
    }

    const municipalityContexts = await loadMunicipalityContexts(pool);
    const dbCoverage = await loadDbCoverage(pool, args.year);
    const dashboardCoverage = await loadDashboardCoverage(
      dbCoverage.map((row) => String(row.municipality_key || "").trim()),
      args.year
    );
    const dashboardByMunicipality = new Map(
      dashboardCoverage.map((row) => [String(row.municipality_key || "").trim(), row])
    );
    const liveSourceSignals = await loadLiveSourceSignals(args.year, municipalityContexts);

    const items = dbCoverage.map((row) => {
      const municipalityKey = String(row.municipality_key || "").trim();
      const dashboardRow = dashboardByMunicipality.get(municipalityKey) || null;
      const matchedSourceRows = Number(
        liveSourceSignals.matchedCountByMunicipality.get(municipalityKey) || 0
      );
      const candidateSourceRows = Number(
        liveSourceSignals.candidateMentionCountByMunicipality.get(municipalityKey) || 0
      );
      const baseRow = {
        municipality_id: String(row.municipality_id || "").trim(),
        municipality_key: municipalityKey,
        municipality_name_sq: String(row.name_sq || "").trim(),
        items_found: Number(row.items_found || 0),
        records_found: Number(row.records_found || 0),
        records_with_amount_all: Number(row.records_with_amount_all || 0),
        records_missing_amount_count: Number(row.records_missing_amount_count || 0),
        records_non_all_currency_count: Number(row.records_non_all_currency_count || 0),
        total_amount_all: Number(row.total_amount_all || 0),
        matched_source_rows: matchedSourceRows,
        candidate_source_rows: candidateSourceRows,
        dashboard_status_code: Number(dashboardRow?.status_code || 0),
        dashboard_total_amount:
          dashboardRow && typeof dashboardRow.dashboard_total_amount === "number"
            ? dashboardRow.dashboard_total_amount
            : null,
        homepage_state: String(dashboardRow?.homepage_state || "zero"),
        dashboard_error_message: dashboardRow?.error_message || null,
      };
      const statusAndReason = determineStatusAndReason(baseRow);
      return {
        ...baseRow,
        status: statusAndReason.status,
        reason: statusAndReason.reason,
      };
    });

    const summary = {
      total_municipalities: items.length,
      populated_count: items.filter((row) => row.status === "populated").length,
      zero_real_count: items.filter((row) => row.status === "zero_real").length,
      error_count: items.filter((row) => row.status === "error").length,
      reasons: items.reduce((acc, row) => {
        const key = row.reason || "none";
        acc[key] = Number(acc[key] || 0) + 1;
        return acc;
      }, {}),
      live_source_meta: liveSourceSignals.meta,
    };

    const payload = {
      generated_at_utc: new Date().toISOString(),
      year: args.year,
      api_base: API_BASE,
      summary,
      items,
    };

    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, JSON.stringify(payload, null, 2));
    console.log(JSON.stringify({
      ok: true,
      output: args.output,
      summary,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`ERROR: ${String(err?.message || err)}`);
  process.exit(1);
});

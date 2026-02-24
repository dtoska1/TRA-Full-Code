#!/usr/bin/env node
"use strict";

const path = require("path");
const { Pool } = require("pg");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

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

function normalizeCategory(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "vendime") return "Vendime";
  if (value === "prokurime") return "Prokurime";
  if (value === "konsultime publike" || value === "konsultime-publike") return "Konsultime publike";
  return null;
}

function checkedColumnForCategory(category) {
  if (category === "Vendime") return "vendime_checked";
  if (category === "Prokurime") return "prokurime_checked";
  if (category === "Konsultime publike") return "konsultime_checked";
  return null;
}

function toBool(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  const s = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

async function run() {
  const args = parseArgs(process.argv);
  const category = normalizeCategory(args.category);
  if (!category) {
    console.error(
      "ERROR: --category is required and must be one of: Vendime, Prokurime, Konsultime publike."
    );
    process.exit(1);
  }
  const checkedColumn = checkedColumnForCategory(category);
  const dryRun = toBool(args.dry_run, false);

  if (!process.env.DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is required.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: "-c client_encoding=UTF8 -c statement_timeout=60000",
  });

  try {
    const baseline = await pool.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE is_primary = TRUE) AS primary_total,
        COUNT(*) FILTER (
          WHERE is_primary = TRUE
            AND verification_status = 'CHECKED'
        ) AS legacy_checked_total,
        COUNT(*) FILTER (
          WHERE is_primary = TRUE
            AND verification_status = 'CHECKED'
            AND ${checkedColumn} = TRUE
        ) AS already_backfilled_total
      FROM source_registry
      `
    );
    const summary = baseline.rows[0] || {};
    const primaryTotal = Number(summary.primary_total || 0);
    const legacyCheckedTotal = Number(summary.legacy_checked_total || 0);
    const alreadyBackfilledTotal = Number(summary.already_backfilled_total || 0);

    console.log(
      `category=${category} checked_column=${checkedColumn} primary_total=${primaryTotal} legacy_checked_total=${legacyCheckedTotal} already_backfilled_total=${alreadyBackfilledTotal} dry_run=${dryRun}`
    );

    if (dryRun) return;

    const update = await pool.query(
      `
      UPDATE source_registry
      SET ${checkedColumn} = TRUE,
          updated_at = now()
      WHERE is_primary = TRUE
        AND verification_status = 'CHECKED'
        AND ${checkedColumn} = FALSE
      `
    );

    console.log(`updated_rows=${update.rowCount}`);
  } finally {
    await pool.end().catch(() => {});
  }
}

run().catch((err) => {
  console.error(`ERROR: ${String(err?.message || err)}`);
  process.exit(1);
});

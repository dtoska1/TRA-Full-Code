"use strict";

const path = require("path");
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

async function main() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    options: "-c client_encoding=UTF8",
  });

  try {
    const totalsSql = `
      SELECT
        count(*)::int AS total_primary,
        count(*) FILTER (
          WHERE sr.prokurime_url IS NULL OR btrim(sr.prokurime_url) = ''
        )::int AS missing_prokurime,
        count(*) FILTER (
          WHERE sr.konsultime_url IS NULL OR btrim(sr.konsultime_url) = ''
        )::int AS missing_konsultime
      FROM source_registry sr
      WHERE sr.is_primary = TRUE
    `;

    const prokSql = `
      SELECT m.name_key
      FROM source_registry sr
      JOIN municipalities m ON m.id = sr.municipality_id
      WHERE sr.is_primary = TRUE
        AND (sr.prokurime_url IS NULL OR btrim(sr.prokurime_url) = '')
      ORDER BY m.name_key ASC
    `;

    const konsSql = `
      SELECT m.name_key
      FROM source_registry sr
      JOIN municipalities m ON m.id = sr.municipality_id
      WHERE sr.is_primary = TRUE
        AND (sr.konsultime_url IS NULL OR btrim(sr.konsultime_url) = '')
      ORDER BY m.name_key ASC
    `;

    const [totalsRes, prokRes, konsRes] = await Promise.all([
      pool.query(totalsSql),
      pool.query(prokSql),
      pool.query(konsSql),
    ]);

    const totals = totalsRes.rows[0] || {};
    const missingProk = prokRes.rows.map((r) => String(r.name_key || "").trim()).filter(Boolean);
    const missingKons = konsRes.rows.map((r) => String(r.name_key || "").trim()).filter(Boolean);

    console.log("Registry missing URL audit");
    console.log(`Generated at (UTC): ${new Date().toISOString()}`);
    console.log(`Primary rows: ${Number(totals.total_primary || 0)}`);
    console.log(`Missing prokurime_url: ${Number(totals.missing_prokurime || 0)}`);
    console.log(`Missing konsultime_url: ${Number(totals.missing_konsultime || 0)}`);
    console.log("");

    console.log("Missing prokurime_url municipality keys:");
    if (missingProk.length === 0) {
      console.log("- none");
    } else {
      for (const key of missingProk) console.log(`- ${key}`);
    }

    console.log("");
    console.log("Missing konsultime_url municipality keys:");
    if (missingKons.length === 0) {
      console.log("- none");
    } else {
      for (const key of missingKons) console.log(`- ${key}`);
    }
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

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
    const sql = `
      SELECT
        id,
        name_sq,
        name_key,
        county,
        (name_sq ~ '[ÃÂ]') AS has_name_sq_mojibake,
        (name_key ~ '[a-z]-[a-z]') AS has_midword_hyphen
      FROM municipalities
      WHERE name_sq ~ '[ÃÂ]'
         OR name_key ~ '[a-z]-[a-z]'
      ORDER BY name_sq ASC
    `;

    const result = await pool.query(sql);
    console.log(`Candidates: ${result.rowCount}`);

    if (result.rowCount === 0) return;

    for (const row of result.rows) {
      console.log(
        [
          row.name_key,
          `name_sq="${row.name_sq}"`,
          `county="${row.county || "-"}"`,
          `name_sq_mojibake=${row.has_name_sq_mojibake}`,
          `midword_hyphen=${row.has_midword_hyphen}`,
        ].join(" | ")
      );
    }
  } catch (err) {
    console.error("ERROR:", err?.message || err);
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

"use strict";

const fs = require("fs");
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

const INPUT_PATH = path.join(__dirname, "..", "tmp", "vendime_discovery.json");

function getRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.records)) return payload.records;
  throw new Error("Invalid discovery payload. Expected array or { records: [] }.");
}

function normalizedString(value) {
  const text = String(value || "").trim();
  return text || null;
}

function resolveConfirmedUrl(record) {
  if (record.confirmed !== true) return null;

  const explicit = normalizedString(record.selected_vendime_url);
  if (explicit) return explicit;

  const suggested = normalizedString(record.suggested_vendime_url);
  if (suggested) return suggested;

  if (record.suggestion && typeof record.suggestion === "object") {
    const nested = normalizedString(record.suggestion.url);
    if (nested) return nested;
  }

  return null;
}

async function main() {
  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`ERROR: discovery file not found: ${INPUT_PATH}`);
    process.exit(2);
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
  } catch (err) {
    console.error("ERROR: failed to parse vendime_discovery.json:", err && err.message ? err.message : err);
    process.exit(2);
  }

  const records = getRecords(payload);
  const confirmed = records
    .map((record) => ({
      name_key: normalizedString(record.name_key) || "-",
      source_registry_id: normalizedString(record.source_registry_id),
      vendime_url: resolveConfirmedUrl(record),
    }))
    .filter((item) => item.source_registry_id && item.vendime_url);

  console.log(`Records in file: ${records.length}`);
  console.log(`Confirmed records to apply: ${confirmed.length}`);

  if (confirmed.length === 0) {
    console.log("No confirmed entries found. Nothing to update.");
    return;
  }

  const pool = new Pool({
    connectionString: DATABASE_URL,
    options: "-c client_encoding=UTF8",
  });

  let applied = 0;
  let skipped = 0;

  try {
    for (const item of confirmed) {
      const updateSql = `
        UPDATE source_registry
        SET
          vendime_url = $2,
          last_error_type = NULL,
          homepage_status = 'OK',
          cooldown_until_utc = NULL,
          updated_at = now()
        WHERE id = $1
          AND is_primary = TRUE
          AND (vendime_url IS NULL OR btrim(vendime_url) = '')
        RETURNING id
      `;

      const result = await pool.query(updateSql, [item.source_registry_id, item.vendime_url]);

      if (result.rowCount === 1) {
        applied += 1;
        console.log(`APPLIED ${item.name_key} -> ${item.vendime_url}`);
      } else {
        skipped += 1;
        console.log(`SKIPPED ${item.name_key} (already set or not found)`);
      }
    }

    console.log("");
    console.log(`Apply finished. Applied=${applied} Skipped=${skipped}`);
    console.log("verification_status was not modified.");
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


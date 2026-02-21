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

const CATEGORY_CONFIG = {
  prokurime: {
    displayName: "Prokurime",
    columnName: "prokurime_url",
    outputName: "prokurime",
  },
  konsultime: {
    displayName: "Konsultime publike",
    columnName: "konsultime_url",
    outputName: "konsultime",
  },
};

function parseArgs(argv) {
  let categoryArg = "";
  let inputPathArg = "";

  for (const raw of argv.slice(2)) {
    const arg = String(raw || "").trim();
    if (!arg) continue;

    if (arg.startsWith("--category=")) {
      categoryArg = arg.slice("--category=".length);
      continue;
    }
    if (arg.startsWith("--input=")) {
      inputPathArg = arg.slice("--input=".length);
      continue;
    }

    if (!categoryArg && (arg === "prokurime" || arg === "konsultime")) {
      categoryArg = arg;
      continue;
    }
    if (!inputPathArg) inputPathArg = arg;
  }

  const categoryKey = String(categoryArg || "").trim().toLowerCase();
  if (!CATEGORY_CONFIG[categoryKey]) {
    console.error(
      'ERROR: category is required. Use "prokurime" or "konsultime". Example: node scripts/apply_registry_urls.js --category=prokurime'
    );
    process.exit(2);
  }

  const config = CATEGORY_CONFIG[categoryKey];
  const defaultInputPath = path.join(
    __dirname,
    "..",
    "tmp",
    `registry_discovery_${config.outputName}.json`
  );
  const inputPath = inputPathArg ? path.resolve(inputPathArg) : defaultInputPath;

  return { categoryKey, config, inputPath };
}

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

  const explicit = normalizedString(record.selected_url);
  if (explicit) return explicit;

  const recommended = normalizedString(record.recommended_url);
  if (recommended) return recommended;

  if (record.suggestion && typeof record.suggestion === "object") {
    const nested = normalizedString(record.suggestion.url);
    if (nested) return nested;
  }

  return null;
}

async function main() {
  const { config, inputPath } = parseArgs(process.argv);

  if (!fs.existsSync(inputPath)) {
    console.error(`ERROR: discovery file not found: ${inputPath}`);
    process.exit(2);
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  } catch (err) {
    console.error("ERROR: failed to parse discovery file:", err && err.message ? err.message : err);
    process.exit(2);
  }

  const records = getRecords(payload);
  const confirmed = records
    .map((record) => ({
      name_key: normalizedString(record.name_key) || "-",
      source_registry_id: normalizedString(record.source_registry_id),
      url: resolveConfirmedUrl(record),
    }))
    .filter((row) => row.source_registry_id && row.url);

  console.log(`Category: ${config.displayName}`);
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
          ${config.columnName} = $2,
          last_error_type = NULL,
          homepage_status = 'OK',
          cooldown_until_utc = NULL,
          updated_at = now()
        WHERE id = $1
          AND is_primary = TRUE
          AND (${config.columnName} IS NULL OR btrim(${config.columnName}) = '')
        RETURNING id
      `;

      const result = await pool.query(updateSql, [item.source_registry_id, item.url]);
      if (result.rowCount === 1) {
        applied += 1;
        console.log(`APPLIED ${item.name_key} -> ${item.url}`);
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

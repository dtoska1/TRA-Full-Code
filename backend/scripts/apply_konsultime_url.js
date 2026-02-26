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

const INPUT_PATH = path.join(__dirname, "..", "tmp", "konsultime_discovery.json");

function normalizedString(value) {
  const text = String(value || "").trim();
  return text || null;
}

function getCandidates(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.candidates)) return payload.candidates;
  throw new Error("Invalid discovery payload. Expected array or { candidates: [] }.");
}

function resolveConfirmedUrl(candidate) {
  if (candidate.confirmed !== true) return null;

  const selectedKonsultime = normalizedString(candidate.selected_konsultime_url);
  if (selectedKonsultime) return selectedKonsultime;

  const selectedGeneric = normalizedString(candidate.selected_url);
  if (selectedGeneric) return selectedGeneric;

  const best = normalizedString(candidate.best_url);
  if (best) return best;

  return null;
}

async function loadMissingList(pool) {
  const sql = `
    SELECT m.name_key
    FROM source_registry sr
    JOIN municipalities m ON m.id = sr.municipality_id
    WHERE sr.is_primary = TRUE
      AND (sr.konsultime_url IS NULL OR btrim(sr.konsultime_url) = '')
    ORDER BY m.name_key ASC
  `;
  const result = await pool.query(sql);
  return result.rows.map((row) => String(row.name_key || "").trim()).filter(Boolean);
}

async function resolveRegistryIdByNameKey(pool, nameKey) {
  if (!nameKey) return null;
  const result = await pool.query(
    `
    SELECT sr.id
    FROM source_registry sr
    JOIN municipalities m ON m.id = sr.municipality_id
    WHERE sr.is_primary = TRUE
      AND m.name_key = $1
    LIMIT 1
    `,
    [nameKey]
  );
  return result.rowCount ? String(result.rows[0].id || "").trim() : null;
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
    console.error(
      "ERROR: failed to parse konsultime_discovery.json:",
      err && err.message ? err.message : err
    );
    process.exit(2);
  }

  const candidates = getCandidates(payload);

  const pool = new Pool({
    connectionString: DATABASE_URL,
    options: "-c client_encoding=UTF8",
  });

  let applied = 0;
  let skipped = 0;

  try {
    const missingBefore = await loadMissingList(pool);

    const confirmedRaw = candidates
      .map((candidate) => ({
        name_key: normalizedString(candidate.name_key),
        source_registry_id: normalizedString(candidate.source_registry_id),
        best_url: resolveConfirmedUrl(candidate),
      }))
      .filter((candidate) => candidate.best_url && (candidate.source_registry_id || candidate.name_key));

    const confirmed = [];
    for (const item of confirmedRaw) {
      const resolvedId =
        item.source_registry_id || (await resolveRegistryIdByNameKey(pool, item.name_key || null));
      if (!resolvedId) {
        skipped += 1;
        console.log(`SKIPPED ${item.name_key || "-"} (source_registry_id not resolvable)`);
        continue;
      }
      confirmed.push({
        name_key: item.name_key || "-",
        source_registry_id: resolvedId,
        best_url: item.best_url,
      });
    }

    console.log(`Missing konsultime_url before apply: ${missingBefore.length}`);
    console.log(`Records in file: ${candidates.length}`);
    console.log(`Confirmed rows to apply: ${confirmed.length}`);

    if (confirmed.length === 0) {
      const missingAfterNoop = await loadMissingList(pool);
      console.log("No confirmed entries found. Nothing to update.");
      console.log(`Missing konsultime_url after apply: ${missingAfterNoop.length}`);
      if (missingAfterNoop.length > 0) {
        console.log("Still missing name_keys:");
        for (const key of missingAfterNoop) console.log(`- ${key}`);
      }
      return;
    }

    for (const item of confirmed) {
      const sql = `
        UPDATE source_registry
        SET
          konsultime_url = $2,
          last_error_type = NULL,
          cooldown_until_utc = NULL,
          final_url = NULL,
          homepage_status = 'OK',
          updated_at = now()
        WHERE id = $1
          AND is_primary = TRUE
          AND (konsultime_url IS NULL OR btrim(konsultime_url) = '')
        RETURNING id
      `;

      const result = await pool.query(sql, [item.source_registry_id, item.best_url]);
      if (result.rowCount === 1) {
        applied += 1;
        console.log(`APPLIED ${item.name_key} -> ${item.best_url}`);
      } else {
        skipped += 1;
        console.log(`SKIPPED ${item.name_key} (already set or not found)`);
      }
    }

    const missingAfter = await loadMissingList(pool);

    console.log("");
    console.log("Apply coverage summary");
    console.log(`- missing before: ${missingBefore.length}`);
    console.log(`- confirmed input: ${confirmed.length}`);
    console.log(`- applied: ${applied}`);
    console.log(`- skipped: ${skipped}`);
    console.log(`- missing after: ${missingAfter.length}`);
    if (missingAfter.length > 0) {
      console.log("- still-missing name_keys:");
      for (const key of missingAfter) console.log(`  - ${key}`);
    }
    console.log("konsultime_checked was not modified.");
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


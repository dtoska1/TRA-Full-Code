#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const SQL_FILES = [
  "001_init.sql",
  "002_hardening.sql",
  "003_views_and_keys.sql",
  "004_name_key_trigger.sql",
  "005_seed_municipalities.sql",
  "006_seed_source_registry.sql",
  "014_municipality_key_aliases.sql",
  "015_vendime_al_canonical_and_item_provenance.sql",
  "018_source_registry_category_checked_flags.sql",
  "019_prokurime_records.sql",
  "020_prokurime_records_schema_align.sql",
  "021_fix_vau_i_dejes_prokurime_alias.sql",
];

function sanitizeSql(sqlText) {
  return sqlText
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("\\"))
    .join("\n");
}

async function run() {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for ci_bootstrap_db.js");
  }

  const client = new Client({
    connectionString: databaseUrl,
  });

  await client.connect();

  try {
    for (const file of SQL_FILES) {
      const filePath = path.join(ROOT_DIR, file);
      const raw = fs.readFileSync(filePath, "utf8");
      const sql = sanitizeSql(raw);

      process.stdout.write(`Applying ${file}...\n`);
      await client.query(sql);
    }

    const municipalityCount = await client.query(
      "SELECT COUNT(*)::int AS count FROM municipalities"
    );
    const sourceRegistryCount = await client.query(
      "SELECT COUNT(*)::int AS count FROM source_registry WHERE is_primary = TRUE"
    );

    const municipalities = Number(municipalityCount.rows[0]?.count || 0);
    const sourceRegistry = Number(sourceRegistryCount.rows[0]?.count || 0);

    if (municipalities !== 61) {
      throw new Error(`Expected 61 municipalities, got ${municipalities}`);
    }
    if (sourceRegistry !== 61) {
      throw new Error(`Expected 61 primary source_registry rows, got ${sourceRegistry}`);
    }

    process.stdout.write("DB bootstrap checks passed.\n");
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error("DB bootstrap failed:", err.message);
  process.exit(1);
});

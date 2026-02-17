// backend/scripts/sanity_registry.js
"use strict";

require("dotenv").config();
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set (check backend/.env)");
  process.exit(2);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function scalar(sql, params = []) {
  const r = await pool.query(sql, params);
  const v = r.rows?.[0];
  const firstKey = v ? Object.keys(v)[0] : null;
  return firstKey ? Number(v[firstKey]) : 0;
}

(async () => {
  try {
    const municipalities = await scalar(`SELECT count(*) AS c FROM municipalities;`);
    const primaries = await scalar(
      `SELECT count(*) AS c FROM source_registry WHERE is_primary = TRUE;`
    );
    const primariesWithBaseUrl = await scalar(
      `SELECT count(*) AS c
       FROM source_registry
       WHERE is_primary = TRUE
         AND base_url IS NOT NULL
         AND length(btrim(base_url)) > 0;`
    );
    const badPrimaryCounts = await scalar(
      `SELECT count(*) AS c
       FROM (
         SELECT municipality_id
         FROM source_registry
         WHERE is_primary = TRUE
         GROUP BY municipality_id
         HAVING count(*) <> 1
       ) t;`
    );

    console.log("Registry sanity check:");
    console.log("  municipalities:", municipalities);
    console.log("  source_registry primaries:", primaries);
    console.log("  primaries with base_url:", primariesWithBaseUrl);
    console.log("  municipalities w/ bad primary count:", badPrimaryCounts);

    const problems = [];
    if (municipalities !== 61) problems.push(`municipalities expected 61, got ${municipalities}`);
    if (primaries !== 61) problems.push(`primaries expected 61, got ${primaries}`);
    if (primariesWithBaseUrl !== 61) problems.push(`primaries with base_url expected 61, got ${primariesWithBaseUrl}`);
    if (badPrimaryCounts !== 0) problems.push(`some municipalities have <>1 primary row`);

    if (problems.length) {
      console.error("FAIL:");
      for (const p of problems) console.error(" -", p);
      process.exit(1);
    }

    console.log("OK ✅");
    process.exit(0);
  } catch (err) {
    console.error("ERROR:", err?.message || err);
    process.exit(2);
  } finally {
    try { await pool.end(); } catch {}
  }
})();

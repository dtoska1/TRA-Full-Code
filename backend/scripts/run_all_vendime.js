//backend/scripts/run_all_vendime.js

/**
 * scripts/run_all_vendime.js
 *
 * Batch runner for Transparency Radar Albania.
 * - Reads primary registry rows from Postgres
 * - Skips cooldown / hard blocks
 * - Scrapes via your running API: POST /api/scrape/run?municipality_id=...&category=Vendime&year=...&limit=...
 * - Prints a summary table + writes a CSV log
 *
 * Usage (PowerShell / CMD):
 *   node scripts/run_all_vendime.js --year=2026 --limit=80
 *
 * Optional:
 *   --base=http://localhost:5050   (API base URL)
 *   --concurrency=1               (default 1; keep low to be polite)
 *   --include-hard-blocks=true    (default false; includes TLS_CERT_EXPIRED / BOT_CHALLENGE)
 *   --dry-run=true                (default false; no HTTP calls, just prints what would run)
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: require('path').join(process.cwd(), '.env') });

const fs = require('fs');
const { Pool } = require('pg');

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function toBool(v, def = false) {
  if (v === undefined) return def;
  const s = String(v).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(s);
}

function toInt(v, def) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : def;
}

function isoNow() {
  return new Date().toISOString();
}

function safeCsv(s) {
  const t = String(s ?? '');
  if (/[,"\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function postJson(url) {
  const res = await fetch(url, { method: 'POST', headers: { 'Accept': 'application/json' } });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { ok: false, error: 'non_json_response', raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function main() {
  const args = parseArgs(process.argv);

  const year = toInt(args.year, new Date().getFullYear());
  const limit = toInt(args.limit, 80);
  const base = (args.base || process.env.API_BASE || 'http://localhost:5050').replace(/\/+$/, '');
  const concurrency = Math.max(1, toInt(args.concurrency, 1));
  const includeHardBlocks = toBool(args['include-hard-blocks'], false);
  const dryRun = toBool(args['dry-run'], false);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL env var is not set.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });

  // Get primary registry rows + municipality names/keys
  const q = `
    SELECT
      m.id AS municipality_id,
      m.name_sq AS municipality_name,
      m.name_key AS municipality_key,
      sr.id AS registry_id,
      sr.vendime_url,
      sr.last_error_type,
      sr.cooldown_until_utc
    FROM source_registry sr
    JOIN municipalities m ON m.id = sr.municipality_id
    WHERE sr.is_primary = TRUE
    ORDER BY m.name_sq;
  `;

  const { rows } = await pool.query(q);

  const now = new Date();

  // Proactively mark blank URLs as CONFIG_MISSING_URL so health is accurate
  const blanks = rows.filter(r => !r.vendime_url || String(r.vendime_url).trim() === '');
  if (blanks.length) {
    const ids = blanks.map(r => r.registry_id);
    await pool.query(
      `UPDATE source_registry SET last_error_type='CONFIG_MISSING_URL' WHERE id = ANY($1::uuid[])`,
      [ids]
    );
  }

  const hardBlockSet = new Set(['TLS_CERT_EXPIRED', 'BOT_CHALLENGE']);

  const jobs = rows.map(r => {
    const vendimeUrl = (r.vendime_url || '').trim();
    const cooldown = r.cooldown_until_utc ? new Date(r.cooldown_until_utc) : null;

    let skipReason = '';
    if (!vendimeUrl) skipReason = 'config_missing_url';
    else if (cooldown && cooldown > now) skipReason = 'cooldown';
    else if (!includeHardBlocks && r.last_error_type && hardBlockSet.has(r.last_error_type)) skipReason = `hard_block:${r.last_error_type}`;

    return {
      municipality_id: r.municipality_id,
      municipality_name: r.municipality_name,
      municipality_key: r.municipality_key,
      registry_id: r.registry_id,
      vendime_url: vendimeUrl,
      last_error_type: r.last_error_type || '',
      cooldown_until_utc: r.cooldown_until_utc ? new Date(r.cooldown_until_utc).toISOString() : '',
      skipReason,
    };
  });

  const runnable = jobs.filter(j => !j.skipReason);
  const skipped = jobs.filter(j => j.skipReason);

  console.log(`\nBatch Vendime runner`);
  console.log(`- API base: ${base}`);
  console.log(`- Year: ${year}  Limit: ${limit}`);
  console.log(`- Concurrency: ${concurrency}`);
  console.log(`- Total municipalities: ${jobs.length}`);
  console.log(`- Runnable: ${runnable.length}  Skipped: ${skipped.length}`);
  if (dryRun) console.log(`- DRY RUN: no HTTP calls\n`);

  const results = [];

  // Simple worker pool
  let idx = 0;
  async function worker(workerId) {
    while (true) {
      const j = runnable[idx++];
      if (!j) return;

      const url = new URL(`${base}/api/scrape/run`);
      url.searchParams.set('municipality_id', j.municipality_id);
      url.searchParams.set('category', 'Vendime');
      url.searchParams.set('year', String(year));
      url.searchParams.set('limit', String(limit));

      const started = Date.now();

      if (dryRun) {
        results.push({
          municipality: j.municipality_name,
          municipality_id: j.municipality_id,
          status: 'DRY_RUN',
          parsed_rows_total: 0,
          parsed_rows_kept: 0,
          inserted: 0,
          skipped: 0,
          last_error_type: '',
          scraped_from: j.vendime_url,
          ms: 0,
        });
        continue;
      }

      try {
        const data = await postJson(url.toString());
        results.push({
          municipality: j.municipality_name,
          municipality_id: j.municipality_id,
          status: 'OK',
          parsed_rows_total: data.parsed_rows_total ?? data.parsed_rows ?? null,
          parsed_rows_kept: data.parsed_rows_kept ?? null,
          inserted: data.inserted ?? null,
          skipped: data.skipped ?? null,
          last_error_type: data.last_error_type ?? '',
          scraped_from: data.scraped_from ?? '',
          ms: Date.now() - started,
        });
      } catch (e) {
        const data = e.data || {};
        results.push({
          municipality: j.municipality_name,
          municipality_id: j.municipality_id,
          status: 'ERR',
          parsed_rows_total: data.parsed_rows_total ?? null,
          parsed_rows_kept: data.parsed_rows_kept ?? null,
          inserted: data.inserted ?? null,
          skipped: data.skipped ?? null,
          last_error_type: data.last_error_type ?? data.error ?? 'HTTP_ERROR',
          scraped_from: data.scraped_from ?? '',
          ms: Date.now() - started,
          error_message: e.message,
          http_status: e.status ?? null,
        });
      }

      // tiny politeness delay; helps avoid rate-limits on municipal sites
      await sleep(250);
    }
  }

  const workers = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker(w + 1));
  await Promise.all(workers);

  // Add skipped entries to results list for completeness
  for (const j of skipped) {
    results.push({
      municipality: j.municipality_name,
      municipality_id: j.municipality_id,
      status: `SKIP:${j.skipReason}`,
      parsed_rows_total: null,
      parsed_rows_kept: null,
      inserted: null,
      skipped: null,
      last_error_type: j.last_error_type || '',
      scraped_from: j.vendime_url || '',
      ms: 0,
    });
  }

  // Summary to console
  const summaryRows = results
    .slice()
    .sort((a, b) => String(a.municipality).localeCompare(String(b.municipality)))
    .map(r => ({
      municipality: r.municipality,
      status: r.status,
      kept: r.parsed_rows_kept,
      inserted: r.inserted,
      skipped: r.skipped,
      err: r.last_error_type || '',
    }));

  console.log('\nSummary:');
  console.table(summaryRows);

  // Write CSV log
  const ts = isoNow().replace(/[:.]/g, '-');
  const outDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, `run_all_vendime_${ts}.csv`);
  const headers = [
    'timestamp_utc',
    'municipality',
    'municipality_id',
    'status',
    'parsed_rows_total',
    'parsed_rows_kept',
    'inserted',
    'skipped',
    'last_error_type',
    'scraped_from',
    'ms',
    'http_status',
    'error_message',
  ];

  const lines = [headers.join(',')];
  for (const r of results) {
    lines.push([
      safeCsv(isoNow()),
      safeCsv(r.municipality),
      safeCsv(r.municipality_id),
      safeCsv(r.status),
      safeCsv(r.parsed_rows_total),
      safeCsv(r.parsed_rows_kept),
      safeCsv(r.inserted),
      safeCsv(r.skipped),
      safeCsv(r.last_error_type),
      safeCsv(r.scraped_from),
      safeCsv(r.ms),
      safeCsv(r.http_status ?? ''),
      safeCsv(r.error_message ?? ''),
    ].join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

  console.log(`\nWrote log: ${outPath}`);

  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

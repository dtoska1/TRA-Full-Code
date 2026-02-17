'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(process.cwd(), '.env') });

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function toInt(v, fallback) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJsonWithRetry(url, maxAttempts = 2) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });

      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = { ok: false, error: 'non_json_response', raw: text };
      }

      if (!res.ok) {
        const err = new Error(data?.message || `HTTP ${res.status}`);
        err.status = res.status;
        err.data = data;
        throw err;
      }

      return data;
    } catch (err) {
      lastError = err;

      const status = Number(err?.status || 0);
      const retriable = !status || status >= 500;
      if (!retriable || attempt >= maxAttempts) break;

      await sleep(1000 * attempt);
    }
  }

  throw lastError || new Error('Unknown scrape error');
}

async function main() {
  const args = parseArgs(process.argv);

  const base = (args.base || process.env.API_BASE || 'http://localhost:5050').replace(/\/+$/, '');
  const year = toInt(args.year, new Date().getFullYear());
  const limit = Math.max(1, Math.min(200, toInt(args.limit, 50)));
  const forcePublish = String(args['force-publish'] || 'true').toLowerCase();

  const url = new URL(`${base}/api/scrape/run`);
  url.searchParams.set('municipality', 'tirane');
  url.searchParams.set('category', 'Vendime');
  url.searchParams.set('year', String(year));
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('force_publish', forcePublish);

  console.log(`Running Tirane scrape via: ${url.toString()}`);

  try {
    const data = await postJsonWithRetry(url.toString(), 2);
    console.log(
      JSON.stringify(
        {
          ok: data.ok,
          municipality: data.municipality,
          parsed_rows_total: data.parsed_rows_total,
          parsed_rows_kept: data.parsed_rows_kept,
          inserted: data.inserted,
          skipped: data.skipped,
          scraped_from: data.scraped_from,
          force_publish: data.force_publish,
        },
        null,
        2
      )
    );
  } catch (err) {
    const data = err?.data || {};
    const status = err?.status || null;
    const msg = data?.message || err?.message || 'Unknown scrape error';

    console.error(
      JSON.stringify(
        {
          ok: false,
          status,
          error: data?.error || 'scrape_error',
          last_error_type: data?.last_error_type || null,
          message: msg,
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

main();

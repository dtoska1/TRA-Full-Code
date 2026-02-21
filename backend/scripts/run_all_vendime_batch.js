'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const DEFAULTS = {
  year: 2024,
  limit: 50,
  batch: 10,
  sleep_ms: 800,
  resume: true,
  stop_on_error: true,
};

const API_BASE = 'http://localhost:5050';
const PROGRESS_PATH = path.join(__dirname, '..', 'tmp', 'run_all_vendime_progress.json');
const RATE_LIMIT_RETRY_MS = 65000;
const RATE_LIMIT_MAX_RETRIES = 2;

function parseArgs(argv) {
  const out = {};
  for (const token of argv.slice(2)) {
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const eqIdx = body.indexOf('=');
    if (eqIdx === -1) {
      out[body] = true;
      continue;
    }
    out[body.slice(0, eqIdx)] = body.slice(eqIdx + 1);
  }
  return out;
}

function toInt(value, fallback) {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeErrorMessage(message) {
  const raw = String(message || '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!raw) return 'Unknown error';
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <REDACTED>')
    .slice(0, 500);
}

function ensureLocalhostUrl(urlValue) {
  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new Error(`Invalid URL: ${urlValue}`);
  }
  if (parsed.protocol !== 'http:') {
    throw new Error('Only http://localhost is allowed for batch runner');
  }
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error('Batch runner is restricted to localhost targets');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function readProgressFile(progressPath) {
  if (!fs.existsSync(progressPath)) {
    return {
      version: 1,
      created_at_utc: nowIso(),
      updated_at_utc: nowIso(),
      last_run: null,
      municipalities: {},
    };
  }
  try {
    const data = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    if (!data || typeof data !== 'object') throw new Error('invalid json');
    if (!data.municipalities || typeof data.municipalities !== 'object') {
      data.municipalities = {};
    }
    return data;
  } catch {
    return {
      version: 1,
      created_at_utc: nowIso(),
      updated_at_utc: nowIso(),
      last_run: null,
      municipalities: {},
    };
  }
}

function writeProgressFile(progressPath, data) {
  fs.mkdirSync(path.dirname(progressPath), { recursive: true });
  data.updated_at_utc = nowIso();
  fs.writeFileSync(progressPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { ok: false, message: `Non-JSON response: HTTP ${res.status}` };
  }
  return { res, data };
}

async function postScrapeWithRetries({ targetUrl, adminToken, municipalityKey }) {
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt += 1) {
    const { res, data } = await fetchJson(targetUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
    });

    if (res.status !== 429) {
      return { res, data };
    }

    if (attempt >= RATE_LIMIT_MAX_RETRIES) {
      return { res, data };
    }

    const resetRaw = Number.parseInt(String(res.headers.get('ratelimit-reset') || ''), 10);
    const headerWaitMs = Number.isFinite(resetRaw) && resetRaw > 0 ? resetRaw * 1000 : 0;
    const waitMs = Math.max(RATE_LIMIT_RETRY_MS, headerWaitMs);
    console.log(
      `[WARN] ${municipalityKey} hit /api/scrape rate limit (429). Retrying in ${waitMs}ms (${attempt + 1}/${RATE_LIMIT_MAX_RETRIES + 1})`
    );
    await sleep(waitMs);
  }

  return {
    res: { ok: false, status: 429 },
    data: { ok: false, message: 'Too many scrape requests, please try again later.' },
  };
}

async function loadMunicipalities(baseUrl) {
  const { res, data } = await fetchJson(`${baseUrl}/api/municipalities`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok || !data?.ok || !Array.isArray(data.items)) {
    throw new Error(
      sanitizeErrorMessage(data?.message || `Failed to load municipalities (HTTP ${res.status})`)
    );
  }
  return data.items;
}

function buildRunUrl(baseUrl, municipalityKey, year, limit) {
  const url = new URL(`${baseUrl}/api/scrape/run`);
  url.searchParams.set('municipality', String(municipalityKey));
  url.searchParams.set('category', 'Vendime');
  url.searchParams.set('year', String(year));
  url.searchParams.set('limit', String(limit));
  return url.toString();
}

function shouldSkipOnResume(previous, year, limit) {
  if (!previous) return false;
  if (previous.status !== 'ok') return false;
  return Number(previous.year) === Number(year) && Number(previous.limit) === Number(limit);
}

async function run() {
  const args = parseArgs(process.argv);

  const year = Math.max(2000, Math.min(2100, toInt(args.year, DEFAULTS.year)));
  const limit = Math.max(1, Math.min(200, toInt(args.limit, DEFAULTS.limit)));
  const batchSize = Math.max(1, toInt(args.batch, DEFAULTS.batch));
  const sleepMs = Math.max(0, toInt(args.sleep_ms, DEFAULTS.sleep_ms));
  const resume = toBool(args.resume, DEFAULTS.resume);
  const stopOnError = toBool(args.stop_on_error, DEFAULTS.stop_on_error);
  const baseUrl = ensureLocalhostUrl(API_BASE);

  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  if (!adminToken) {
    console.error('ERROR: ADMIN_TOKEN env var is required. Set it in backend/.env before running.');
    process.exit(1);
  }

  const progress = readProgressFile(PROGRESS_PATH);
  progress.last_run = {
    started_at_utc: nowIso(),
    year,
    limit,
    batch: batchSize,
    sleep_ms: sleepMs,
    resume,
    stop_on_error: stopOnError,
    base_url: baseUrl,
  };
  writeProgressFile(PROGRESS_PATH, progress);

  const municipalities = await loadMunicipalities(baseUrl);
  const total = municipalities.length;
  const totalBatches = Math.ceil(total / batchSize);
  let okCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  let stoppedMunicipality = null;

  console.log(`Running Vendime batch ingestion`);
  console.log(`- Target: ${baseUrl}`);
  console.log(`- Municipalities: ${total}`);
  console.log(`- year=${year} limit=${limit} batch=${batchSize} sleep_ms=${sleepMs}`);
  console.log(`- resume=${resume} stop_on_error=${stopOnError}`);
  console.log(`- progress_file=${PROGRESS_PATH}`);

  for (let i = 0; i < municipalities.length; i += 1) {
    const m = municipalities[i];
    const municipalityId = m.id;
    const municipalityName = String(m.name_sq || municipalityId);
    const municipalityKey = String(m.name_key || municipalityId);
    const batchNumber = Math.floor(i / batchSize) + 1;

    if (i % batchSize === 0) {
      console.log(`\nBatch ${batchNumber} / ${totalBatches}`);
    }

    const prev = progress.municipalities[municipalityKey];
    if (resume && shouldSkipOnResume(prev, year, limit)) {
      skippedCount += 1;
      console.log(`[SKIP] ${municipalityKey} (already ok for year=${year}, limit=${limit})`);
      continue;
    }

    const started = Date.now();
    const targetUrl = buildRunUrl(baseUrl, municipalityKey, year, limit);
    try {
      const { res, data } = await postScrapeWithRetries({
        targetUrl,
        adminToken,
        municipalityKey,
      });

      if (!res.ok || !data?.ok) {
        const msg = sanitizeErrorMessage(data?.message || `HTTP ${res.status}`);
        progress.municipalities[municipalityKey] = {
          municipality_id: municipalityId,
          municipality_name: municipalityName,
          status: 'error',
          last_run_utc: nowIso(),
          year,
          limit,
          parsed_rows_total: Number(data?.parsed_rows_total ?? 0),
          parsed_rows_kept: Number(data?.parsed_rows_kept ?? 0),
          inserted: Number(data?.inserted ?? 0),
          published_updated: Number(data?.published_updated ?? 0),
          error_message: msg,
        };
        writeProgressFile(PROGRESS_PATH, progress);
        errorCount += 1;
        console.log(`[ERROR] ${municipalityKey} (${res.status}) ${msg}`);
        if (stopOnError) {
          stoppedMunicipality = municipalityKey;
          break;
        }
      } else {
        const entry = {
          municipality_id: municipalityId,
          municipality_name: municipalityName,
          status: 'ok',
          last_run_utc: nowIso(),
          year,
          limit,
          parsed_rows_total: Number(data.parsed_rows_total ?? 0),
          parsed_rows_kept: Number(data.parsed_rows_kept ?? 0),
          inserted: Number(data.inserted ?? 0),
          published_updated: Number(data.published_updated ?? 0),
          error_message: null,
        };
        progress.municipalities[municipalityKey] = entry;
        writeProgressFile(PROGRESS_PATH, progress);
        okCount += 1;
        console.log(
          `[OK] ${municipalityKey} kept=${entry.parsed_rows_kept} inserted=${entry.inserted} published_updated=${entry.published_updated} ms=${Date.now() - started}`
        );
      }
    } catch (err) {
      const msg = sanitizeErrorMessage(err?.message || 'Request failed');
      progress.municipalities[municipalityKey] = {
        municipality_id: municipalityId,
        municipality_name: municipalityName,
        status: 'error',
        last_run_utc: nowIso(),
        year,
        limit,
        parsed_rows_total: 0,
        parsed_rows_kept: 0,
        inserted: 0,
        published_updated: 0,
        error_message: msg,
      };
      writeProgressFile(PROGRESS_PATH, progress);
      errorCount += 1;
      console.log(`[ERROR] ${municipalityKey} ${msg}`);
      if (stopOnError) {
        stoppedMunicipality = municipalityKey;
        break;
      }
    }

    if (sleepMs > 0 && i < municipalities.length - 1) {
      await sleep(sleepMs);
    }
  }

  progress.last_run.finished_at_utc = nowIso();
  progress.last_run.summary = {
    ok: okCount,
    error: errorCount,
    skipped: skippedCount,
    total,
  };
  writeProgressFile(PROGRESS_PATH, progress);

  console.log('\nDone.');
  console.log(`- ok=${okCount} error=${errorCount} skipped=${skippedCount} total=${total}`);
  console.log(`- progress_file=${PROGRESS_PATH}`);

  if (stoppedMunicipality) {
    console.error(
      `Stopped on error at municipality=${stoppedMunicipality}. Progress saved to ${PROGRESS_PATH}`
    );
  }

  if (errorCount > 0) {
    process.exitCode = 1;
  }
}

run().catch(err => {
  console.error(`Fatal: ${sanitizeErrorMessage(err?.message || String(err))}`);
  process.exit(1);
});

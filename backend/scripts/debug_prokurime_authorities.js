#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { __test: prokTest } = require("../scrapers/prokurimeAppExport");
const { normalizeText } = require("../lib/prokurimeAuthorityMatch");

const AUTHORITY_HEADER_KEYWORDS = [
  "autoriteti kontraktor",
  "autoritet kontraktor",
  "autoriteti kontraktues",
  "autoritet kontraktues",
  "entiteti kontraktor",
  "contracting authority",
  "authority",
];

const TITLE_HEADER_KEYWORDS = [
  "objekti i kontrates",
  "objekti i prokurimit",
  "object of contract",
  "pershkrimi",
  "description",
  "title",
  "objekti",
];

const PROCEDURE_ID_HEADER_KEYWORDS = [
  "reference no",
  "reference number",
  "nr reference",
  "numri i references",
  "id procedure",
  "procedure id",
  "id e procedures",
  "id procedure",
];

function parseArgs(argv) {
  const out = {
    year: 2025,
    csvPath: null,
    timeoutMs: 25000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "");
    if (!arg) continue;

    if (arg.startsWith("--year=")) {
      out.year = Number.parseInt(arg.slice("--year=".length), 10);
      continue;
    }
    if (arg === "--year" && argv[i + 1]) {
      out.year = Number.parseInt(String(argv[i + 1]), 10);
      i += 1;
      continue;
    }

    if (arg.startsWith("--csv=")) {
      out.csvPath = arg.slice("--csv=".length);
      continue;
    }
    if (arg === "--csv" && argv[i + 1]) {
      out.csvPath = String(argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg.startsWith("--timeout-ms=")) {
      out.timeoutMs = Number.parseInt(arg.slice("--timeout-ms=".length), 10);
      continue;
    }
    if (arg === "--timeout-ms" && argv[i + 1]) {
      out.timeoutMs = Number.parseInt(String(argv[i + 1]), 10);
      i += 1;
      continue;
    }
  }

  if (!Number.isInteger(out.year) || out.year < 2000 || out.year > 2100) {
    throw new Error(`Invalid --year value: ${out.year}`);
  }
  if (!Number.isInteger(out.timeoutMs) || out.timeoutMs < 1000) {
    throw new Error(`Invalid --timeout-ms value: ${out.timeoutMs}`);
  }
  return out;
}

function getHeaderEntries(record) {
  return Object.keys(record || {}).map((raw) => ({
    raw,
    normalized: normalizeText(raw),
  }));
}

function getValueByHeaderKeywords(record, headerEntries, keywords) {
  for (const keyword of keywords) {
    const normalizedKeyword = normalizeText(keyword);
    for (const entry of headerEntries) {
      if (!entry.normalized) continue;
      if (!entry.normalized.includes(normalizedKeyword)) continue;
      const value = String(record[entry.raw] || "").trim();
      if (value) return value;
    }
  }
  return "";
}

async function fetchTextWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html, text/csv, application/csv, text/plain;q=0.9, */*;q=0.8",
      },
    });
    const finalUrl = String(response.url || url);
    if (!response.ok) {
      throw new Error(`Fetch failed: ${response.status} ${response.statusText} (${finalUrl})`);
    }
    const text = await response.text();
    return { text, finalUrl };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function printTopAuthorities(authorityCounts) {
  const rows = Array.from(authorityCounts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, 50);

  console.log("");
  console.log("Top 50 authority values (count | authority)");
  for (const [authority, count] of rows) {
    const c = String(count).padStart(6, " ");
    console.log(`${c} | ${authority}`);
  }
}

function printRawSamples(samples) {
  console.log("");
  console.log("20 raw samples (authority | title/objekt | procedure_id)");
  for (const sample of samples.slice(0, 20)) {
    console.log(
      `[row ${sample.row}] ${sample.authority || "(missing authority)"} | ${sample.title || "(missing title)"} | ${sample.procedureId || "(missing procedure id)"}`
    );
  }
}

async function loadCsvRaw({ year, csvPath, timeoutMs }) {
  if (csvPath) {
    const absolutePath = path.isAbsolute(csvPath)
      ? csvPath
      : path.resolve(process.cwd(), csvPath);
    const raw = fs.readFileSync(absolutePath, "utf8");
    return {
      raw,
      sourcePageUrl: null,
      exportCsvUrl: absolutePath,
      source: `local_csv:${absolutePath}`,
    };
  }

  const discovered = await prokTest.discoverExportCsvForYear({
    year,
    fetchImpl: fetch,
    requestTimeoutMs: timeoutMs,
  });
  const csvFetch = await fetchTextWithTimeout(discovered.exportCsvUrl, timeoutMs);
  return {
    raw: csvFetch.text,
    sourcePageUrl: discovered.sourcePageUrl || null,
    exportCsvUrl: csvFetch.finalUrl || discovered.exportCsvUrl,
    source: "app_live_fetch",
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const loaded = await loadCsvRaw(args);
  const parsed = prokTest.parseCsvRecordsStrict(loaded.raw);
  const records = Array.isArray(parsed.records) ? parsed.records : [];

  const authorityCounts = new Map();
  const samples = [];

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const headerEntries = getHeaderEntries(record);
    const authority = getValueByHeaderKeywords(record, headerEntries, AUTHORITY_HEADER_KEYWORDS);
    const title = getValueByHeaderKeywords(record, headerEntries, TITLE_HEADER_KEYWORDS);
    const procedureId = getValueByHeaderKeywords(
      record,
      headerEntries,
      PROCEDURE_ID_HEADER_KEYWORDS
    );

    const authorityKey = authority || "(missing authority)";
    authorityCounts.set(authorityKey, (authorityCounts.get(authorityKey) || 0) + 1);

    if (samples.length < 20) {
      samples.push({
        row: i + 1,
        authority,
        title,
        procedureId,
      });
    }
  }

  console.log(`Source: ${loaded.source}`);
  console.log(`Year: ${args.year}`);
  if (loaded.sourcePageUrl) console.log(`Source page: ${loaded.sourcePageUrl}`);
  console.log(`CSV URL/path: ${loaded.exportCsvUrl}`);
  console.log(`Parsed rows: ${records.length}`);
  console.log(`Distinct authority values: ${authorityCounts.size}`);

  printTopAuthorities(authorityCounts);
  printRawSamples(samples);
}

run().catch((err) => {
  console.error("debug_prokurime_authorities failed:", String(err?.message || err));
  process.exit(1);
});

"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { Pool } = require("pg");

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function toBool(v, def) {
  if (v === undefined) return def;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return def;
}

function toInt(v, def) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : def;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function parseOnly(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function extractErrorType(data) {
  return (
    data?.last_error_type ||
    data?.error_type ||
    data?.error ||
    data?.message ||
    "-"
  );
}

function extractKept(data) {
  return num(data?.parsed_rows_kept, num(data?.kept, 0));
}

function extractInserted(data) {
  return num(data?.inserted, 0);
}

function extractScrapedFrom(data) {
  return data?.scraped_from || data?.source_url || "-";
}

function classifyOutcome(result) {
  if (result.bucket === "fetch_failed_or_http_error") return result.bucket;

  if (result.ok === true) {
    return result.kept > 0 ? "success_kept_gt_0" : "ok_but_zero_kept";
  }

  const t = String(result.last_error_type || "").toUpperCase();
  if (t === "CONFIG_MISSING_URL") return "config_missing_url";
  if (t.includes("FETCH") || t.includes("HTTP")) return "fetch_failed_or_http_error";
  return "other_error";
}

async function postJson(url) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json" },
  });

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { ok: false, error: "NON_JSON_RESPONSE", raw: text };
  }

  return { status: res.status, okHttp: res.ok, data };
}

async function main() {
  const args = parseArgs(process.argv);
  const limitMunicipalities = Math.max(1, toInt(args.limitMunicipalities, 10));
  const only = parseOnly(args.only);
  const shuffle = toBool(args.shuffle, true);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL is not set.");
    process.exit(1);
  }

  const apiBase = "http://localhost:5050";
  const pool = new Pool({ connectionString: databaseUrl });

  let allKeys = [];
  try {
    const allResult = await pool.query(
      "SELECT name_key FROM municipalities ORDER BY name_key ASC",
      []
    );
    allKeys = allResult.rows.map((r) => String(r.name_key));

    if (allKeys.length !== 61) {
      console.error(`WARN: expected 61 municipalities, got ${allKeys.length}`);
    }

    let selected = [];
    if (only.length > 0) {
      const onlyResult = await pool.query(
        "SELECT name_key FROM municipalities WHERE name_key = ANY($1::text[]) ORDER BY name_key ASC",
        [only]
      );
      selected = onlyResult.rows.map((r) => String(r.name_key));
    } else {
      selected = [...allKeys];
    }

    if (shuffle) shuffleInPlace(selected);
    selected = selected.slice(0, limitMunicipalities);

    if (selected.length === 0) {
      console.error("No municipalities selected. Nothing to run.");
      process.exit(1);
    }

    const summary = {
      success_kept_gt_0: 0,
      ok_but_zero_kept: 0,
      config_missing_url: 0,
      fetch_failed_or_http_error: 0,
      other_error: 0,
    };

    for (const nameKey of selected) {
      const url = new URL(`${apiBase}/api/scrape/run`);
      url.searchParams.set("municipality", nameKey);
      url.searchParams.set("category", "Vendime");
      url.searchParams.set("year", "2026");
      url.searchParams.set("limit", "5");

      let line = {
        name_key: nameKey,
        ok: false,
        kept: 0,
        inserted: 0,
        last_error_type: "-",
        scraped_from: "-",
        bucket: "other_error",
      };

      try {
        const response = await postJson(url.toString());

        if (!response.okHttp) {
          line.bucket = "fetch_failed_or_http_error";
          line.last_error_type = extractErrorType(response.data);
        } else {
          const data = response.data || {};
          line.ok = Boolean(data.ok);
          line.kept = extractKept(data);
          line.inserted = extractInserted(data);
          line.last_error_type = extractErrorType(data);
          line.scraped_from = extractScrapedFrom(data);
          line.bucket = classifyOutcome(line);
        }
      } catch (err) {
        line.bucket = "fetch_failed_or_http_error";
        line.last_error_type = err?.code || err?.name || "FETCH_FAILED_OR_HTTP_ERROR";
      }

      summary[line.bucket] += 1;

      const errorOut = line.last_error_type || "-";
      const scrapedOut = line.scraped_from || "-";
      console.log(
        `${line.name_key} | ${line.ok} | ${line.kept} | ${line.inserted} | ${errorOut} | ${scrapedOut}`
      );
    }

    console.log("\nSummary:");
    console.log(`success_kept_gt_0: ${summary.success_kept_gt_0}`);
    console.log(`ok_but_zero_kept: ${summary.ok_but_zero_kept}`);
    console.log(`config_missing_url: ${summary.config_missing_url}`);
    console.log(`fetch_failed_or_http_error: ${summary.fetch_failed_or_http_error}`);
    console.log(`other_error: ${summary.other_error}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Fatal:", err?.message || err);
  process.exit(1);
});

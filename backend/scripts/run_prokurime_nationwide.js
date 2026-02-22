#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const API_BASE = process.env.API_BASE || process.env.SMOKE_BASE_URL || "http://localhost:5050";

function parseArgs(argv) {
  const out = {};
  for (const token of argv.slice(2)) {
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    const eqIdx = body.indexOf("=");
    if (eqIdx === -1) out[body] = true;
    else out[body.slice(0, eqIdx)] = body.slice(eqIdx + 1);
  }
  return out;
}

function toInt(value, fallback) {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function readProgress(progressPath) {
  if (!fs.existsSync(progressPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(progressPath, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function writeProgress(progressPath, payload) {
  fs.mkdirSync(path.dirname(progressPath), { recursive: true });
  fs.writeFileSync(progressPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function sanitizeMessage(message) {
  const raw = String(message || "").replace(/[\r\n\t]+/g, " ").trim();
  return raw.slice(0, 400);
}

async function run() {
  const args = parseArgs(process.argv);
  const year = Math.max(2000, Math.min(2100, toInt(args.year, new Date().getUTCFullYear())));
  const limit = Math.max(1, Math.min(500, toInt(args.limit, 500)));
  const hasStartOffset = Object.prototype.hasOwnProperty.call(args, "start_offset");
  const explicitStartOffset = Math.max(0, toInt(args.start_offset, 0));
  const adminToken = String(process.env.ADMIN_TOKEN || "").trim();

  if (!adminToken) {
    console.error("ERROR: ADMIN_TOKEN env var is required. Set it in backend/.env before running.");
    process.exit(1);
  }

  const progressPath = path.join(__dirname, "..", "tmp", `prokurime_progress_${year}.json`);
  const existingProgress = readProgress(progressPath);

  let offset = hasStartOffset
    ? explicitStartOffset
    : Math.max(0, toInt(existingProgress?.next_offset, toInt(existingProgress?.last_offset, 0)));

  let totalInserted = hasStartOffset ? 0 : Math.max(0, toInt(existingProgress?.total_inserted, 0));
  let totalMatched = hasStartOffset ? 0 : Math.max(0, toInt(existingProgress?.total_matched, 0));

  if (existingProgress?.next_offset === null && !hasStartOffset) {
    console.log(`year=${year} already complete (next_offset=null) progress_file=${progressPath}`);
    return;
  }

  while (true) {
    const url = new URL(`${API_BASE}/api/scrape/run`);
    url.searchParams.set("category", "Prokurime");
    url.searchParams.set("year", String(year));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(limit));

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
    });

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${response.status}: Non-JSON response`);
    }

    if (!response.ok || !payload?.ok) {
      throw new Error(`HTTP ${response.status}: ${sanitizeMessage(payload?.message || payload?.error || "Request failed")}`);
    }

    const inserted = Math.max(0, toInt(payload.inserted, 0));
    const matched = Math.max(0, toInt(payload.matched_rows_total, 0));
    const nextOffset = payload.next_offset === null ? null : Math.max(0, toInt(payload.next_offset, 0));

    totalInserted += inserted;
    totalMatched += matched;

    writeProgress(progressPath, {
      year,
      last_offset: offset,
      next_offset: nextOffset,
      total_inserted: totalInserted,
      total_matched: totalMatched,
      updatedAt: nowIso(),
    });

    console.log(
      `year=${year} offset=${offset} limit=${limit} inserted=${inserted} matched=${matched} total_inserted=${totalInserted} total_matched=${totalMatched} next_offset=${nextOffset === null ? "null" : nextOffset}`
    );

    if (nextOffset === null) {
      break;
    }

    offset = nextOffset;
  }
}

run().catch((error) => {
  console.error(`ERROR: ${sanitizeMessage(error?.message || error)}`);
  process.exit(1);
});

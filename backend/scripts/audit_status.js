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

const BEGIN_MARKER = "<!-- BEGIN AUTO-GENERATED STATUS -->";
const END_MARKER = "<!-- END AUTO-GENERATED STATUS -->";
const DOWN_ERROR_TYPES = new Set([
  "UPSTREAM_DOWN",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function norm(v) {
  return String(v || "").trim().toUpperCase();
}

function isMissingUrl(v) {
  return !String(v || "").trim();
}

function classify(row) {
  const homepageStatus = norm(row.homepage_status);
  const lastErrorType = norm(row.last_error_type);

  if (homepageStatus === "BLOCKED" || lastErrorType === "HTTP_403") return "BLOCKED";
  if (homepageStatus === "DOWN" || DOWN_ERROR_TYPES.has(lastErrorType)) return "DOWN";
  if (homepageStatus === "ERROR" || lastErrorType === "TIMEOUT") return "ERROR";
  if (isMissingUrl(row.vendime_url)) return "UNKNOWN";
  return "OK";
}

function formatTs(value) {
  if (!value) return "-";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toISOString();
}

function buildGeneratedContent(rows, counts, generatedAtUtc) {
  const blocked = rows.filter((r) => r.status === "BLOCKED");
  const down = rows.filter((r) => r.status === "DOWN");

  const lines = [];
  lines.push("## Automated status (generated)");
  lines.push(BEGIN_MARKER);
  lines.push(`Generated at (UTC): ${generatedAtUtc}`);
  lines.push("");
  lines.push("Counts:");
  lines.push(`- OK: ${counts.OK}`);
  lines.push(`- BLOCKED: ${counts.BLOCKED}`);
  lines.push(`- DOWN: ${counts.DOWN}`);
  lines.push(`- ERROR: ${counts.ERROR}`);
  lines.push(`- UNKNOWN: ${counts.UNKNOWN}`);
  lines.push("");
  lines.push("Blocked municipalities:");

  if (blocked.length === 0) {
    lines.push("- None");
  } else {
    for (const r of blocked) {
      lines.push(
        `- ${r.name_key} | url: ${r.vendime_url || "-"} | cooldown_until_utc: ${formatTs(
          r.cooldown_until_utc
        )}`
      );
    }
  }

  if (down.length > 0) {
    lines.push("");
    lines.push("Down municipalities:");
    for (const r of down) {
      lines.push(
        `- ${r.name_key} | last_error_type: ${r.last_error_type || "-"} | homepage_status: ${
          r.homepage_status || "-"
        } | url: ${r.vendime_url || "-"}`
      );
    }
  }

  lines.push(END_MARKER);
  lines.push("");
  return lines.join("\n");
}

function upsertGeneratedSection(existing, generatedBlock) {
  const start = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);

  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + END_MARKER.length);

    const generatedInnerStart = generatedBlock.indexOf(BEGIN_MARKER);
    const generatedInnerEnd = generatedBlock.indexOf(END_MARKER);
    const replacement = generatedBlock.slice(generatedInnerStart, generatedInnerEnd + END_MARKER.length);

    const normalizedBefore = before.endsWith("\n") ? before : `${before}\n`;
    const normalizedAfter = after.startsWith("\n") ? after : `\n${after}`;
    return `${normalizedBefore}${replacement}${normalizedAfter}`.replace(/\n{3,}/g, "\n\n");
  }

  const base = existing.trimEnd();
  if (!base) return generatedBlock;
  return `${base}\n\n${generatedBlock}`;
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    const query = `
      SELECT
        m.name_key,
        sr.vendime_url,
        sr.homepage_status,
        sr.last_error_type,
        sr.last_checked_utc,
        sr.cooldown_until_utc,
        sr.feasibility
      FROM municipalities m
      LEFT JOIN LATERAL (
        SELECT
          vendime_url,
          homepage_status,
          last_error_type,
          last_checked_utc,
          cooldown_until_utc,
          feasibility
        FROM source_registry sr
        WHERE sr.municipality_id = m.id
          AND sr.is_primary = TRUE
        ORDER BY sr.updated_at DESC
        LIMIT 1
      ) sr ON TRUE
      ORDER BY m.name_key ASC;
    `;

    const result = await pool.query(query);
    const rows = result.rows.map((row) => ({
      ...row,
      status: classify(row),
    }));

    const counts = { OK: 0, BLOCKED: 0, DOWN: 0, ERROR: 0, UNKNOWN: 0 };
    for (const row of rows) counts[row.status] += 1;

    const blocked = rows.filter((r) => r.status === "BLOCKED");
    const generatedAtUtc = new Date().toISOString();

    console.log("Vendime source status summary");
    console.log(`Generated at (UTC): ${generatedAtUtc}`);
    console.log(`Total municipalities: ${rows.length}`);
    console.log(`OK: ${counts.OK}`);
    console.log(`BLOCKED: ${counts.BLOCKED}`);
    console.log(`DOWN: ${counts.DOWN}`);
    console.log(`ERROR: ${counts.ERROR}`);
    console.log(`UNKNOWN: ${counts.UNKNOWN}`);
    console.log("");
    console.log("Blocked municipalities:");
    if (blocked.length === 0) {
      console.log("- None");
    } else {
      for (const row of blocked) {
        console.log(
          `- ${row.name_key} | ${row.vendime_url || "-"} | cooldown_until_utc=${formatTs(
            row.cooldown_until_utc
          )}`
        );
      }
    }

    const generatedBlock = buildGeneratedContent(rows, counts, generatedAtUtc);

    const statusPath = path.join(__dirname, "..", "..", "docs", "STATUS.md");
    const existing = fs.existsSync(statusPath) ? fs.readFileSync(statusPath, "utf8") : "";
    const next = upsertGeneratedSection(existing, generatedBlock);
    fs.writeFileSync(statusPath, next, "utf8");

    console.log("");
    console.log(`Updated ${statusPath}`);
    process.exit(0);
  } catch (err) {
    console.error("ERROR:", err?.message || err);
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

"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { fetchVendimeStatusSummary } = require("../lib/vendimeStatus");

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
function formatTs(value) {
  if (!value) return "-";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toISOString();
}

function buildGeneratedContent(summary) {
  const blocked = summary.blocked;
  const down = summary.down;
  const counts = summary.counts;

  const lines = [];
  lines.push("## Automated status (generated)");
  lines.push(BEGIN_MARKER);
  lines.push(`Generated at (UTC): ${summary.generated_at_utc}`);
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
        `- ${r.name_key} | url: ${r.url || "-"} | cooldown_until_utc: ${formatTs(
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
        } | url: ${r.url || "-"}`
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
    const generatedAtUtc = new Date().toISOString();
    const summary = await fetchVendimeStatusSummary(pool, generatedAtUtc);
    const counts = summary.counts;
    const blocked = summary.blocked;

    console.log("Vendime source status summary");
    console.log(`Generated at (UTC): ${summary.generated_at_utc}`);
    console.log(`Total municipalities: ${summary.total}`);
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
          `- ${row.name_key} | ${row.url || "-"} | cooldown_until_utc=${formatTs(
            row.cooldown_until_utc
          )}`
        );
      }
    }

    const generatedBlock = buildGeneratedContent(summary);

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

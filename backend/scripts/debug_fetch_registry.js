"use strict";

require("dotenv").config();
const cheerio = require("cheerio");
const { Pool } = require("pg");

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function usageAndExit(message) {
  if (message) console.error(`ERROR: ${message}`);
  console.error(
    "Usage: node scripts/debug_fetch_registry.js --municipality=<name_key> [--category=Vendime]"
  );
  process.exit(1);
}

function normalizeCategory(value) {
  return String(value || "Vendime").trim();
}

async function fetchHtmlLikeScraper(url) {
  const headersA = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "sq-AL,sq;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };

  let res = await fetch(url, { headers: headersA, redirect: "follow" });

  if (res.status === 406 || res.status === 403) {
    const headersB = {
      ...headersA,
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    };
    res = await fetch(url, { headers: headersB, redirect: "follow" });
  }

  const arrayBuffer = await res.arrayBuffer();
  const html = Buffer.from(arrayBuffer).toString("utf8");
  return { res, html };
}

async function main() {
  const args = parseArgs(process.argv);
  const municipalityKey = String(args.municipality || "").trim().toLowerCase();
  const category = normalizeCategory(args.category);

  if (!municipalityKey) usageAndExit("Missing --municipality=<name_key>");
  if (category.toLowerCase() !== "vendime") {
    usageAndExit("Only --category=Vendime is supported currently");
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL is not set (check backend/.env)");
    process.exit(2);
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const query = `
      SELECT
        m.id AS municipality_id,
        m.name_sq,
        m.name_key,
        sr.id AS source_registry_id,
        sr.vendime_url
      FROM municipalities m
      JOIN source_registry sr ON sr.municipality_id = m.id
      WHERE sr.is_primary = TRUE
        AND m.name_key = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(query, [municipalityKey]);
    if (!rows.length) {
      console.error(
        `ERROR: No primary source_registry row found for municipality name_key='${municipalityKey}'`
      );
      process.exit(1);
    }

    const row = rows[0];
    const targetUrl = String(row.vendime_url || "").trim();

    console.log("Primary row:");
    console.log(`  municipality: ${row.name_sq} (${row.name_key})`);
    console.log(`  municipality_id: ${row.municipality_id}`);
    console.log(`  source_registry_id: ${row.source_registry_id}`);
    console.log(`  category: ${category}`);
    console.log(`Resolved target URL (vendime_url): ${targetUrl || "<empty>"}`);

    if (!targetUrl) {
      console.error("ERROR: vendime_url is empty on primary registry row");
      process.exit(1);
    }

    const { res, html } = await fetchHtmlLikeScraper(targetUrl);

    console.log("\nFetch result:");
    console.log(`  status: ${res.status} ${res.statusText}`);
    console.log(`  final_url: ${res.url}`);
    console.log(`  content_type: ${res.headers.get("content-type") || "<missing>"}`);
    console.log(`  html_length: ${html.length}`);

    const $ = cheerio.load(html);
    const links = [];
    const candidateLinks = [];
    const seenCandidateHrefs = new Set();
    $("a[href]").each((_, el) => {
      const href = ($(el).attr("href") || "").trim();
      const text = $(el).text().replace(/\s+/g, " ").trim();

      if (links.length < 10) {
        links.push({ text, href });
      }

      if (href && candidateLinks.length < 30) {
        const hrefLow = href.toLowerCase();
        const textLow = text.toLowerCase();
        const isCandidate =
          /\.(pdf|doc|docx|zip|rar)(\?|#|$)/i.test(href) ||
          hrefLow.includes("wp-content/uploads") ||
          hrefLow.includes("download") ||
          hrefLow.includes("vendim") ||
          textLow.includes("vendim");

        if (isCandidate && !seenCandidateHrefs.has(href)) {
          seenCandidateHrefs.add(href);
          candidateLinks.push({ text, href });
        }
      }

      if (links.length >= 10 && candidateLinks.length >= 30) return false;
      return undefined;
    });

    console.log("\nFirst 10 <a> links (text + href):");
    if (!links.length) {
      console.log("  <no links found>");
    } else {
      for (let i = 0; i < links.length; i++) {
        const item = links[i];
        console.log(`  ${i + 1}. text="${item.text}" href="${item.href}"`);
      }
    }

    console.log("\nCandidate document links:");
    if (!candidateLinks.length) {
      console.log("  <no candidate links found>");
    } else {
      for (let i = 0; i < candidateLinks.length; i++) {
        const item = candidateLinks[i];
        console.log(`  ${i + 1}. text="${item.text}" href="${item.href}"`);
      }
    }
  } catch (err) {
    console.error("ERROR:");
    console.error(`  name: ${err?.name || "<unknown>"}`);
    console.error(`  message: ${err?.message || String(err)}`);
    if (err?.cause) {
      if (err.cause.code) console.error(`  cause.code: ${err.cause.code}`);
      if (err.cause.message) console.error(`  cause.message: ${err.cause.message}`);
    }
    process.exit(2);
  } finally {
    try {
      await pool.end();
    } catch {}
  }
}

main();

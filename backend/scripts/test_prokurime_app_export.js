#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {
  scrapeProkurimeAppExport,
  buildProkurimeAppDedupKey,
  __test: prokTest,
} = require("../scrapers/prokurimeAppExport");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function fixtureText(name) {
  const fixturePath = path.join(__dirname, "..", "test", "fixtures", name);
  return fs.readFileSync(fixturePath, "utf8");
}

function makeFakeResponse(status, url, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERROR",
    url,
    async text() {
      return text;
    },
  };
}

async function run() {
  const sqHtml = fixtureText("app_export_page_sq.html");
  const enHtml = fixtureText("app_export_page_en.html");
  const csvRaw = fixtureText("app_export_sample_2025.csv");

  const sqCsvUrl = prokTest.discoverYearCsvUrlFromHtml({
    html: sqHtml,
    pageUrl: "https://www.app.gov.al/eksportimi-i-procedurave-te-publikuara/",
    year: 2024,
  });
  assert(
    sqCsvUrl === "https://www.app.gov.al/GetData/ExportDocument?year=2024",
    `SQ year link extraction failed: ${sqCsvUrl}`
  );

  const enCsvUrl = prokTest.discoverYearCsvUrlFromHtml({
    html: enHtml,
    pageUrl: "https://www.app.gov.al/export-public-calls/",
    year: 2025,
  });
  assert(
    enCsvUrl === "https://www.app.gov.al/GetData/ExportDocument?year=2025",
    `EN year link extraction failed: ${enCsvUrl}`
  );

  const parsed = prokTest.parseCsvRecordsStrict(`\uFEFF${csvRaw}`);
  assert(parsed.records.length === 3, `Expected 3 CSV records, got ${parsed.records.length}`);
  assert(
    parsed.records[0]["Objekti i Kontratës"] === "Furnizim, sherbime",
    "Quoted CSV field parsing failed"
  );

  const fakeFetch = async (url) => {
    const normalizedUrl = String(url || "");
    if (
      normalizedUrl === "https://www.app.gov.al/eksportimi-i-procedurave-te-publikuara/" ||
      normalizedUrl === "https://www.app.gov.al/eksportimi-i-procedurave-te-publikuara"
    ) {
      return makeFakeResponse(
        200,
        "https://www.app.gov.al/eksportimi-i-procedurave-te-publikuara/",
        sqHtml
      );
    }
    if (
      normalizedUrl === "https://www.app.gov.al/export-public-calls/" ||
      normalizedUrl === "https://www.app.gov.al/export-public-calls"
    ) {
      return makeFakeResponse(200, "https://www.app.gov.al/export-public-calls/", enHtml);
    }
    if (normalizedUrl === "https://www.app.gov.al/GetData/ExportDocument?year=2025") {
      return makeFakeResponse(200, normalizedUrl, `\uFEFF${csvRaw}`);
    }

    return makeFakeResponse(404, normalizedUrl, "not found");
  };

  const result = await scrapeProkurimeAppExport({
    year: 2025,
    limit: 50,
    municipalityContext: {
      nameKey: "tirane",
      nameSq: "Tirane",
      aliasKeys: ["tirana"],
    },
    fetchImpl: fakeFetch,
    requestTimeoutMs: 5000,
  });

  assert(result.meta.rows_total === 3, `rows_total mismatch: ${result.meta.rows_total}`);
  assert(result.meta.rows_matched === 2, `rows_matched mismatch: ${result.meta.rows_matched}`);
  assert(
    result.meta.skipped_no_municipality_match === 1,
    `skipped_no_municipality_match mismatch: ${result.meta.skipped_no_municipality_match}`
  );
  assert(
    result.meta.source_page_url === "https://www.app.gov.al/export-public-calls/",
    `source_page_url mismatch: ${result.meta.source_page_url}`
  );
  assert(
    result.meta.export_csv_url === "https://www.app.gov.al/GetData/ExportDocument?year=2025",
    `export_csv_url mismatch: ${result.meta.export_csv_url}`
  );
  assert(result.items.length === 2, `Expected 2 matched items, got ${result.items.length}`);
  assert(
    result.items[0].source_url === "https://www.app.gov.al/details/123",
    `Detail URL mapping failed: ${result.items[0].source_url}`
  );
  assert(
    result.items[1].source_url === "https://www.app.gov.al/GetData/ExportDocument?year=2025",
    `Fallback source_url mapping failed: ${result.items[1].source_url}`
  );
  const dedupFromRefA = buildProkurimeAppDedupKey({
    year: 2024,
    municipalityId: "municipality-1",
    procedureId: "REF-11111-01-01-2024",
    publishedDate: "2024-01-01",
    title: "Procurement title",
    titleNormalized: "procurement title",
  });
  const dedupFromRefB = buildProkurimeAppDedupKey({
    year: 2024,
    municipalityId: "municipality-1",
    procedureId: "REF-22222-01-01-2024",
    publishedDate: "2024-01-01",
    title: "Procurement title",
    titleNormalized: "procurement title",
  });
  assert(
    dedupFromRefA !== dedupFromRefB,
    `Different procedure_id values must produce different dedup keys (${dedupFromRefA} vs ${dedupFromRefB})`
  );

  console.log("Prokurime APP export parser tests passed.");
}

run().catch((err) => {
  console.error("Prokurime APP export parser tests failed:", err.message);
  process.exit(1);
});

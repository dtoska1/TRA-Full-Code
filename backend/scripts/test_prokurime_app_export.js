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
  const fallbackCsvRaw = [
    "Autoriteti_kontraktues,Reference No,Object of Contract,Date of Publication,Details",
    "Bashkia Tirane,REF-PRIMARY-01-01-2024,Primary municipality row,01.01.2024,https://www.app.gov.al/details/primary",
    "Ndermarrja e Sherbimeve Publike Berat,REF-FALLBACK-02-01-2024,Fallback municipality row,02.01.2024,https://www.app.gov.al/details/fallback",
    "Drejtoria e Policise Qarkut Korce,REF-SHOULD-SKIP-03-01-2024,Unsafe suffix-only row,03.01.2024,https://www.app.gov.al/details/skip",
  ].join("\n");

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

  const semicolonCsv = [
    "Autoriteti Kontraktor;Vlera e fondit;Monedha",
    "Bashkia Tirane;1.234,56;ALL",
  ].join("\n");
  const parsedSemicolon = prokTest.parseCsvRecordsStrict(semicolonCsv);
  assert(
    parsedSemicolon.records.length === 1,
    `Expected 1 semicolon CSV record, got ${parsedSemicolon.records.length}`
  );
  assert(
    parsedSemicolon.records[0]["Vlera e fondit"] === "1.234,56",
    "Semicolon delimiter CSV parsing failed"
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
    if (normalizedUrl === "https://www.app.gov.al/GetData/ExportDocument?year=2024") {
      return makeFakeResponse(200, normalizedUrl, `\uFEFF${fallbackCsvRaw}`);
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
    result.meta.rows_matched_primary === 2,
    `rows_matched_primary mismatch: ${result.meta.rows_matched_primary}`
  );
  assert(
    result.meta.rows_matched_fallback_local_operator === 0,
    `rows_matched_fallback_local_operator mismatch: ${result.meta.rows_matched_fallback_local_operator}`
  );
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

  const fallbackResult = await scrapeProkurimeAppExport({
    year: 2024,
    limit: 50,
    municipalityContexts: [
      {
        nameKey: "tirane",
        nameSq: "Tirane",
        aliasKeys: ["tirana"],
      },
      {
        nameKey: "berat",
        nameSq: "Berat",
        aliasKeys: [],
      },
      {
        nameKey: "korce",
        nameSq: "Korce",
        aliasKeys: [],
      },
    ],
    fetchImpl: fakeFetch,
    requestTimeoutMs: 5000,
  });
  assert(
    fallbackResult.meta.rows_total === 3,
    `fallback rows_total mismatch: ${fallbackResult.meta.rows_total}`
  );
  assert(
    fallbackResult.meta.rows_matched === 2,
    `fallback rows_matched mismatch: ${fallbackResult.meta.rows_matched}`
  );
  assert(
    fallbackResult.meta.rows_matched_primary === 1,
    `fallback rows_matched_primary mismatch: ${fallbackResult.meta.rows_matched_primary}`
  );
  assert(
    fallbackResult.meta.rows_matched_fallback_local_operator === 1,
    `fallback rows_matched_fallback_local_operator mismatch: ${fallbackResult.meta.rows_matched_fallback_local_operator}`
  );
  assert(
    fallbackResult.meta.skipped_no_municipality_match === 1,
    `fallback skipped_no_municipality_match mismatch: ${fallbackResult.meta.skipped_no_municipality_match}`
  );
  assert(
    fallbackResult.items.length === 2,
    `Expected 2 fallback scenario items, got ${fallbackResult.items.length}`
  );
  assert(
    fallbackResult.items.some((item) => item.municipality_name_key === "berat"),
    "Expected fallback-local-operator match for Berat"
  );
  assert(
    !fallbackResult.items.some((item) => item.municipality_name_key === "korce"),
    "Non-whitelisted suffix-only authority should not match"
  );

  console.log("Prokurime APP export parser tests passed.");
}

run().catch((err) => {
  console.error("Prokurime APP export parser tests failed:", err.message);
  process.exit(1);
});

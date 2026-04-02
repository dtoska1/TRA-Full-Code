"use strict";

const { parseCsvRecordsStrict, normalizeProcedureId } = require("../scrapers/prokurimeAppExport");

const PROKURIME_AMOUNT_HEADER_KEYWORDS = [
  "vlera",
  "vlera e fondit",
  "fondi limit",
  "fondi limit i kontrates",
  "contract value",
  "estimated value",
  "value",
  "cmimi",
];
const PROKURIME_CURRENCY_HEADER_KEYWORDS = ["monedha", "currency", "valuta"];
const PROKURIME_SUPPLIER_HEADER_KEYWORDS = [
  "operatori ekonomik",
  "fituesi",
  "furnitori",
  "supplier",
  "economic operator",
  "contractor",
];
const PROKURIME_CPV_HEADER_KEYWORDS = ["cpv", "cpv code", "kodi cpv", "kode cpv"];
const PROKURIME_PROCEDURE_HEADER_KEYWORDS = [
  "numri i references",
  "nr reference",
  "reference number",
  "procedure id",
  "id procedure",
];
const PROKURIME_AUTHORITY_HEADER_KEYWORDS = [
  "autoriteti kontraktor",
  "autoritet kontraktor",
  "autoriteti kontraktues",
  "autoritet kontraktues",
  "emri i autoritetit kontraktor",
  "emri i autoritetit kontraktues",
  "contracting authority",
  "authority",
];
const PROKURIME_PROCEDURE_TYPE_HEADER_KEYWORDS = [
  "lloji i procedures",
  "lloji i prokurimit",
  "procedure type",
  "type of procedure",
];

let optionalColumnsPromise = null;

function normalizeHeaderToken(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeComparableTitle(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getRecordValueByHeaderKeywords(record, headerKeywords) {
  if (!record || typeof record !== "object") return "";
  const headerEntries = Object.keys(record).map((raw) => ({
    raw,
    normalized: normalizeHeaderToken(raw),
  }));
  for (const keyword of headerKeywords) {
    const keywordNormalized = normalizeHeaderToken(keyword);
    if (!keywordNormalized) continue;
    for (const entry of headerEntries) {
      if (!entry.normalized || !entry.normalized.includes(keywordNormalized)) continue;
      const value = String(record[entry.raw] || "").trim();
      if (value) return value;
    }
  }
  return "";
}

function parseKnownDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const yyyy = Number(match[1]);
    const mm = Number(match[2]);
    const dd = Number(match[3]);
    const date = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (
      date.getUTCFullYear() === yyyy &&
      date.getUTCMonth() === mm - 1 &&
      date.getUTCDate() === dd
    ) {
      return `${match[1]}-${match[2]}-${match[3]}`;
    }
    return null;
  }

  match = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!match) return null;

  const dd = Number(match[1]);
  const mm = Number(match[2]);
  const yyyy = Number(match[3]);
  const date = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (
    date.getUTCFullYear() === yyyy &&
    date.getUTCMonth() === mm - 1 &&
    date.getUTCDate() === dd
  ) {
    return `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }
  return null;
}

function parseAppExportDocumentUrl(sourceUrl) {
  const out = {
    isExportDocument: false,
    exportUrl: null,
    procedureHint: null,
  };
  const raw = String(sourceUrl || "").trim();
  if (!raw) return out;

  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    return out;
  }

  const host = String(parsed.hostname || "").toLowerCase();
  const pathName = String(parsed.pathname || "").toLowerCase();
  if (!host.endsWith("app.gov.al") || pathName !== "/getdata/exportdocument") {
    return out;
  }

  const hashRaw = String(parsed.hash || "").replace(/^#/, "");
  let procedureHint = null;
  if (hashRaw) {
    const params = new URLSearchParams(hashRaw);
    procedureHint = params.get("procedure");
    if (!procedureHint && hashRaw.toLowerCase().startsWith("procedure=")) {
      procedureHint = hashRaw.slice("procedure=".length);
    }
  }

  parsed.hash = "";
  out.isExportDocument = true;
  out.exportUrl = parsed.toString();
  out.procedureHint = normalizeProcedureId(procedureHint || "");
  return out;
}

function isLikelyCsvResponse({ contentType, bodyText }) {
  const contentTypeNormalized = String(contentType || "").toLowerCase();
  if (contentTypeNormalized.includes("text/html")) return false;
  if (
    contentTypeNormalized.includes("text/csv") ||
    contentTypeNormalized.includes("application/csv") ||
    contentTypeNormalized.includes("text/plain") ||
    contentTypeNormalized.includes("application/octet-stream")
  ) {
    return true;
  }

  const head = String(bodyText || "")
    .slice(0, 200)
    .trim()
    .toLowerCase();
  if (!head) return false;
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return false;
  return true;
}

function parseAmountValue(raw) {
  const source = String(raw || "").trim();
  if (!source) return null;

  let clean = source.replace(/\s+/g, "").replace(/[^0-9,.\-]/g, "");
  if (!clean) return null;

  const isNegative = clean.startsWith("-");
  clean = clean.replace(/-/g, "");
  if (!clean) return null;

  const lastComma = clean.lastIndexOf(",");
  const lastDot = clean.lastIndexOf(".");
  let normalized = clean;

  if (lastComma !== -1 && lastDot !== -1) {
    const decimalSeparator = lastDot > lastComma ? "." : ",";
    const thousandsSeparator = decimalSeparator === "." ? "," : ".";
    normalized = clean.split(thousandsSeparator).join("");
    if (decimalSeparator === ",") {
      normalized = normalized.replace(/,/g, ".");
    }
  } else if (lastComma !== -1) {
    const fractionDigits = clean.length - lastComma - 1;
    if (fractionDigits >= 1 && fractionDigits <= 2) {
      normalized = `${clean.slice(0, lastComma).replace(/,/g, "")}.${clean.slice(lastComma + 1)}`;
    } else {
      normalized = clean.replace(/,/g, "");
    }
  } else if (lastDot !== -1) {
    const fractionDigits = clean.length - lastDot - 1;
    if (fractionDigits >= 1 && fractionDigits <= 2) {
      normalized = `${clean.slice(0, lastDot).replace(/\./g, "")}.${clean.slice(lastDot + 1)}`;
    } else {
      normalized = clean.replace(/\./g, "");
    }
  }

  const numericValue = Number.parseFloat(`${isNegative ? "-" : ""}${normalized}`);
  if (!Number.isFinite(numericValue)) return null;
  return Math.round(numericValue * 100) / 100;
}

function detectAmountCurrency({ rawAmount, rawCurrency }) {
  const currencyRaw = String(rawCurrency || "").trim();
  const combined = `${currencyRaw} ${String(rawAmount || "")}`.toLowerCase();
  const normalizedCurrency = normalizeHeaderToken(currencyRaw);

  if (normalizedCurrency) {
    if (normalizedCurrency.includes("eur")) return "EUR";
    if (normalizedCurrency.includes("usd")) return "USD";
    if (normalizedCurrency === "all" || normalizedCurrency.includes("lek")) return "ALL";
    if (combined.includes("eur") || combined.includes("€")) return "EUR";
    if (combined.includes("usd") || combined.includes("$")) return "USD";
    if (combined.includes("all") || combined.includes("lek")) return "ALL";
    return null;
  }

  if (combined.includes("eur") || combined.includes("€")) return "EUR";
  if (combined.includes("usd") || combined.includes("$")) return "USD";
  if (combined.includes("all") || combined.includes("lek")) return "ALL";
  return "ALL";
}

function normalizeAmountCurrencyForStorage(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (!normalized) return null;
  if (normalized === "ALL" || normalized === "EUR" || normalized === "USD") {
    return normalized;
  }
  return null;
}

function findBestExportRowForItem({ records, procedureHint, procedureId, publishedDate, title }) {
  if (!Array.isArray(records) || !records.length) {
    return {
      matched: false,
      reason: "no_export_records",
      matchStrategy: null,
      candidateCount: 0,
      record: null,
      procedureRef: null,
    };
  }

  const normalizedHints = Array.from(
    new Set(
      [normalizeProcedureId(procedureHint || ""), normalizeProcedureId(procedureId || "")]
        .filter(Boolean)
    )
  );

  if (normalizedHints.length) {
    const procedureMatches = [];
    for (const record of records) {
      const procedureRef = getRecordValueByHeaderKeywords(record, PROKURIME_PROCEDURE_HEADER_KEYWORDS);
      const normalizedProcedureRef = normalizeProcedureId(procedureRef || "");
      if (!normalizedProcedureRef || !normalizedHints.includes(normalizedProcedureRef)) continue;
      procedureMatches.push({
        record,
        procedureRef,
      });
    }
    if (procedureMatches.length > 0) {
      return {
        matched: true,
        reason: "matched_procedure_id",
        matchStrategy: "procedure_id",
        candidateCount: procedureMatches.length,
        ...procedureMatches[0],
      };
    }
  }

  const safePublishedDate = parseKnownDate(publishedDate || "");
  const comparableTitle = normalizeComparableTitle(title || "");
  if (!safePublishedDate || !comparableTitle) {
    return {
      matched: false,
      reason: normalizedHints.length ? "procedure_not_found" : "missing_fallback_identifiers",
      matchStrategy: null,
      candidateCount: 0,
      record: null,
      procedureRef: null,
    };
  }

  const titleDateCandidates = [];
  for (const record of records) {
    const recordDate = parseKnownDate(
      getRecordValueByHeaderKeywords(record, [
        "data e publikimit",
        "publication date",
        "date of publication",
        "publikimit",
        "date",
        "data",
      ])
    );
    if (recordDate !== safePublishedDate) continue;

    const recordTitle = getRecordValueByHeaderKeywords(record, [
      "objekti i kontrates",
      "objekti i prokurimit",
      "object of contract",
      "object",
      "pershkrimi",
      "description",
      "title",
      "procedure",
    ]);
    if (normalizeComparableTitle(recordTitle) !== comparableTitle) continue;

    titleDateCandidates.push({
      record,
      procedureRef: getRecordValueByHeaderKeywords(record, PROKURIME_PROCEDURE_HEADER_KEYWORDS) || null,
    });
  }

  if (titleDateCandidates.length === 1) {
    return {
      matched: true,
      reason: "matched_title_date_fallback",
      matchStrategy: "title_date_fallback",
      candidateCount: 1,
      ...titleDateCandidates[0],
    };
  }

  return {
    matched: false,
    reason:
      titleDateCandidates.length > 1 ? "ambiguous_title_date_fallback" : "no_export_row_match",
    matchStrategy: null,
    candidateCount: titleDateCandidates.length,
    record: null,
    procedureRef: null,
  };
}

function extractProkurimeRecordFields({ record, fallbackProcedureRef }) {
  const amountRaw = getRecordValueByHeaderKeywords(record, PROKURIME_AMOUNT_HEADER_KEYWORDS);
  const currencyRaw = getRecordValueByHeaderKeywords(record, PROKURIME_CURRENCY_HEADER_KEYWORDS);
  const supplierName = getRecordValueByHeaderKeywords(record, PROKURIME_SUPPLIER_HEADER_KEYWORDS) || null;
  const cpvCode = getRecordValueByHeaderKeywords(record, PROKURIME_CPV_HEADER_KEYWORDS) || null;
  const procedureRef =
    getRecordValueByHeaderKeywords(record, PROKURIME_PROCEDURE_HEADER_KEYWORDS) ||
    fallbackProcedureRef ||
    null;
  const procedureType =
    getRecordValueByHeaderKeywords(record, PROKURIME_PROCEDURE_TYPE_HEADER_KEYWORDS) || null;
  const contractingAuthority =
    getRecordValueByHeaderKeywords(record, PROKURIME_AUTHORITY_HEADER_KEYWORDS) || null;
  const normalizedCpvCode = String(cpvCode || "").trim() || null;

  return {
    amountValue: parseAmountValue(amountRaw),
    amountCurrency: normalizeAmountCurrencyForStorage(
      detectAmountCurrency({ rawAmount: amountRaw, rawCurrency: currencyRaw })
    ),
    supplierName,
    cpvCode: normalizedCpvCode,
    cpvGroup:
      normalizedCpvCode && /^\d{8}-\d$/.test(normalizedCpvCode)
        ? normalizedCpvCode.slice(0, 2)
        : null,
    procedureRef,
    procedureType,
    contractingAuthority,
    rawRow:
      record && typeof record === "object" && Object.keys(record).length > 0 ? record : null,
  };
}

function defaultErrorFormatter(err, fallback) {
  const message = String(err?.message || fallback || "request_failed").replace(/[\r\n\t]+/g, " ");
  return message.slice(0, 300);
}

async function fetchProkurimeExportPayload({
  exportUrl,
  requestTimeoutMs,
  fetchImpl = fetch,
  errorFormatter = defaultErrorFormatter,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(exportUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/csv, application/csv, text/plain;q=0.9, */*;q=0.8",
      },
    });
    const contentType = String(response.headers.get("content-type") || "").trim();
    const bodyText = await response.text();
    if (!response.ok) {
      return {
        kind: "error",
        reason: `HTTP ${response.status}`,
      };
    }
    if (!isLikelyCsvResponse({ contentType, bodyText })) {
      return {
        kind: "non_csv",
        reason: contentType || "unexpected_content_type",
      };
    }
    const parsed = parseCsvRecordsStrict(bodyText);
    return {
      kind: "csv",
      records: parsed.records || [],
      headers: parsed.headers || [],
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      return {
        kind: "error",
        reason: `timeout ${requestTimeoutMs}ms`,
      };
    }
    return {
      kind: "error",
      reason: errorFormatter(err, "fetch_failed"),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function loadOptionalColumns(db) {
  if (!optionalColumnsPromise) {
    optionalColumnsPromise = db
      .query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'prokurime_records'
          AND column_name = ANY($1::text[])
        `,
        [["cpv_group", "procedure_type", "contracting_authority", "raw_row"]]
      )
      .then((result) => new Set(result.rows.map((row) => String(row.column_name || "").trim())));
  }
  return optionalColumnsPromise;
}

async function upsertProkurimeRecord({
  db,
  itemId,
  municipalityId,
  amountValue,
  amountCurrency,
  supplierName,
  cpvCode,
  cpvGroup,
  procedureRef,
  procedureType,
  contractingAuthority,
  rawRow,
  sourceExportUrl,
  invalidateCache,
}) {
  const normalizedAmountCurrency = normalizeAmountCurrencyForStorage(amountCurrency);
  const optionalColumns = await loadOptionalColumns(db);

  const columns = [
    "item_id",
    "municipality_id",
    "amount_value",
    "amount_currency",
    "supplier_name",
    "cpv_code",
    "procedure_ref",
    "source_export_url",
    "extracted_at",
    "updated_at",
  ];
  const values = [
    itemId,
    municipalityId,
    amountValue,
    normalizedAmountCurrency,
    supplierName,
    cpvCode,
    procedureRef,
    sourceExportUrl,
  ];

  if (optionalColumns.has("cpv_group")) {
    columns.push("cpv_group");
    values.push(cpvGroup);
  }
  if (optionalColumns.has("procedure_type")) {
    columns.push("procedure_type");
    values.push(procedureType);
  }
  if (optionalColumns.has("contracting_authority")) {
    columns.push("contracting_authority");
    values.push(contractingAuthority);
  }
  if (optionalColumns.has("raw_row")) {
    columns.push("raw_row");
    values.push(rawRow);
  }

  const valuePlaceholders = columns.map((_, index) => {
    if (index === columns.indexOf("extracted_at") || index === columns.indexOf("updated_at")) {
      return "now()";
    }
    const valueIndex = columns
      .slice(0, index + 1)
      .filter((columnName) => columnName !== "extracted_at" && columnName !== "updated_at").length;
    return `$${valueIndex}`;
  });
  const updateColumns = columns.filter(
    (columnName) => !["item_id", "extracted_at", "updated_at"].includes(columnName)
  );
  const updateSql = updateColumns
    .map((columnName) => `${columnName} = EXCLUDED.${columnName}`)
    .concat(["extracted_at = now()", "updated_at = now()"])
    .join(",\n      ");

  await db.query(
    `
    INSERT INTO prokurime_records (
      ${columns.join(",\n      ")}
    )
    VALUES (
      ${valuePlaceholders.join(",\n      ")}
    )
    ON CONFLICT (item_id)
    DO UPDATE SET
      ${updateSql}
    `,
    values
  );

  if (typeof invalidateCache === "function") {
    await invalidateCache();
  }
}

async function rebuildProkurimeRecordForItem({
  db,
  item,
  requestTimeoutMs,
  exportPayloadCache,
  fetchImpl,
  errorFormatter,
  invalidateCache,
}) {
  const parsedExportSource = parseAppExportDocumentUrl(item?.sourceUrl);
  if (!parsedExportSource.isExportDocument || !parsedExportSource.exportUrl) {
    return {
      status: "skipped",
      reason: "source_not_exportdocument",
      matchStrategy: null,
    };
  }

  let exportPayload = exportPayloadCache?.get(parsedExportSource.exportUrl);
  if (!exportPayload) {
    exportPayload = await fetchProkurimeExportPayload({
      exportUrl: parsedExportSource.exportUrl,
      requestTimeoutMs,
      fetchImpl,
      errorFormatter,
    });
    exportPayloadCache?.set(parsedExportSource.exportUrl, exportPayload);
  }

  if (exportPayload.kind !== "csv") {
    return {
      status: "skipped",
      reason:
        exportPayload.kind === "non_csv" ? "export_not_csv" : `export_fetch_error:${exportPayload.reason}`,
      matchStrategy: null,
    };
  }

  const matchedRow = findBestExportRowForItem({
    records: exportPayload.records,
    procedureHint: parsedExportSource.procedureHint,
    procedureId: item?.procedureId,
    publishedDate: item?.publishedDate,
    title: item?.title,
  });

  if (!matchedRow.matched) {
    return {
      status: "skipped",
      reason: matchedRow.reason,
      matchStrategy: null,
      candidateCount: matchedRow.candidateCount || 0,
    };
  }

  const extractedFields = extractProkurimeRecordFields({
    record: matchedRow.record || {},
    fallbackProcedureRef:
      matchedRow.procedureRef ||
      item?.procedureId ||
      parsedExportSource.procedureHint ||
      null,
  });

  await upsertProkurimeRecord({
    db,
    itemId: item.itemId,
    municipalityId: item.municipalityId,
    amountValue: extractedFields.amountValue,
    amountCurrency: extractedFields.amountCurrency,
    supplierName: extractedFields.supplierName,
    cpvCode: extractedFields.cpvCode,
    cpvGroup: extractedFields.cpvGroup,
    procedureRef: extractedFields.procedureRef,
    procedureType: extractedFields.procedureType,
    contractingAuthority: extractedFields.contractingAuthority,
    rawRow: extractedFields.rawRow,
    sourceExportUrl: parsedExportSource.exportUrl,
    invalidateCache,
  });

  return {
    status: "upserted",
    reason: extractedFields.amountValue === null ? "record_upserted_amount_null" : "record_upserted",
    matchStrategy: matchedRow.matchStrategy,
    amountValue: extractedFields.amountValue,
    amountCurrency: extractedFields.amountCurrency,
  };
}

module.exports = {
  PROKURIME_AMOUNT_HEADER_KEYWORDS,
  PROKURIME_CURRENCY_HEADER_KEYWORDS,
  PROKURIME_SUPPLIER_HEADER_KEYWORDS,
  PROKURIME_CPV_HEADER_KEYWORDS,
  PROKURIME_PROCEDURE_HEADER_KEYWORDS,
  PROKURIME_AUTHORITY_HEADER_KEYWORDS,
  normalizeHeaderToken,
  normalizeComparableTitle,
  getRecordValueByHeaderKeywords,
  parseKnownDate,
  parseAppExportDocumentUrl,
  isLikelyCsvResponse,
  parseAmountValue,
  detectAmountCurrency,
  normalizeAmountCurrencyForStorage,
  findBestExportRowForItem,
  extractProkurimeRecordFields,
  fetchProkurimeExportPayload,
  upsertProkurimeRecord,
  rebuildProkurimeRecordForItem,
};

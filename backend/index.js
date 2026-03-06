// backend/index.js
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");

require("dotenv").config({
  path: process.env.DOTENV_CONFIG_PATH || path.join(__dirname, ".env"),
});

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const cheerio = require("cheerio");
const { Pool } = require("pg");
const dns = require("dns");
const net = require("net");
const crypto = require("crypto");
const { fetchVendimeStatusSummary } = require("./lib/vendimeStatus");
const { fetchCoverageSummary } = require("./lib/coverageStatus");

// Make Node prefer IPv4 first (helps on some Windows setups)
dns.setDefaultResultOrder("ipv4first");

// Scrapers
const { scrapeTiranaVendime } = require("./scrapers/tiranaVendime");
const { scrapeGenericDocuments } = require("./scrapers/genericDocuments");
const { scrapeVendimeAl } = require("./scrapers/vendimeAl");
const {
  scrapeProkurimeAppExport,
  buildProkurimeAppDedupKey,
  parseCsvRecordsStrict,
  normalizeProcedureId,
} = require("./scrapers/prokurimeAppExport");

console.log("LOADED INDEX.JS FROM:", __filename);

const app = express();
app.disable("x-powered-by");

const NODE_ENV = String(process.env.NODE_ENV || "development").toLowerCase();
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();
const PUBLIC_ORIGINS = String(process.env.PUBLIC_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const LOCAL_PUBLIC_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
]);

if (NODE_ENV === "production" && !ADMIN_TOKEN) {
  console.error("Missing required env var ADMIN_TOKEN in production.");
  process.exit(1);
}

// If deployed behind a reverse proxy/load balancer, set TRUST_PROXY=1.
if (String(process.env.TRUST_PROXY || "") === "1") {
  app.set("trust proxy", 1);
}

// --------------------
// Middleware
// --------------------
const originAllowlist = new Set(PUBLIC_ORIGINS);

function isAllowedLocalPublicOrigin(origin) {
  return LOCAL_PUBLIC_ORIGINS.has(String(origin || "").trim().toLowerCase());
}

app.use(
  cors({
    origin(origin, cb) {
      // Allow non-browser clients (curl, server-to-server) which do not send Origin.
      if (!origin) return cb(null, true);

      if (isAllowedLocalPublicOrigin(origin)) return cb(null, true);

      // If no allowlist configured, default to localhost-only in development.
      if (originAllowlist.size === 0) {
        return cb(new Error("CORS blocked: origin not allowed"), false);
      }

      if (originAllowlist.has(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: origin not allowed"), false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Token"],
    maxAge: 86400,
  })
);

// Return JSON for CORS rejections instead of the default HTML error.
app.use((err, req, res, next) => {
  if (err && String(err.message || "").toLowerCase().includes("cors blocked")) {
    return res.status(403).json({
      ok: false,
      error: "cors_blocked",
      message: "Origin not allowed.",
    });
  }
  return next(err);
});

app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(morgan(NODE_ENV === "production" ? "combined" : "dev"));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX || 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: "rate_limited",
    message: "Too many requests, please try again later.",
  },
});
app.use("/api", apiLimiter);
const scrapeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.SCRAPE_RATE_LIMIT_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: "rate_limited",
    message: "Too many scrape requests, please try again later.",
  },
});
app.use("/api/scrape", scrapeLimiter);
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.ADMIN_RATE_LIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: "rate_limited",
    message: "Too many admin requests, please try again later.",
  },
});
app.use("/api/admin", adminLimiter);

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      ok: false,
      error: "server_misconfigured",
      message: "ADMIN_TOKEN is not configured on the server.",
    });
  }

  const auth = String(req.headers.authorization || "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const headerToken = String(req.headers["x-admin-token"] || "").trim();
  const token = bearer || headerToken;

  if (token && token === ADMIN_TOKEN) return next();

  return res.status(401).json({
    ok: false,
    error: "unauthorized",
    message: "Missing or invalid admin token.",
  });
}

// Lock down admin surfaces.
app.use("/api/scrape", requireAdmin);
app.use("/api/debug", requireAdmin);

// Always declare UTF-8 JSON (API responses)
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

// --------------------
// Postgres (force UTF-8 client encoding for every connection)
// --------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c client_encoding=UTF8 -c statement_timeout=3000",
});

if (!String(process.env.DATABASE_URL || "").trim()) {
  console.error(
    "Missing required env var DATABASE_URL. Expected it in backend/.env or DOTENV_CONFIG_PATH."
  );
  process.exit(1);
}

const HTTP_403_COOLDOWN_MINUTES = (() => {
  const raw = Number.parseInt(String(process.env.HTTP_403_COOLDOWN_MINUTES || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 10080;
})();
const SCRAPE_JOB_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(String(process.env.SCRAPE_JOB_TIMEOUT_MS || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 90000;
})();
const SCRAPE_REQUEST_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(String(process.env.SCRAPE_REQUEST_TIMEOUT_MS || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20000;
})();
const MANUAL_UPLOAD_MAX_BYTES = (() => {
  const raw = Number.parseInt(String(process.env.MANUAL_UPLOAD_MAX_BYTES || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20 * 1024 * 1024;
})();
const UPLOADS_DIR = path.resolve(__dirname, "uploads");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KONSULTIME_FALLBACK_KEYWORDS = [
  "njoftime",
  "proces",
  "verbale",
  "vendime",
  "konsultim",
  "degjes",
];
const KONSULTIME_FALLBACK_MAX_LINKS = 6;
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
const PROKURIME_ALL_CURRENCY_SQL_PREDICATE =
  "COALESCE(NULLIF(btrim(upper(pr.amount_currency)), ''), 'ALL') = 'ALL'";
const KONSULTIME_NO_YEAR_KEEP_RE =
  /\b(konsultim[a-z]*|konsultime[a-z]*|degjes[a-z]*|njoftim[a-z]*|proces\s*verbal[a-z]*|takim[a-z]*|projekt[a-z]*|draft[a-z]*|plan[a-z]*|strategji[a-z]*|buxhet[a-z]*|pba|pyetesor[a-z]*|anket[a-z]*|koment[a-z]*)\b/;
const SEARCH_INDEX_UID = String(process.env.MEILI_PUBLIC_INDEX_UID || "public_items_v1").trim();

try {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
} catch (err) {
  console.warn("Could not ensure uploads directory:", safePublicErrorMessage(err, "mkdir failed"));
}

const manualUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MANUAL_UPLOAD_MAX_BYTES,
    files: 1,
  },
});

function parseManualUpload(req, res, next) {
  manualUpload.single("file")(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        ok: false,
        error: "payload_too_large",
        message: `Uploaded file exceeds MANUAL_UPLOAD_MAX_BYTES (${MANUAL_UPLOAD_MAX_BYTES}).`,
      });
    }

    if (err instanceof multer.MulterError) {
      return badRequest(res, `Invalid upload payload: ${err.code}`);
    }

    return next(err);
  });
}

pool.on("connect", (client) => {
  client
    .query("SET client_encoding TO 'UTF8'; SET statement_timeout TO '3000ms'")
    .catch(() => {});
});

// Prevent process crashes if an idle pooled client loses DB connectivity.
pool.on("error", (err) => {
  console.error("Postgres pool error:", err.message);
});

function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutHandle = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const err = new Error(`Timeout: ${timeoutMessage}`);
      err.code = "TIMEOUT";
      err.last_error_type = "TIMEOUT";
      err.timeout_label = timeoutMessage;
      reject(err);
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  });
}

async function checkDb() {
  await withTimeout(
    pool.query("SELECT 1"),
    1500,
    "DB check timed out after 1500ms"
  );
  return "ok";
}

async function checkRedisPing() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is not set");

  const parsed = new URL(redisUrl);
  const host = parsed.hostname || "127.0.0.1";
  const port = Number(parsed.port || 6379);
  const password = decodeURIComponent(parsed.password || "");

  return withTimeout(
    new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      let buffer = "";

      const cleanup = () => {
        socket.removeAllListeners();
        socket.end();
        socket.destroy();
      };

      const fail = (message) => {
        cleanup();
        reject(new Error(message));
      };

      socket.on("error", (err) => {
        fail(`Redis ping failed: ${err.message}`);
      });

      socket.on("connect", () => {
        const commands = [];
        if (password) {
          commands.push(`*2\r\n$4\r\nAUTH\r\n$${Buffer.byteLength(password)}\r\n${password}\r\n`);
        }
        commands.push("*1\r\n$4\r\nPING\r\n");
        socket.write(commands.join(""));
      });

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");

        if (buffer.includes("-")) {
          const line = buffer.split("\r\n")[0] || buffer.trim();
          fail(`Redis ping failed: ${line}`);
          return;
        }

        if (password) {
          if (buffer.includes("+OK\r\n") && buffer.includes("+PONG\r\n")) {
            cleanup();
            resolve("ok");
          }
          return;
        }

        if (buffer.includes("+PONG\r\n")) {
          cleanup();
          resolve("ok");
        }
      });
    }),
    1500,
    "Redis ping timed out after 1500ms"
  );
}

async function checkMeiliHealth() {
  const host = process.env.MEILI_HOST;
  if (!host) throw new Error("MEILI_HOST is not set");

  // /health does not require auth; do not send privileged keys over the wire.
  const response = await withTimeout(
    fetch(`${host.replace(/\/+$/, "")}/health`),
    1500,
    "Meilisearch health check timed out after 1500ms"
  );

  if (!response.ok) {
    throw new Error(`Meilisearch health returned HTTP ${response.status}`);
  }

  return "ok";
}

function formatCheckError(err, fallbackMessage) {
  const message = String(err?.message || "").trim();
  if (message) return message;

  const code = String(err?.code || err?.cause?.code || "").trim();
  if (code) return `${fallbackMessage} (${code})`;

  return fallbackMessage;
}

let _vPublicFeedColumns = null;
let _hasMunicipalityKeyAliasesTable = null;
async function getVPublicFeedColumns() {
  if (_vPublicFeedColumns) return _vPublicFeedColumns;
  const r = await pool.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'v_public_feed'
    `
  );
  _vPublicFeedColumns = new Set(r.rows.map((row) => row.column_name));
  return _vPublicFeedColumns;
}

async function hasMunicipalityKeyAliasesTable() {
  if (_hasMunicipalityKeyAliasesTable !== null) return _hasMunicipalityKeyAliasesTable;
  const r = await pool.query(
    `SELECT to_regclass('public.municipality_key_aliases')::text AS table_name`
  );
  _hasMunicipalityKeyAliasesTable = Boolean(r.rows[0]?.table_name);
  return _hasMunicipalityKeyAliasesTable;
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function parseNonNegativeInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function parseYear(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(String(value).trim());
  if (!Number.isInteger(n) || n < 2000 || n > 2100) return null;
  return n;
}

function parseTopInt(value, fallback, min = 1, max = 20) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(String(value).trim());
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function parseOptionalInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function parseSort(value, fallback = "newest") {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "newest" || normalized === "oldest") return normalized;
  return null;
}

function asEnabledFlag(value) {
  if (typeof value === "boolean") return value;
  const s = String(value || "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "t" || s === "yes" || s === "on";
}

function parseBooleanWithDefault(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "t", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "f", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

const SUPPORTED_CATEGORIES = ["Vendime", "Prokurime", "Konsultime publike"];

function resolveSupportedCategory(value, fallback = "Vendime") {
  const hasExplicitValue =
    value !== undefined && value !== null && String(value).trim() !== "";
  if (!hasExplicitValue && (fallback === null || fallback === undefined)) return null;
  const raw = hasExplicitValue ? String(value) : String(fallback);
  const cleaned = raw.trim().replace(/^["']|["']$/g, "");
  const normalized = cleaned.toLowerCase();
  if (normalized === "vendime") return "Vendime";
  if (normalized === "prokurime") return "Prokurime";
  if (normalized === "konsultime publike" || normalized === "konsultime-publike") {
    return "Konsultime publike";
  }
  return null;
}

function getRegistryUrlColumnForCategory(category) {
  if (category === "Vendime") return "vendime_url";
  if (category === "Prokurime") return "prokurime_url";
  if (category === "Konsultime publike") return "konsultime_url";
  return null;
}

function getCheckedColumnForCategory(category) {
  if (category === "Vendime") return "vendime_checked";
  if (category === "Prokurime") return "prokurime_checked";
  if (category === "Konsultime publike") return "konsultime_checked";
  return null;
}

function isCategoryChecked(registryRow, category) {
  const checkedColumn = getCheckedColumnForCategory(category);
  if (!checkedColumn) return false;
  return asEnabledFlag(registryRow?.[checkedColumn]);
}

function badRequest(res, message) {
  return res.status(400).json({
    ok: false,
    error: "bad_request",
    message,
  });
}

function safePublicErrorMessage(err, fallbackMessage) {
  const raw = String(err?.message || "").trim();
  if (!raw) return fallbackMessage;

  const redacted = raw
    .replace(/postgres:\/\/[^@\s]+@/gi, "postgres://***@")
    .replace(/password=[^\s]+/gi, "password=***")
    .replace(/bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/gi, "bearer ***");

  return redacted.length > 200 ? fallbackMessage : redacted;
}

function isUuid(value) {
  return UUID_RE.test(String(value || "").trim());
}

function parseHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function hasPdfMagicBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return false;
  return buffer.slice(0, 5).toString("ascii") === "%PDF-";
}

function manualDedupKeyV1({
  municipalityId,
  category,
  titleNormalized,
  publishedDate,
  sourceUrl,
  fileSha256,
}) {
  const normalizedCategory = String(category || "")
    .toLowerCase()
    .replace(/\s+/g, "-");
  const payload = [
    String(municipalityId || ""),
    normalizedCategory,
    String(titleNormalized || ""),
    String(publishedDate || "unknown"),
    String(sourceUrl || ""),
    String(fileSha256 || ""),
  ].join("|");
  const hash = crypto.createHash("sha1").update(payload).digest("hex").slice(0, 20);
  return `manual|v1|${municipalityId}|${normalizedCategory}|h:${hash}`;
}

function buildLocalUploadStorageUri(fileName) {
  return `local://uploads/${fileName}`;
}

function buildPublicFilePath(attachmentId) {
  const id = String(attachmentId || "").trim();
  return id ? `/api/public/files/${encodeURIComponent(id)}` : null;
}

function buildAdminFilePath(attachmentId) {
  const id = String(attachmentId || "").trim();
  return id ? `/api/admin/files/${encodeURIComponent(id)}` : null;
}

function resolveLocalUploadPath(storageUri) {
  const uri = String(storageUri || "").trim();
  const match = /^local:\/\/uploads\/([0-9a-f-]+\.pdf)$/i.exec(uri);
  if (!match) return null;
  const fileName = match[1];
  const resolvedPath = path.resolve(UPLOADS_DIR, fileName);
  const relative = path.relative(UPLOADS_DIR, resolvedPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolvedPath;
}

function sanitizeDownloadName(fileName, attachmentId) {
  const raw = String(fileName || "").trim();
  const cleaned = raw
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^_+/, "")
    .slice(0, 120);
  if (cleaned && cleaned.toLowerCase().endsWith(".pdf")) return cleaned;
  if (cleaned) return `${cleaned}.pdf`;
  return `${attachmentId}.pdf`;
}

function escapeMeiliFilterValue(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildMeiliAuthHeaders() {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const apiKey = String(process.env.MEILI_MASTER_KEY || "").trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function buildMeiliFilter({ municipality, category, year }) {
  const parts = [];
  if (municipality) {
    parts.push(`municipality_name_key = "${escapeMeiliFilterValue(municipality)}"`);
  }
  if (category) {
    parts.push(`category = "${escapeMeiliFilterValue(category)}"`);
  }
  if (year !== null && year !== undefined) {
    parts.push(`year = ${Number(year)}`);
  }
  if (!parts.length) return undefined;
  return parts.join(" AND ");
}

function getMeiliSortClause(sort) {
  if (sort === "oldest") return ["published_ts:asc", "collected_ts:asc"];
  return ["published_ts:desc", "collected_ts:desc"];
}

async function meiliRequest(method, routePath, body = undefined) {
  const host = String(process.env.MEILI_HOST || "").trim().replace(/\/+$/, "");
  if (!host) {
    const err = new Error("Search backend unavailable.");
    err.statusCode = 503;
    throw err;
  }

  const url = `${host}${routePath.startsWith("/") ? routePath : `/${routePath}`}`;
  let response;
  try {
    response = await withTimeout(fetch(url, {
      method,
      headers: buildMeiliAuthHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    }), 5000, "Meilisearch request timed out");
  } catch (error) {
    const err = new Error("Search backend unavailable.");
    err.statusCode = 503;
    err.cause = error;
    throw err;
  }

  const responseText = await response.text();
  let responseJson = null;
  if (responseText) {
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      responseJson = null;
    }
  }

  if (!response.ok) {
    const isServiceUnavailable = response.status === 401 || response.status === 403 || response.status === 404 || response.status >= 500;
    const err = new Error(
      isServiceUnavailable ? "Search backend unavailable." : "Search request failed."
    );
    err.statusCode = isServiceUnavailable ? 503 : 500;
    err.meiliStatus = response.status;
    throw err;
  }

  return responseJson;
}

async function resolveAttachmentForServing(attachmentId, { publicOnlyPublished }) {
  if (!isUuid(attachmentId)) return null;

  const result = await pool.query(
    `
    SELECT
      a.id,
      a.file_name,
      a.mime_type,
      a.size_bytes,
      a.storage_uri,
      i.status AS item_status
    FROM attachments a
    JOIN items i ON i.id = a.item_id
    WHERE a.id = $1
      AND ($2::boolean = FALSE OR i.status = 'published')
    LIMIT 1
    `,
    [attachmentId, publicOnlyPublished]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  const localPath = resolveLocalUploadPath(row.storage_uri);
  if (!localPath) return null;
  try {
    const stat = await fsp.stat(localPath);
    if (!stat.isFile()) return null;
    return {
      id: row.id,
      fileName: sanitizeDownloadName(row.file_name, row.id),
      mimeType: String(row.mime_type || "").trim() || "application/pdf",
      localPath,
      sizeBytes: Number.isFinite(Number(row.size_bytes))
        ? Number(row.size_bytes)
        : stat.size,
    };
  } catch {
    return null;
  }
}

// --------------------
// Helpers
// --------------------
function normalizeTitle(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function shouldKeepKonsultimeWithoutYear({ title, sourceUrl }) {
  const haystack = `${normalizeTitle(title)} ${normalizeTitle(sourceUrl)}`.trim();
  if (!haystack) return false;
  return KONSULTIME_NO_YEAR_KEEP_RE.test(haystack);
}

function normalizeHostForCompare(host) {
  return String(host || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

function isSameHostForCompare(a, b) {
  const left = normalizeHostForCompare(a);
  const right = normalizeHostForCompare(b);
  return !!left && !!right && left === right;
}

function isPdfUrl(url) {
  return /\.pdf(\?|#|$)/i.test(String(url || "").trim());
}

function evaluateKonsultimeNoYearSourcePolicy({
  municipalityHost,
  sourceUrl,
  sourcePageUrl,
  itemBaseUrl,
}) {
  const sourceHost = getHost(sourceUrl);
  if (!sourceHost || !municipalityHost) {
    return {
      allowed: false,
      resolvedSourcePageUrl: sourcePageUrl || itemBaseUrl || null,
    };
  }

  if (isSameHostForCompare(sourceHost, municipalityHost)) {
    return {
      allowed: true,
      resolvedSourcePageUrl: sourcePageUrl || itemBaseUrl || null,
    };
  }

  const referrerHost = getHost(itemBaseUrl || sourcePageUrl);
  const allowExternalPdf =
    isPdfUrl(sourceUrl) && isSameHostForCompare(referrerHost, municipalityHost);
  if (!allowExternalPdf) {
    return {
      allowed: false,
      resolvedSourcePageUrl: sourcePageUrl || itemBaseUrl || null,
    };
  }

  return {
    allowed: true,
    // Keep municipality page as provenance referrer for allowed external PDFs.
    resolvedSourcePageUrl: itemBaseUrl || sourcePageUrl || null,
  };
}

function toNameKey(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function utcHourBucket(d = new Date()) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}`;
}

function appendHourBucket(existing, bucket) {
  const s = String(existing || "").trim();
  if (!s) return bucket;
  const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.includes(bucket)) return s; // append-only, no duplicates
  parts.push(bucket);
  return parts.join(",");
}

function makeAbsoluteUrl(base, href) {
  if (!href) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function looksLikeVendim(title, url) {
  const s = ((title || "") + " " + (url || "")).toLowerCase();

  // keep obvious non-decision docs out of Vendime
  if (
    s.includes("plani") ||
    s.includes("aktivit") ||
    s.includes("program") ||
    s.includes("raport")
  ) {
    return false;
  }

  const u = String(url || "").toLowerCase();

  // if it's a document link (pdf/doc/docx/rtf/etc), accept it for Vendime
  // (the page itself is already the "Vendime" registry page)
  const isDoc =
    /\.(pdf|doc|docx|rtf|xls|xlsx)(\?|#|$)/i.test(u) ||
    /[?&](download|file|attachment_id)=/i.test(u) ||
    /\/download\/?/i.test(u);

  if (isDoc) return true;

  // strong decision keywords
  if (s.includes("vendim") || s.includes("vendimi")) return true;

  // common patterns: "Nr.97", "Nr-12", "nr 101", etc.
  return /\bnr[.\- ]?\s*\d{1,4}\b/.test(s);
}


// --------------------
// Date helpers (avoid crashing on bad dates like 2025-13-99)
// --------------------
function isValidISODate(s) {
  if (!s || typeof s !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;

  const [y, m, d] = s.split("-").map((n) => Number(n));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;

  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function sanitizeISODate(s) {
  return isValidISODate(s) ? s : null;
}

function normalizeVendimeNumber(s) {
  return (
    String(s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "") || "n"
  );
}

function vendimeSourceWeight(sourceOrigin) {
  const host = String(sourceOrigin || "").trim().toLowerCase();
  return host === "vendime.al" || host === "www.vendime.al" ? 50 : 100;
}

function dedupKeyVendimeV2({ municipalityId, publishedDate, number, title, titleNormalized }) {
  const datePart = publishedDate || "unknown";
  const nrPart = normalizeVendimeNumber(number);
  const titleNorm = titleNormalized || normalizeTitle(title) || "untitled";
  const titleHash = crypto.createHash("sha1").update(titleNorm).digest("hex").slice(0, 12);
  return `vendime|v2|${municipalityId}|${datePart}|nr:${nrPart}|t:${titleHash}`;
}

async function resolveVendimeDedupKey({
  municipalityId,
  publishedDate,
  number,
  title,
  titleNormalized,
}) {
  const datedKey = dedupKeyVendimeV2({
    municipalityId,
    publishedDate,
    number,
    title,
    titleNormalized,
  });
  if (!publishedDate) return datedKey;

  const unknownKey = dedupKeyVendimeV2({
    municipalityId,
    publishedDate: null,
    number,
    title,
    titleNormalized,
  });

  const existing = await pool.query(
    `
    SELECT dedup_key
    FROM items
    WHERE municipality_id = $1
      AND category = 'Vendime'
      AND dedup_key = ANY($2::text[])
    ORDER BY CASE WHEN dedup_key = $3 THEN 0 ELSE 1 END
    LIMIT 1
    `,
    [municipalityId, [datedKey, unknownKey], datedKey]
  );

  return existing.rowCount ? existing.rows[0].dedup_key : datedKey;
}

function dedupKeyRegistryDocumentV1({
  municipalityId,
  category,
  publishedDate,
  title,
  titleNormalized,
  sourceUrl,
}) {
  const datePart = publishedDate || "unknown";
  const categoryPart = String(category || "").toLowerCase().replace(/\s+/g, "-");
  const titleNorm = titleNormalized || normalizeTitle(title) || "untitled";
  const titleHash = crypto.createHash("sha1").update(titleNorm).digest("hex").slice(0, 12);
  const sourceHash = crypto
    .createHash("sha1")
    .update(String(sourceUrl || "missing"))
    .digest("hex")
    .slice(0, 12);
  return `registry|v1|${municipalityId}|${categoryPart}|${datePart}|t:${titleHash}|s:${sourceHash}`;
}

function normalizeHeaderToken(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
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
    const parts = clean.split(",");
    if (parts.length > 2) {
      normalized = parts.join("");
    } else if (parts[1] && parts[1].length > 0 && parts[1].length <= 2) {
      normalized = `${parts[0]}.${parts[1]}`;
    } else {
      normalized = clean.replace(/,/g, "");
    }
  } else if (lastDot !== -1) {
    const parts = clean.split(".");
    if (parts.length > 2) {
      normalized = parts.join("");
    } else if (parts[1] && parts[1].length > 0 && parts[1].length <= 2) {
      normalized = `${parts[0]}.${parts[1]}`;
    } else {
      normalized = clean.replace(/\./g, "");
    }
  }

  const numericValue = Number.parseFloat(`${isNegative ? "-" : ""}${normalized}`);
  if (!Number.isFinite(numericValue)) return null;
  return Math.round(numericValue * 100) / 100;
}

function detectAmountCurrency({ rawAmount, rawCurrency }) {
  const combined = `${String(rawCurrency || "")} ${String(rawAmount || "")}`.toLowerCase();
  if (!combined) return null;

  if (combined.includes("eur") || combined.includes("€")) return "EUR";
  if (combined.includes("usd") || combined.includes("$")) return "USD";
  if (combined.includes("all") || combined.includes("lek")) return "ALL";
  return null;
}

function normalizeAmountCurrencyForStorage(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (normalized === "ALL" || normalized === "EUR" || normalized === "USD") {
    return normalized;
  }
  return "ALL";
}

function findBestExportRowForItem({ records, procedureHint, procedureId }) {
  if (!Array.isArray(records) || !records.length) return null;
  const normalizedHints = [
    normalizeProcedureId(procedureHint || ""),
    normalizeProcedureId(procedureId || ""),
  ].filter(Boolean);
  if (!normalizedHints.length) return null;

  for (const record of records) {
    const procedureRef = getRecordValueByHeaderKeywords(record, PROKURIME_PROCEDURE_HEADER_KEYWORDS);
    const normalizedProcedureRef = normalizeProcedureId(procedureRef || "");
    if (!normalizedProcedureRef) continue;
    if (!normalizedHints.includes(normalizedProcedureRef)) continue;
    return { record, procedureRef };
  }
  return null;
}

async function fetchProkurimeExportPayload(exportUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(exportUrl, {
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
      sampleLogged: false,
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      return {
        kind: "error",
        reason: `timeout ${SCRAPE_REQUEST_TIMEOUT_MS}ms`,
      };
    }
    return {
      kind: "error",
      reason: safePublicErrorMessage(err, "fetch_failed"),
    };
  } finally {
    clearTimeout(timer);
  }
}

function truncateLogJson(value, maxLen = 260) {
  const raw = typeof value === "string" ? value : JSON.stringify(value || {});
  return String(raw || "").replace(/[\r\n\t]+/g, " ").slice(0, maxLen);
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
  return {
    amountValue: parseAmountValue(amountRaw),
    amountCurrency: normalizeAmountCurrencyForStorage(
      detectAmountCurrency({ rawAmount: amountRaw, rawCurrency: currencyRaw })
    ),
    supplierName,
    cpvCode,
    procedureRef,
  };
}

async function findItemIdByDedupKey({ municipalityId, dedupKey }) {
  const found = await pool.query(
    `
    SELECT id
    FROM items
    WHERE municipality_id = $1
      AND category = 'Prokurime'
      AND dedup_key = $2
    LIMIT 1
    `,
    [municipalityId, dedupKey]
  );
  return found.rowCount ? found.rows[0].id : null;
}

async function upsertProkurimeRecord({
  itemId,
  municipalityId,
  amountValue,
  amountCurrency,
  supplierName,
  cpvCode,
  procedureRef,
  sourceExportUrl,
}) {
  const normalizedAmountCurrency = normalizeAmountCurrencyForStorage(amountCurrency);
  await pool.query(
    `
    INSERT INTO prokurime_records (
      item_id,
      municipality_id,
      amount_value,
      amount_currency,
      supplier_name,
      cpv_code,
      procedure_ref,
      source_export_url,
      extracted_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
    ON CONFLICT (item_id)
    DO UPDATE SET
      municipality_id = EXCLUDED.municipality_id,
      amount_value = EXCLUDED.amount_value,
      amount_currency = EXCLUDED.amount_currency,
      supplier_name = EXCLUDED.supplier_name,
      cpv_code = EXCLUDED.cpv_code,
      procedure_ref = EXCLUDED.procedure_ref,
      source_export_url = EXCLUDED.source_export_url,
      extracted_at = now(),
      updated_at = now()
    `,
    [
      itemId,
      municipalityId,
      amountValue,
      normalizedAmountCurrency,
      supplierName,
      cpvCode,
      procedureRef,
      sourceExportUrl,
    ]
  );
  invalidateDashboardProkurimePieCache();
}

async function upsertRegistryDocumentItem({
  municipalityId,
  category,
  title,
  titleNormalized,
  publishedDate,
  sourceUrl,
  sourcePageUrl,
  sourceOrigin,
  dedupKey,
  shouldPublish,
  defaultStatus,
  systemUserId,
}) {
  const dateUnknown = publishedDate ? false : true;

  try {
    const upsert = await pool.query(
      `
      INSERT INTO items (
        municipality_id, category,
        title, title_normalized, summary,
        published_date, date_unknown, date_source,
        source_url, source_page_url, source_origin, source_url_missing_reason,
        collected_at, ingestion_method,
        dedup_key, possible_duplicate,
        status, created_by_user_id
      )
      VALUES (
        $1, $2,
        $3, $4, NULL,
        $5::date, $6, 'scrape_registry',
        $7, $8, $9, NULL,
        now(), 'scrape',
        $10, false,
        $11, $12
      )
      ON CONFLICT (municipality_id, category, dedup_key)
      DO UPDATE
      SET
        title = EXCLUDED.title,
        title_normalized = EXCLUDED.title_normalized,
        published_date = CASE
          WHEN items.published_date IS NULL AND EXCLUDED.published_date IS NOT NULL
            THEN EXCLUDED.published_date
          ELSE items.published_date
        END,
        date_unknown = CASE
          WHEN items.published_date IS NULL AND EXCLUDED.published_date IS NOT NULL
            THEN FALSE
          ELSE items.date_unknown
        END,
        source_url = COALESCE(EXCLUDED.source_url, items.source_url),
        source_page_url = COALESCE(EXCLUDED.source_page_url, items.source_page_url),
        source_origin = COALESCE(EXCLUDED.source_origin, items.source_origin),
        status = CASE WHEN $13::boolean THEN 'published' ELSE items.status END,
        updated_at = now()
      WHERE
        items.title IS DISTINCT FROM EXCLUDED.title
        OR items.title_normalized IS DISTINCT FROM EXCLUDED.title_normalized
        OR (items.published_date IS NULL AND EXCLUDED.published_date IS NOT NULL)
        OR items.source_url IS DISTINCT FROM EXCLUDED.source_url
        OR items.source_page_url IS DISTINCT FROM EXCLUDED.source_page_url
        OR items.source_origin IS DISTINCT FROM EXCLUDED.source_origin
        OR ($13::boolean AND items.status <> 'published')
      RETURNING (xmax = 0) AS inserted
      `,
      [
        municipalityId,
        category,
        title,
        titleNormalized,
        publishedDate,
        dateUnknown,
        sourceUrl,
        sourcePageUrl,
        sourceOrigin,
        dedupKey,
        defaultStatus,
        systemUserId,
        shouldPublish,
      ]
    );

    if (!upsert.rowCount) return "skipped";
    return upsert.rows[0].inserted ? "inserted" : "updated";
  } catch (err) {
    if (err?.code === "23505") {
      const existing = await pool.query(
        `
        SELECT id, published_date
        FROM items
        WHERE municipality_id = $1
          AND category = $2
          AND source_url = $3
        LIMIT 1
        `,
        [municipalityId, category, sourceUrl]
      );
      if (!existing.rowCount) return "skipped";

      const row = existing.rows[0];
      const mergedDate = row.published_date || publishedDate || null;
      const mergedDateUnknown = mergedDate ? false : true;
      const updated = await pool.query(
        `
        UPDATE items
        SET
          title = COALESCE($2, title),
          title_normalized = COALESCE($3, title_normalized),
          published_date = $4::date,
          date_unknown = $5,
          source_page_url = COALESCE($6, source_page_url),
          source_origin = COALESCE($7, source_origin),
          dedup_key = CASE
            WHEN dedup_key = $8 THEN dedup_key
            WHEN EXISTS (
              SELECT 1
              FROM items i2
              WHERE i2.municipality_id = $9
                AND i2.category = $10
                AND i2.dedup_key = $8
                AND i2.id <> $1
            ) THEN dedup_key
            ELSE $8
          END,
          status = CASE WHEN $11::boolean THEN 'published' ELSE status END,
          updated_at = now()
        WHERE id = $1
        `,
        [
          row.id,
          title,
          titleNormalized,
          mergedDate,
          mergedDateUnknown,
          sourcePageUrl,
          sourceOrigin,
          dedupKey,
          municipalityId,
          category,
          shouldPublish,
        ]
      );

      return updated.rowCount ? "updated" : "skipped";
    }

    if (err?.code !== "42P10") throw err;

    const existingByDedup = await pool.query(
      `
      SELECT id, title, title_normalized, published_date, date_unknown,
             source_url, source_page_url, source_origin, status
      FROM items
      WHERE municipality_id = $1
        AND category = $2
        AND dedup_key = $3
      LIMIT 1
      `,
      [municipalityId, category, dedupKey]
    );

    if (!existingByDedup.rowCount) {
      const insertedFallback = await pool.query(
        `
        INSERT INTO items (
          municipality_id, category,
          title, title_normalized, summary,
          published_date, date_unknown, date_source,
          source_url, source_page_url, source_origin, source_url_missing_reason,
          collected_at, ingestion_method,
          dedup_key, possible_duplicate,
          status, created_by_user_id
        )
        VALUES (
          $1, $2,
          $3, $4, NULL,
          $5::date, $6, 'scrape_registry',
          $7, $8, $9, NULL,
          now(), 'scrape',
          $10, false,
          $11, $12
        )
        ON CONFLICT (source_url) WHERE source_url IS NOT NULL
        DO NOTHING
        RETURNING id
        `,
        [
          municipalityId,
          category,
          title,
          titleNormalized,
          publishedDate,
          dateUnknown,
          sourceUrl,
          sourcePageUrl,
          sourceOrigin,
          dedupKey,
          defaultStatus,
          systemUserId,
        ]
      );
      return insertedFallback.rowCount ? "inserted" : "skipped";
    }

    const row = existingByDedup.rows[0];
    const mergedDate = row.published_date || publishedDate || null;
    const mergedDateUnknown = mergedDate ? false : true;
    const mergedTitle = title || row.title || null;
    const mergedTitleNormalized = titleNormalized || row.title_normalized || null;
    const mergedSourceUrl = sourceUrl || row.source_url || null;
    const mergedSourcePageUrl = sourcePageUrl || row.source_page_url || null;
    const mergedSourceOrigin = sourceOrigin || row.source_origin || null;
    const mergedStatus = shouldPublish ? "published" : row.status;
    const changed =
      String(row.title || "") !== String(mergedTitle || "") ||
      String(row.title_normalized || "") !== String(mergedTitleNormalized || "") ||
      String(row.published_date || "") !== String(mergedDate || "") ||
      Boolean(row.date_unknown) !== Boolean(mergedDateUnknown) ||
      String(row.source_url || "") !== String(mergedSourceUrl || "") ||
      String(row.source_page_url || "") !== String(mergedSourcePageUrl || "") ||
      String(row.source_origin || "") !== String(mergedSourceOrigin || "") ||
      String(row.status || "") !== String(mergedStatus || "");

    if (!changed) return "skipped";

    const updatedFallback = await pool.query(
      `
      UPDATE items
      SET
        title = $2,
        title_normalized = $3,
        published_date = $4::date,
        date_unknown = $5,
        source_url = $6,
        source_page_url = $7,
        source_origin = $8,
        status = $9,
        updated_at = now()
      WHERE id = $1
      `,
      [
        row.id,
        mergedTitle,
        mergedTitleNormalized,
        mergedDate,
        mergedDateUnknown,
        mergedSourceUrl,
        mergedSourcePageUrl,
        mergedSourceOrigin,
        mergedStatus,
      ]
    );

    return updatedFallback.rowCount ? "updated" : "skipped";
  }
}


async function getMunicipalityId({ municipality, municipality_id }) {
  if (municipality_id !== undefined && municipality_id !== null && String(municipality_id).trim() !== "") {
    const n = Number(String(municipality_id).trim());
    if (!Number.isInteger(n) || n < 1) return null;
    return n;
  }
  if (!municipality) return null;

  const key = toNameKey(municipality);
  const aliasTableExists = await hasMunicipalityKeyAliasesTable();

  const r = aliasTableExists
    ? await pool.query(
        `
        SELECT m.id
        FROM municipalities m
        LEFT JOIN municipality_key_aliases a ON a.municipality_id = m.id
        WHERE lower(m.name_key) = $1 OR lower(a.alias_key) = $1
        ORDER BY CASE WHEN lower(m.name_key) = $1 THEN 0 ELSE 1 END
        LIMIT 1
        `,
        [key]
      )
    : await pool.query(
        `SELECT id FROM municipalities WHERE lower(name_key) = $1 LIMIT 1`,
        [key]
      );
  return r.rowCount ? r.rows[0].id : null;
}

async function getMunicipalityNameKeyById(municipalityId) {
  const r = await pool.query(
    `SELECT lower(name_key) AS name_key FROM municipalities WHERE id = $1 LIMIT 1`,
    [municipalityId]
  );
  return r.rowCount ? r.rows[0].name_key : null;
}

async function resolveDashboardYear({ municipalityId, requestedYear }) {
  if (Number.isInteger(requestedYear)) return requestedYear;
  const latestYearResult = await pool.query(
    `
    SELECT
      EXTRACT(YEAR FROM i.published_date)::int AS year_value
    FROM prokurime_records pr
    JOIN items i ON i.id = pr.item_id
    WHERE i.municipality_id = $1
      AND i.category = 'Prokurime'
      AND i.published_date IS NOT NULL
      AND pr.amount_value IS NOT NULL
      AND ${PROKURIME_ALL_CURRENCY_SQL_PREDICATE}
    ORDER BY year_value DESC
    LIMIT 1
    `,
    [municipalityId]
  );
  if (latestYearResult.rowCount) {
    const latestYear = Number(latestYearResult.rows[0]?.year_value);
    if (Number.isInteger(latestYear)) return latestYear;
  }
  return 2026;
}

async function getMunicipalityMatchContext(municipalityId) {
  const municipalityResult = await pool.query(
    `
    SELECT lower(name_key) AS name_key, name_sq
    FROM municipalities
    WHERE id = $1
    LIMIT 1
    `,
    [municipalityId]
  );
  if (!municipalityResult.rowCount) return null;

  const municipalityRow = municipalityResult.rows[0];
  let aliasKeys = [];
  if (await hasMunicipalityKeyAliasesTable()) {
    const aliasResult = await pool.query(
      `
      SELECT lower(alias_key) AS alias_key
      FROM municipality_key_aliases
      WHERE municipality_id = $1
      ORDER BY alias_key ASC
      `,
      [municipalityId]
    );
    aliasKeys = aliasResult.rows
      .map((row) => String(row.alias_key || "").trim())
      .filter(Boolean);
  }

  return {
    municipalityId,
    nameKey: String(municipalityRow.name_key || "").trim(),
    nameSq: String(municipalityRow.name_sq || "").trim(),
    aliasKeys,
  };
}

async function loadAllMunicipalityMatchContexts() {
  const municipalityResult = await pool.query(
    `
    SELECT id AS municipality_id, lower(name_key) AS name_key, name_sq
    FROM municipalities
    ORDER BY lower(name_key) ASC, id ASC
    `
  );
  const aliasByMunicipalityId = new Map();
  if (await hasMunicipalityKeyAliasesTable()) {
    const aliasResult = await pool.query(
      `
      SELECT municipality_id, lower(alias_key) AS alias_key
      FROM municipality_key_aliases
      ORDER BY municipality_id ASC, lower(alias_key) ASC
      `
    );
    for (const row of aliasResult.rows) {
      const municipalityId = String(row.municipality_id || "").trim();
      if (!municipalityId) continue;
      const aliasKey = String(row.alias_key || "").trim();
      if (!aliasKey) continue;
      const list = aliasByMunicipalityId.get(municipalityId) || [];
      list.push(aliasKey);
      aliasByMunicipalityId.set(municipalityId, list);
    }
  }

  const contexts = municipalityResult.rows.map((row) => {
    const municipalityId = String(row.municipality_id || "").trim();
    const nameKey = String(row.name_key || "").trim().toLowerCase();
    const nameSq = String(row.name_sq || "").trim();
    const aliasKeys = aliasByMunicipalityId.get(municipalityId) || [];
    return {
      municipalityId,
      nameKey,
      nameSq,
      aliasKeys,
    };
  });

  contexts.sort((a, b) => {
    if (a.nameKey < b.nameKey) return -1;
    if (a.nameKey > b.nameKey) return 1;
    return String(a.municipalityId || "").localeCompare(String(b.municipalityId || ""));
  });
  return contexts;
}

async function loadCheckedPrimaryRegistryMunicipalityIds(category) {
  const checkedColumn = getCheckedColumnForCategory(category);
  if (!checkedColumn) return new Set();
  const result = await pool.query(
    `
    SELECT municipality_id
    FROM source_registry
    WHERE is_primary = TRUE
      AND ${checkedColumn} = TRUE
    `
  );
  return new Set(
    result.rows
      .map((row) => String(row.municipality_id || "").trim())
      .filter(Boolean)
  );
}

async function getSystemUserId() {
  await pool.query(
    `INSERT INTO users (email, display_name)
     VALUES ('system@transparency-radar.local', 'System')
     ON CONFLICT (email) DO NOTHING`
  );
  const r = await pool.query(
    `SELECT id FROM users WHERE email='system@transparency-radar.local' LIMIT 1`
  );
  return r.rows[0].id;
}

// Kept for the Tirana manual endpoint (debugging)
async function getMunicipalityIdByName(nameSq) {
  const r = await pool.query(
    `SELECT id FROM municipalities WHERE name_sq = $1 LIMIT 1`,
    [nameSq]
  );
  return r.rowCount ? r.rows[0].id : null;
}

async function loadRegistryRow(municipalityId) {
  const reg = await pool.query(
    `
    SELECT *
    FROM source_registry
    WHERE municipality_id = $1
    ORDER BY is_primary DESC, updated_at DESC
    LIMIT 1
    `,
    [municipalityId]
  );
  return reg.rowCount ? reg.rows[0] : null;
}

function applyYearTemplate(url, year) {
  if (!url) return url;
  if (url.includes("{year}")) return url.replace("{year}", String(year));
  return url;
}

function decodeUrlPartLower(value) {
  const s = String(value || "");
  if (!s) return "";
  try {
    return decodeURIComponent(s).toLowerCase();
  } catch {
    return s.toLowerCase();
  }
}

async function fetchHtmlForDiscovery(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_REQUEST_TIMEOUT_MS);
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "sq-AL,sq;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };

  try {
    const response = await fetch(url, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    const finalUrl = String(response.url || url);
    if (!response.ok) {
      const err = new Error(`Fetch failed: ${response.status} ${response.statusText}`);
      err.code = `HTTP_${response.status}`;
      err.final_url = finalUrl;
      throw err;
    }
    const html = await response.text();
    return {
      finalUrl,
      html,
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      const timeoutErr = new Error(`Request timed out after ${SCRAPE_REQUEST_TIMEOUT_MS}ms: ${url}`);
      timeoutErr.code = "TIMEOUT";
      timeoutErr.last_error_type = "TIMEOUT";
      timeoutErr.final_url = url;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function extractSameHostKeywordLinks({
  startUrl,
  html,
  keywords = KONSULTIME_FALLBACK_KEYWORDS,
  maxLinks = KONSULTIME_FALLBACK_MAX_LINKS,
}) {
  if (!startUrl || !html) return [];
  const normalizedKeywords = keywords.map((k) => String(k || "").toLowerCase()).filter(Boolean);
  if (!normalizedKeywords.length) return [];

  const baseHost = getHost(startUrl);
  if (!baseHost) return [];
  const startNoHash = String(startUrl).split("#")[0];
  const links = new Set();
  const $ = cheerio.load(html);

  $("a[href]").each((_, el) => {
    if (links.size >= maxLinks) return;
    const href = String($(el).attr("href") || "").trim();
    if (!href) return;

    const hrefLower = decodeUrlPartLower(href);
    const hrefHasKeyword = normalizedKeywords.some((keyword) => hrefLower.includes(keyword));
    if (!hrefHasKeyword) return;

    const abs = makeAbsoluteUrl(startUrl, href);
    if (!abs) return;
    if (getHost(abs) !== baseHost) return;
    if (/\.(pdf|doc|docx|xls|xlsx|zip|rar)(\?|#|$)/i.test(abs)) return;

    const noHash = abs.split("#")[0];
    if (!noHash || noHash === startNoHash) return;
    links.add(noHash);
  });

  return Array.from(links).slice(0, maxLinks);
}

function getHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function scrapeVendimeTarget({
  targetUrl,
  year,
  limit,
  municipalityKey = null,
  pageStart = 1,
}) {
  const host = getHost(targetUrl);
  if (host === "vendime.al" || host === "www.vendime.al") {
    const r = await scrapeVendimeAl({
      url: targetUrl,
      year,
      limit,
      expectedMunicipalityKey: municipalityKey,
      pageStart,
    });
    return { usedUrl: r.url, items: r.items, meta: r.meta || null };
  }
  if (host.endsWith("tirana.al")) {
    const r = await scrapeTiranaVendime({ year, limit, urlOverride: targetUrl });
    return { usedUrl: r.url, items: r.items, meta: null };
  }
  const r = await scrapeGenericDocuments({ url: targetUrl, limit });
  return { usedUrl: r.url, items: r.items, meta: null };
}

async function upsertVendimeItem({
  municipalityId,
  title,
  titleNormalized,
  publishedDate,
  sourceUrl,
  sourcePageUrl,
  sourceOrigin,
  dedupKey,
  shouldPublish,
  defaultStatus,
  systemUserId,
  sourceKind,
}) {
  const dateUnknown = publishedDate ? false : true;
  const incomingWeight = sourceKind === "official" ? 100 : 50;

  try {
    const upsert = await pool.query(
      `
      INSERT INTO items (
        municipality_id, category,
        title, title_normalized, summary,
        published_date, date_unknown, date_source,
        source_url, source_page_url, source_origin, source_url_missing_reason,
        collected_at, ingestion_method,
        dedup_key, possible_duplicate,
        status, created_by_user_id
      )
      VALUES (
        $1, 'Vendime',
        $2, $3, NULL,
        $4::date, $5, 'scrape_registry',
        $6, $7, $8, NULL,
        now(), 'scrape',
        $9, false,
        $10, $11
      )
      ON CONFLICT (municipality_id, category, dedup_key)
      DO UPDATE
      SET
        title = CASE
          WHEN $12::int > CASE WHEN lower(COALESCE(items.source_origin, '')) IN ('vendime.al', 'www.vendime.al') THEN 50 ELSE 100 END
            THEN EXCLUDED.title
          ELSE items.title
        END,
        title_normalized = CASE
          WHEN $12::int > CASE WHEN lower(COALESCE(items.source_origin, '')) IN ('vendime.al', 'www.vendime.al') THEN 50 ELSE 100 END
            THEN EXCLUDED.title_normalized
          ELSE items.title_normalized
        END,
        published_date = CASE
          WHEN items.published_date IS NULL AND EXCLUDED.published_date IS NOT NULL
            THEN EXCLUDED.published_date
          WHEN $12::int > CASE WHEN lower(COALESCE(items.source_origin, '')) IN ('vendime.al', 'www.vendime.al') THEN 50 ELSE 100 END
            THEN COALESCE(EXCLUDED.published_date, items.published_date)
          ELSE items.published_date
        END,
        date_unknown = CASE
          WHEN items.published_date IS NULL AND EXCLUDED.published_date IS NOT NULL
            THEN FALSE
          WHEN $12::int > CASE WHEN lower(COALESCE(items.source_origin, '')) IN ('vendime.al', 'www.vendime.al') THEN 50 ELSE 100 END
            THEN CASE WHEN COALESCE(EXCLUDED.published_date, items.published_date) IS NULL THEN TRUE ELSE FALSE END
          ELSE items.date_unknown
        END,
        source_url = CASE
          WHEN $12::int > CASE WHEN lower(COALESCE(items.source_origin, '')) IN ('vendime.al', 'www.vendime.al') THEN 50 ELSE 100 END
            THEN EXCLUDED.source_url
          ELSE items.source_url
        END,
        source_page_url = CASE
          WHEN $12::int > CASE WHEN lower(COALESCE(items.source_origin, '')) IN ('vendime.al', 'www.vendime.al') THEN 50 ELSE 100 END
            THEN EXCLUDED.source_page_url
          ELSE items.source_page_url
        END,
        source_origin = CASE
          WHEN $12::int > CASE WHEN lower(COALESCE(items.source_origin, '')) IN ('vendime.al', 'www.vendime.al') THEN 50 ELSE 100 END
            THEN EXCLUDED.source_origin
          ELSE items.source_origin
        END,
        status = CASE WHEN $13::boolean THEN 'published' ELSE items.status END,
        updated_at = now()
      WHERE
        (
          $12::int > CASE WHEN lower(COALESCE(items.source_origin, '')) IN ('vendime.al', 'www.vendime.al') THEN 50 ELSE 100 END
          OR (items.published_date IS NULL AND EXCLUDED.published_date IS NOT NULL)
        )
        OR ($13::boolean AND items.status <> 'published')
      RETURNING (xmax = 0) AS inserted
      `,
      [
        municipalityId,
        title,
        titleNormalized,
        publishedDate,
        dateUnknown,
        sourceUrl,
        sourcePageUrl,
        sourceOrigin,
        dedupKey,
        defaultStatus,
        systemUserId,
        incomingWeight,
        shouldPublish,
      ]
    );

    if (upsert.rowCount === 0) return "skipped";
    return upsert.rows[0]?.inserted ? "inserted" : "updated";
  } catch (err) {
    // Existing rows may still have legacy dedup keys. If source_url already exists,
    // reconcile in place instead of failing the whole scrape run.
    if (err?.code === "23505") {
      const existingByUrl = await pool.query(
        `
        SELECT id, municipality_id, category, dedup_key, published_date, source_origin, status
        FROM items
        WHERE source_url = $1
        LIMIT 1
        `,
        [sourceUrl]
      );

      if (existingByUrl.rowCount === 0) throw err;
      const row = existingByUrl.rows[0];
      const sameBucket =
        String(row.municipality_id) === String(municipalityId) &&
        String(row.category) === "Vendime";
      if (!sameBucket) return "skipped";

      const existingWeight = vendimeSourceWeight(row.source_origin);
      const incomingPreferred = incomingWeight > existingWeight;
      const betterDate = !row.published_date && !!publishedDate;
      const needsPublish = shouldPublish && row.status !== "published";
      const needsDedupUpgrade = String(row.dedup_key || "") !== String(dedupKey || "");

      if (!incomingPreferred && !betterDate && !needsPublish && !needsDedupUpgrade) {
        return "skipped";
      }

      const mergedDate = betterDate
        ? publishedDate
        : incomingPreferred
          ? (publishedDate || row.published_date || null)
          : row.published_date;
      const mergedDateUnknown = mergedDate ? false : true;

      await pool.query(
        `
        UPDATE items
        SET
          title = CASE WHEN $2::boolean THEN $3 ELSE title END,
          title_normalized = CASE WHEN $2::boolean THEN $4 ELSE title_normalized END,
          published_date = $5::date,
          date_unknown = $6,
          source_url = CASE WHEN $2::boolean THEN $7 ELSE source_url END,
          source_page_url = CASE WHEN $2::boolean THEN $8 ELSE source_page_url END,
          source_origin = CASE WHEN $2::boolean THEN $9 ELSE source_origin END,
          dedup_key = CASE
            WHEN $10::boolean
             AND NOT EXISTS (
               SELECT 1
               FROM items i2
               WHERE i2.municipality_id = $11
                 AND i2.category = 'Vendime'
                 AND i2.dedup_key = $12
                 AND i2.id <> items.id
             )
              THEN $12
            ELSE dedup_key
          END,
          status = CASE WHEN $13::boolean THEN 'published' ELSE status END,
          updated_at = now()
        WHERE id = $1
        `,
        [
          row.id,
          incomingPreferred,
          title,
          titleNormalized,
          mergedDate,
          mergedDateUnknown,
          sourceUrl,
          sourcePageUrl,
          sourceOrigin,
          needsDedupUpgrade,
          municipalityId,
          dedupKey,
          shouldPublish,
        ]
      );

      return "updated";
    }

    // Fallback for deployments where unique (municipality_id, category, dedup_key)
    // was not created yet. Keeps ingestion non-breaking.
    if (err?.code !== "42P10") throw err;

    const existing = await pool.query(
      `
      SELECT id, title, title_normalized, published_date, date_unknown,
             source_url, source_page_url, source_origin, status
      FROM items
      WHERE municipality_id = $1
        AND category = 'Vendime'
        AND dedup_key = $2
      LIMIT 1
      `,
      [municipalityId, dedupKey]
    );

    if (existing.rowCount === 0) {
      const ins = await pool.query(
        `
        INSERT INTO items (
          municipality_id, category,
          title, title_normalized, summary,
          published_date, date_unknown, date_source,
          source_url, source_page_url, source_origin, source_url_missing_reason,
          collected_at, ingestion_method,
          dedup_key, possible_duplicate,
          status, created_by_user_id
        )
        VALUES (
          $1, 'Vendime',
          $2, $3, NULL,
          $4::date, $5, 'scrape_registry',
          $6, $7, $8, NULL,
          now(), 'scrape',
          $9, false,
          $10, $11
        )
        ON CONFLICT (source_url) WHERE source_url IS NOT NULL
        DO NOTHING
        RETURNING id
        `,
        [
          municipalityId,
          title,
          titleNormalized,
          publishedDate,
          dateUnknown,
          sourceUrl,
          sourcePageUrl,
          sourceOrigin,
          dedupKey,
          defaultStatus,
          systemUserId,
        ]
      );
      return ins.rowCount === 1 ? "inserted" : "skipped";
    }

    const row = existing.rows[0];
    const existingWeight = vendimeSourceWeight(row.source_origin);
    const incomingPreferred = incomingWeight > existingWeight;
    const betterDate = !row.published_date && !!publishedDate;
    const needsPublish = shouldPublish && row.status !== "published";

    if (!incomingPreferred && !betterDate && !needsPublish) return "skipped";

    const mergedDate = betterDate
      ? publishedDate
      : incomingPreferred
        ? (publishedDate || row.published_date || null)
        : row.published_date;
    const mergedDateUnknown = mergedDate ? false : true;

    await pool.query(
      `
      UPDATE items
      SET
        title = CASE WHEN $2::boolean THEN $3 ELSE title END,
        title_normalized = CASE WHEN $2::boolean THEN $4 ELSE title_normalized END,
        published_date = $5::date,
        date_unknown = $6,
        source_url = CASE WHEN $2::boolean THEN $7 ELSE source_url END,
        source_page_url = CASE WHEN $2::boolean THEN $8 ELSE source_page_url END,
        source_origin = CASE WHEN $2::boolean THEN $9 ELSE source_origin END,
        status = CASE WHEN $10::boolean THEN 'published' ELSE status END,
        updated_at = now()
      WHERE id = $1
      `,
      [
        row.id,
        incomingPreferred,
        title,
        titleNormalized,
        mergedDate,
        mergedDateUnknown,
        sourceUrl,
        sourcePageUrl,
        sourceOrigin,
        shouldPublish,
      ]
    );

    return "updated";
  }
}

// cache Tirana id to avoid querying every run
let _cachedTiranaId = null;
async function getTiranaId() {
  if (_cachedTiranaId) return _cachedTiranaId;
  const r = await pool.query(`SELECT id FROM municipalities WHERE name_key='tirane' LIMIT 1`);
  _cachedTiranaId = r.rowCount ? r.rows[0].id : null;
  return _cachedTiranaId;
}

const DASHBOARD_PROKURIME_CACHE_TTL_MS = 60 * 1000;
const dashboardProkurimePieCache = new Map();

function cleanupDashboardProkurimePieCache() {
  const now = Date.now();
  for (const [key, cacheEntry] of dashboardProkurimePieCache.entries()) {
    if (!cacheEntry || cacheEntry.expiresAt <= now) {
      dashboardProkurimePieCache.delete(key);
    }
  }
}

function invalidateDashboardProkurimePieCache() {
  dashboardProkurimePieCache.clear();
}

// --------------------
// Routes
// --------------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Transparency Radar API is running",
    routes: [
      "/health",
      "/api/debug/db-encoding",
      "/api/municipalities",
      "/api/dashboard/prokurime/pie",
      "/api/admin/coverage",
      "/api/admin/items/manual",
      "/api/admin/files/:id",
      "/api/admin/publish",
      "/api/admin/source/checked",
      "/api/feed",
      "/api/search",
      "/api/items/:id",
      "/api/public/files/:id",
      "/api/scrape/tirana/vendime",
      "/api/scrape/run",
    ],
  });
});

app.get("/health", async (req, res) => {
  const status = {
    ok: true,
    db: "ok",
    redis: "ok",
    meili: "ok",
  };
  const errors = {};

  try {
    await checkDb();
  } catch (err) {
    status.ok = false;
    status.db = "error";
    errors.db = formatCheckError(err, "Database check failed");
  }

  try {
    await checkRedisPing();
  } catch (err) {
    status.ok = false;
    status.redis = "error";
    errors.redis = formatCheckError(err, "Redis check failed");
  }

  try {
    await checkMeiliHealth();
  } catch (err) {
    status.ok = false;
    status.meili = "error";
    errors.meili = formatCheckError(err, "Meilisearch check failed");
  }

  if (status.ok) {
    return res.json(status);
  }

  return res.status(503).json({
    ...status,
    errors,
  });
});

app.get("/api/debug/db-encoding", async (req, res) => {
  try {
    const r = await pool.query("SHOW client_encoding");
    res.json({ ok: true, client_encoding: r.rows[0].client_encoding });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "db_error",
      message: safePublicErrorMessage(err, "Database operation failed"),
    });
  }
});

app.get("/api/municipalities", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name_sq, name_key, county FROM municipalities ORDER BY name_sq ASC`
    );
    res.json({
      ok: true,
      total: r.rowCount,
      items: r.rows,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "db_error",
      message: safePublicErrorMessage(err, "Database operation failed"),
    });
  }
});

app.get("/api/dashboard/prokurime/pie", async (req, res) => {
  try {
    const municipalityRaw = req.query.municipality;
    const municipality = String(municipalityRaw || "")
      .trim()
      .toLowerCase();
    if (!municipality || !/^[a-z0-9-]{1,64}$/.test(municipality)) {
      return badRequest(
        res,
        "Invalid municipality. Use lowercase slug format (a-z, 0-9, hyphen), max 64 chars."
      );
    }

    const yearProvided =
      req.query.year !== undefined && req.query.year !== null && String(req.query.year).trim() !== "";
    const requestedYear = parseYear(req.query.year, null);
    if (yearProvided && requestedYear === null) {
      return badRequest(res, "Invalid year. year must be an integer between 2000 and 2100.");
    }

    const top = parseTopInt(req.query.top, 5, 1, 20);
    if (top === null) {
      return badRequest(res, "Invalid top. top must be an integer between 1 and 20.");
    }

    const municipalityId = await getMunicipalityId({ municipality });
    if (!municipalityId) {
      return badRequest(res, "Invalid municipality (name_key/name_sq) or municipality_id");
    }
    const municipalityNameKey = (await getMunicipalityNameKeyById(municipalityId)) || municipality;
    const year = await resolveDashboardYear({ municipalityId, requestedYear });

    cleanupDashboardProkurimePieCache();
    const cacheKey = `${municipalityNameKey}|${year}|${top}|all`;
    const now = Date.now();
    const cached = dashboardProkurimePieCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return res.json(cached.payload);
    }

    const periodStart = `${year}-01-01`;
    const periodEnd = `${year + 1}-01-01`;
    const groupedResult = await pool.query(
      `
      SELECT
        COALESCE(NULLIF(btrim(pr.cpv_code), ''), 'UNKNOWN') AS cpv_code,
        SUM(pr.amount_value)::numeric AS amount,
        COUNT(*)::int AS count
      FROM prokurime_records pr
      JOIN items i ON i.id = pr.item_id
      WHERE i.municipality_id = $1
        AND i.category = 'Prokurime'
        AND i.published_date >= $2::date
        AND i.published_date < $3::date
        AND pr.amount_value IS NOT NULL
        AND ${PROKURIME_ALL_CURRENCY_SQL_PREDICATE}
      GROUP BY COALESCE(NULLIF(btrim(pr.cpv_code), ''), 'UNKNOWN')
      ORDER BY SUM(pr.amount_value) DESC, cpv_code ASC
      `,
      [municipalityId, periodStart, periodEnd]
    );

    const rows = groupedResult.rows.map((row) => {
      const amountCents = Math.round(Number(row.amount || 0) * 100);
      return {
        cpv_code: String(row.cpv_code || "UNKNOWN"),
        label: String(row.cpv_code || "UNKNOWN"),
        amountCents: Number.isFinite(amountCents) ? amountCents : 0,
        count: Number(row.count || 0),
      };
    });

    const totalAmountCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
    const totalCount = rows.reduce((sum, row) => sum + row.count, 0);
    const topRows = rows.slice(0, top);
    const topAmountCents = topRows.reduce((sum, row) => sum + row.amountCents, 0);
    const topCount = topRows.reduce((sum, row) => sum + row.count, 0);
    const otherAmountCents = Math.max(0, totalAmountCents - topAmountCents);
    const otherCount = Math.max(0, totalCount - topCount);

    const buckets = [
      ...topRows.map((row) => ({
        cpv_code: row.cpv_code,
        label: row.label,
        amount: row.amountCents / 100,
        count: row.count,
      })),
      {
        cpv_code: "other",
        label: "Other",
        amount: otherAmountCents / 100,
        count: otherCount,
      },
    ];

    const payload = {
      ok: true,
      municipality: municipalityNameKey,
      year,
      currency: "ALL",
      total_amount: totalAmountCents / 100,
      buckets,
    };

    dashboardProkurimePieCache.set(cacheKey, {
      expiresAt: now + DASHBOARD_PROKURIME_CACHE_TTL_MS,
      payload,
    });

    return res.json(payload);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: safePublicErrorMessage(err, "Server operation failed"),
    });
  }
});

app.get("/api/status/vendime", async (req, res) => {
  try {
    const summary = await fetchVendimeStatusSummary(pool);
    res.json(summary);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "db_error",
      message: safePublicErrorMessage(err, "Database operation failed"),
    });
  }
});

app.get("/api/admin/coverage", requireAdmin, async (req, res) => {
  try {
    const summary = await fetchCoverageSummary(pool);
    const items = Array.isArray(summary.items)
      ? summary.items.map((row) => {
          const latestAttachmentId = String(row.latest_attachment_id || "").trim() || null;
          const latestAttachmentItemStatus =
            String(row.latest_attachment_item_status || "").trim().toLowerCase() || null;
          return {
            ...row,
            latest_admin_file_url: latestAttachmentId
              ? buildAdminFilePath(latestAttachmentId)
              : null,
            latest_public_file_url:
              latestAttachmentId && latestAttachmentItemStatus === "published"
                ? buildPublicFilePath(latestAttachmentId)
                : null,
          };
        })
      : [];
    res.json({
      ...summary,
      items,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "db_error",
      message: safePublicErrorMessage(err, "Database operation failed"),
    });
  }
});

app.post("/api/admin/source/checked", requireAdmin, async (req, res) => {
  try {
    const municipality =
      req.query.municipality !== undefined ? String(req.query.municipality) : req.body?.municipality;
    const municipality_id =
      req.query.municipality_id !== undefined
        ? String(req.query.municipality_id)
        : req.body?.municipality_id;
    const requestedCategory =
      req.query.category !== undefined ? req.query.category : req.body?.category;
    const category = resolveSupportedCategory(requestedCategory, null);
    if (!category) {
      return badRequest(
        res,
        `Invalid category. Supported categories: ${SUPPORTED_CATEGORIES.join(", ")}`
      );
    }

    const checkedRaw =
      req.query.checked !== undefined ? req.query.checked : req.body?.checked;
    const checked = parseBooleanWithDefault(checkedRaw, true);
    const municipalityId = await getMunicipalityId({ municipality, municipality_id });
    if (!municipalityId) {
      return badRequest(res, "Invalid municipality (name_key/name_sq) or municipality_id");
    }

    const checkedColumn = getCheckedColumnForCategory(category);
    if (!checkedColumn) {
      return badRequest(res, "Unsupported category for checked state.");
    }

    const registryRow = await loadRegistryRow(municipalityId);
    if (!registryRow) {
      return res.status(404).json({
        ok: false,
        error: "no_registry",
        message: "No source_registry row found for this municipality",
      });
    }

    await pool.query(
      `
      UPDATE source_registry
      SET ${checkedColumn} = $2,
          updated_at = now()
      WHERE id = $1
      `,
      [registryRow.id, checked]
    );

    const updatedRow = await loadRegistryRow(municipalityId);
    return res.json({
      ok: true,
      municipality: municipality || (await getMunicipalityNameKeyById(municipalityId)) || municipalityId,
      municipality_id: municipalityId,
      category,
      source_registry_id: registryRow.id,
      checked: isCategoryChecked(updatedRow, category),
      checked_column: checkedColumn,
      next: "Next: run scrape or publish drafts for this municipality/category.",
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "db_error",
      message: safePublicErrorMessage(err, "Database operation failed"),
    });
  }
});

app.post("/api/admin/publish", requireAdmin, async (req, res) => {
  try {
    const municipality =
      req.query.municipality !== undefined ? String(req.query.municipality) : req.body?.municipality;
    const municipality_id =
      req.query.municipality_id !== undefined
        ? String(req.query.municipality_id)
        : req.body?.municipality_id;
    const requestedCategory =
      req.query.category !== undefined ? req.query.category : req.body?.category;
    const category = resolveSupportedCategory(requestedCategory, null);
    if (!category) {
      return badRequest(
        res,
        `Invalid category. Supported categories: ${SUPPORTED_CATEGORIES.join(", ")}`
      );
    }

    const yearProvided =
      (req.query.year !== undefined && req.query.year !== null && String(req.query.year).trim() !== "") ||
      (req.body?.year !== undefined && req.body?.year !== null && String(req.body.year).trim() !== "");
    const yearRaw = req.query.year !== undefined ? req.query.year : req.body?.year;
    const year = parseYear(yearRaw, null);
    if (yearProvided && year === null) {
      return badRequest(res, "Invalid year. year must be an integer between 2000 and 2100.");
    }

    const municipalityId = await getMunicipalityId({ municipality, municipality_id });
    if (!municipalityId) {
      return badRequest(res, "Invalid municipality (name_key/name_sq) or municipality_id");
    }

    const publishUpdate = await pool.query(
      `
      WITH updated_items AS (
        UPDATE items
        SET status = 'published',
            updated_at = now()
        WHERE municipality_id = $1
          AND category = $2
          AND status <> 'published'
          AND (
            $3::int IS NULL OR (
              published_date IS NOT NULL
              AND EXTRACT(YEAR FROM published_date)::int = $3
            )
          )
        RETURNING id
      ),
      updated_items_with_attachments AS (
        SELECT DISTINCT ui.id
        FROM updated_items ui
        JOIN attachments a ON a.item_id = ui.id
      ),
      updated_attachments AS (
        SELECT COUNT(*)::int AS attachments_now_public_count
        FROM attachments a
        JOIN updated_items ui ON ui.id = a.item_id
      )
      SELECT
        (SELECT COUNT(*)::int FROM updated_items) AS published_updated,
        (SELECT COUNT(*)::int FROM updated_items_with_attachments) AS published_with_attachments,
        COALESCE((SELECT attachments_now_public_count FROM updated_attachments), 0)::int
          AS attachments_now_public_count
      `,
      [municipalityId, category, year]
    );
    const publishStats = publishUpdate.rows[0] || {};
    const publishedUpdated = Number(publishStats.published_updated || 0);
    const publishedWithAttachments = Number(publishStats.published_with_attachments || 0);
    const attachmentsNowPublicCount = Number(publishStats.attachments_now_public_count || 0);

    return res.json({
      ok: true,
      municipality: municipality || (await getMunicipalityNameKeyById(municipalityId)) || municipalityId,
      municipality_id: municipalityId,
      category,
      year: year || null,
      published_updated: publishedUpdated,
      published_with_attachments: publishedWithAttachments,
      attachments_now_public_count: attachmentsNowPublicCount,
      next: "Next: verify coverage and public feed counts.",
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "db_error",
      message: safePublicErrorMessage(err, "Database operation failed"),
    });
  }
});

app.post("/api/admin/items/manual", requireAdmin, parseManualUpload, async (req, res) => {
  const municipality =
    req.query.municipality !== undefined ? String(req.query.municipality) : req.body?.municipality;
  const municipality_id =
    req.query.municipality_id !== undefined
      ? String(req.query.municipality_id)
      : req.body?.municipality_id;
  const requestedCategory =
    req.query.category !== undefined ? req.query.category : req.body?.category;
  const category = resolveSupportedCategory(requestedCategory, null);
  if (!category) {
    return badRequest(
      res,
      `Invalid category. Supported categories: ${SUPPORTED_CATEGORIES.join(", ")}`
    );
  }

  const titleRaw = req.query.title !== undefined ? req.query.title : req.body?.title;
  const title = String(titleRaw || "").trim();
  if (!title) {
    return badRequest(res, "Invalid title. title is required.");
  }

  const publishedDateRaw =
    req.query.published_date !== undefined ? req.query.published_date : req.body?.published_date;
  let publishedDate = null;
  if (
    publishedDateRaw !== undefined &&
    publishedDateRaw !== null &&
    String(publishedDateRaw).trim() !== ""
  ) {
    publishedDate = sanitizeISODate(String(publishedDateRaw).trim());
    if (!publishedDate) {
      return badRequest(res, "Invalid published_date. Expected YYYY-MM-DD.");
    }
  }

  const sourceUrlRaw = req.query.source_url !== undefined ? req.query.source_url : req.body?.source_url;
  const sourceUrlProvided =
    sourceUrlRaw !== undefined && sourceUrlRaw !== null && String(sourceUrlRaw).trim() !== "";
  const sourceUrl = sourceUrlProvided ? parseHttpUrl(sourceUrlRaw) : null;
  if (sourceUrlProvided && !sourceUrl) {
    return badRequest(res, "Invalid source_url. Use an absolute http/https URL.");
  }

  const sourcePageUrlRaw =
    req.query.source_page_url !== undefined
      ? req.query.source_page_url
      : req.body?.source_page_url;
  const sourcePageUrlProvided =
    sourcePageUrlRaw !== undefined &&
    sourcePageUrlRaw !== null &&
    String(sourcePageUrlRaw).trim() !== "";
  const sourcePageUrl = sourcePageUrlProvided ? parseHttpUrl(sourcePageUrlRaw) : null;
  if (sourcePageUrlProvided && !sourcePageUrl) {
    return badRequest(res, "Invalid source_page_url. Use an absolute http/https URL.");
  }

  const uploadFile = req.file && Buffer.isBuffer(req.file.buffer) ? req.file : null;
  if ((sourceUrlProvided && uploadFile) || (!sourceUrlProvided && !uploadFile)) {
    return badRequest(res, "Provide exactly one of source_url or file.");
  }

  if (uploadFile && !hasPdfMagicBytes(uploadFile.buffer)) {
    return badRequest(res, "Invalid file. Uploaded file must be a PDF.");
  }

  let municipalityId = null;
  try {
    municipalityId = await getMunicipalityId({ municipality, municipality_id });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "db_error",
      message: safePublicErrorMessage(err, "Database operation failed"),
    });
  }
  if (!municipalityId) {
    return badRequest(res, "Invalid municipality (name_key/name_sq) or municipality_id");
  }

  const titleNormalized = normalizeTitle(title);
  const sourceOrigin = getHost(sourcePageUrl || sourceUrl || "") || null;
  const dedupKey = manualDedupKeyV1({
    municipalityId,
    category,
    titleNormalized,
    publishedDate,
    sourceUrl,
    fileSha256: uploadFile
      ? crypto.createHash("sha256").update(uploadFile.buffer).digest("hex")
      : null,
  });
  const dateUnknown = publishedDate ? false : true;
  const sourceUrlMissingReason = sourceUrl ? null : "manual_upload";

  let stagedFilePath = null;
  let attachmentId = null;
  let itemId = null;
  let systemUserId = null;
  let client = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    systemUserId = await getSystemUserId();

    const itemInsert = await client.query(
      `
      INSERT INTO items (
        municipality_id,
        category,
        title,
        title_normalized,
        published_date,
        date_unknown,
        source_url,
        source_page_url,
        source_origin,
        source_url_missing_reason,
        ingestion_method,
        dedup_key,
        status,
        created_by_user_id
      )
      VALUES (
        $1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, 'manual', $11, 'draft', $12
      )
      RETURNING id
      `,
      [
        municipalityId,
        category,
        title,
        titleNormalized,
        publishedDate,
        dateUnknown,
        sourceUrl,
        sourcePageUrl,
        sourceOrigin,
        sourceUrlMissingReason,
        dedupKey,
        systemUserId,
      ]
    );
    itemId = itemInsert.rows[0].id;

    if (uploadFile) {
      const fileUuid = crypto.randomUUID();
      const storedFileName = `${fileUuid}.pdf`;
      const storageUri = buildLocalUploadStorageUri(storedFileName);
      const sha256 = crypto.createHash("sha256").update(uploadFile.buffer).digest("hex");
      stagedFilePath = path.resolve(UPLOADS_DIR, storedFileName);

      const attachmentInsert = await client.query(
        `
        INSERT INTO attachments (
          item_id,
          file_name,
          mime_type,
          size_bytes,
          storage_uri,
          sha256,
          source_url
        )
        VALUES (
          $1, $2, 'application/pdf', $3, $4, $5, NULL
        )
        RETURNING id
        `,
        [itemId, storedFileName, uploadFile.size, storageUri, sha256]
      );
      attachmentId = attachmentInsert.rows[0].id;

      await fsp.mkdir(UPLOADS_DIR, { recursive: true });
      await fsp.writeFile(stagedFilePath, uploadFile.buffer);
    }

    await client.query("COMMIT");
  } catch (err) {
    try {
      if (client) await client.query("ROLLBACK");
    } catch {}
    if (stagedFilePath) {
      try {
        await fsp.unlink(stagedFilePath);
      } catch {}
    }
    if (String(err?.code || "") === "23505") {
      return res.status(409).json({
        ok: false,
        error: "conflict",
        message: "A matching item already exists.",
      });
    }
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: safePublicErrorMessage(err, "Manual item creation failed"),
    });
  } finally {
    if (client) client.release();
  }

  return res.status(201).json({
    ok: true,
    item_id: itemId,
    attachment_id: attachmentId,
    municipality_id: municipalityId,
    category,
    status: "draft",
  });
});

app.get("/api/public/files/:id", async (req, res) => {
  try {
    const attachmentId = String(req.params.id || "").trim();
    const file = await resolveAttachmentForServing(attachmentId, {
      publicOnlyPublished: true,
    });
    if (!file) {
      return res.status(404).json({
        ok: false,
        error: "not_found",
        message: "File not found.",
      });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(file.sizeBytes));
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${file.fileName.replace(/"/g, "")}"`
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    const stream = fs.createReadStream(file.localPath);
    stream.on("error", () => {
      if (!res.headersSent) {
        return res.status(404).json({
          ok: false,
          error: "not_found",
          message: "File not found.",
        });
      }
      return res.destroy();
    });
    return stream.pipe(res);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: safePublicErrorMessage(err, "File read failed"),
    });
  }
});

app.get("/api/admin/files/:id", requireAdmin, async (req, res) => {
  try {
    const attachmentId = String(req.params.id || "").trim();
    const file = await resolveAttachmentForServing(attachmentId, {
      publicOnlyPublished: false,
    });
    if (!file) {
      return res.status(404).json({
        ok: false,
        error: "not_found",
        message: "File not found.",
      });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(file.sizeBytes));
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${file.fileName.replace(/"/g, "")}"`
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    const stream = fs.createReadStream(file.localPath);
    stream.on("error", () => {
      if (!res.headersSent) {
        return res.status(404).json({
          ok: false,
          error: "not_found",
          message: "File not found.",
        });
      }
      return res.destroy();
    });
    return stream.pipe(res);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: safePublicErrorMessage(err, "File read failed"),
    });
  }
});

// Public feed from v_public_feed (only published rows)
app.get("/api/feed", async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    if (page === null) {
      return badRequest(res, "Invalid page. page must be an integer >= 1.");
    }

    const limit = parsePositiveInt(req.query.limit, 20);
    if (limit === null || limit > 100) {
      return badRequest(res, "Invalid limit. limit must be an integer between 1 and 100.");
    }

    const municipalityRaw = req.query.municipality;
    let municipality = null;
    if (municipalityRaw !== undefined) {
      municipality = String(municipalityRaw).trim().toLowerCase();
      if (!municipality || !/^[a-z0-9-]{1,64}$/.test(municipality)) {
        return badRequest(
          res,
          "Invalid municipality. Use lowercase slug format (a-z, 0-9, hyphen), max 64 chars."
        );
      }
    }

    const qRaw = req.query.q;
    let q = null;
    if (qRaw !== undefined) {
      q = String(qRaw).trim();
      if (!q) {
        return badRequest(res, "Invalid q. q must not be empty or whitespace.");
      }
      if (q.length > 120) {
        return badRequest(res, "Invalid q. q must be at most 120 characters.");
      }
    }

    const categoryRaw = req.query.category;
    let category = null;
    if (categoryRaw !== undefined) {
      category = resolveSupportedCategory(categoryRaw, null);
      if (!category) {
        return badRequest(
          res,
          `Invalid category. Allowed values: ${SUPPORTED_CATEGORIES.join(", ")}.`
        );
      }
    }

    const yearProvided =
      req.query.year !== undefined &&
      req.query.year !== null &&
      String(req.query.year).trim() !== "";
    const year = parseYear(req.query.year, null);
    if (yearProvided && year === null) {
      return badRequest(res, "Invalid year. year must be an integer between 2000 and 2100.");
    }

    const sort = parseSort(req.query.sort, "newest");
    if (!sort) {
      return badRequest(res, "Invalid sort. Allowed values: newest, oldest.");
    }
    const orderDirection = sort === "oldest" ? "ASC" : "DESC";

    const offset = (page - 1) * limit;

    const params = [];
    const where = [];

    if (municipality) {
      const municipalityId = await getMunicipalityId({ municipality });
      if (municipalityId) {
        params.push(municipalityId);
        where.push(`municipality_id = $${params.length}`);
      } else {
        // Keep API shape stable for unknown municipality keys: return empty result set.
        where.push("1 = 0");
      }
    }

    if (q) {
      const feedColumns = await getVPublicFeedColumns();
      const qParam = `%${q}%`;
      const textClauses = [];

      if (feedColumns.has("title")) {
        params.push(qParam);
        textClauses.push(`title ILIKE $${params.length}`);
      }
      if (feedColumns.has("summary")) {
        params.push(qParam);
        textClauses.push(`summary ILIKE $${params.length}`);
      }
      if (textClauses.length > 0) {
        where.push(`(${textClauses.join(" OR ")})`);
      }
    }

    if (category) {
      params.push(category);
      where.push(`category = $${params.length}`);
    }

    if (yearProvided) {
      params.push(year);
      where.push(
        `published_date IS NOT NULL AND EXTRACT(YEAR FROM published_date)::int = $${params.length}`
      );
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM v_public_feed
      ${whereSql};
    `;
    const countResult = await pool.query(countSql, params);
    const total = countResult.rows[0]?.total || 0;

    const itemParams = [...params];
    itemParams.push(limit);
    const limitIdx = itemParams.length;
    itemParams.push(offset);
    const offsetIdx = itemParams.length;

    const itemsSql = `
      SELECT
        v.id,
        v.municipality AS municipality_name,
        v.municipality_key AS municipality_name_key,
        v.category,
        v.title,
        v.source_url,
        v.published_date AS published_at,
        v.created_at,
        v.collected_at,
        COALESCE(att.attachment_count, 0)::int AS attachment_count,
        att.primary_attachment_id
      FROM v_public_feed v
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS attachment_count,
          (ARRAY_AGG(a.id::text ORDER BY a.created_at ASC, a.id ASC))[1] AS primary_attachment_id
        FROM attachments a
        WHERE a.item_id = v.id
      ) att ON TRUE
      ${whereSql}
      ORDER BY
        COALESCE(v.published_date::timestamp, v.collected_at) ${orderDirection},
        v.collected_at ${orderDirection},
        v.id ${orderDirection}
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;

    const itemsResult = await pool.query(itemsSql, itemParams);
    const items = itemsResult.rows.map((row) => {
      const primaryAttachmentId = String(row.primary_attachment_id || "").trim() || null;
      return {
        ...row,
        attachment_count: Number(row.attachment_count || 0),
        primary_attachment_id: primaryAttachmentId,
        primary_attachment_public_url: primaryAttachmentId
          ? buildPublicFilePath(primaryAttachmentId)
          : null,
      };
    });
    res.json({
      ok: true,
      page,
      limit,
      total,
      items,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "server_error",
      message: safePublicErrorMessage(err, "Server operation failed"),
    });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const qRaw = req.query.q;
    const q = String(qRaw || "").trim();
    if (!q) {
      return badRequest(res, "Invalid q. q is required and must not be empty.");
    }
    if (q.length > 120) {
      return badRequest(res, "Invalid q. q must be at most 120 characters.");
    }

    const page = parsePositiveInt(req.query.page, 1);
    if (page === null) {
      return badRequest(res, "Invalid page. page must be an integer >= 1.");
    }

    const limit = parsePositiveInt(req.query.limit, 20);
    if (limit === null || limit > 50) {
      return badRequest(res, "Invalid limit. limit must be an integer between 1 and 50.");
    }

    const municipalityRaw = req.query.municipality;
    let municipality = null;
    if (municipalityRaw !== undefined) {
      municipality = String(municipalityRaw).trim().toLowerCase();
      if (!municipality || !/^[a-z0-9-]{1,64}$/.test(municipality)) {
        return badRequest(
          res,
          "Invalid municipality. Use lowercase slug format (a-z, 0-9, hyphen), max 64 chars."
        );
      }
    }

    const categoryRaw = req.query.category;
    let category = null;
    if (categoryRaw !== undefined) {
      category = resolveSupportedCategory(categoryRaw, null);
      if (!category) {
        return badRequest(
          res,
          `Invalid category. Allowed values: ${SUPPORTED_CATEGORIES.join(", ")}.`
        );
      }
    }

    const yearProvided =
      req.query.year !== undefined &&
      req.query.year !== null &&
      String(req.query.year).trim() !== "";
    const year = parseYear(req.query.year, null);
    if (yearProvided && year === null) {
      return badRequest(res, "Invalid year. year must be an integer between 2000 and 2100.");
    }

    const sort = parseSort(req.query.sort, "newest");
    if (!sort) {
      return badRequest(res, "Invalid sort. Allowed values: newest, oldest.");
    }

    const offset = (page - 1) * limit;
    const searchPayload = {
      q,
      limit,
      offset,
      filter: buildMeiliFilter({
        municipality,
        category,
        year: yearProvided ? year : null,
      }),
      sort: getMeiliSortClause(sort),
      attributesToRetrieve: [
        "id",
        "title",
        "summary",
        "municipality_name",
        "municipality_name_key",
        "category",
        "published_at",
        "collected_at",
        "source_url",
        "source_host",
        "attachment_count",
        "primary_attachment_id",
        "primary_attachment_public_url",
      ],
    };

    const meiliResponse = await meiliRequest(
      "POST",
      `/indexes/${encodeURIComponent(SEARCH_INDEX_UID)}/search`,
      searchPayload
    );
    const hits = Array.isArray(meiliResponse?.hits) ? meiliResponse.hits : [];
    const total = Number(
      meiliResponse?.estimatedTotalHits ??
        meiliResponse?.totalHits ??
        meiliResponse?.total ??
        hits.length
    );

    const items = hits.map((hit) => {
      const primaryAttachmentId = String(hit?.primary_attachment_id || "").trim() || null;
      const publicFilePath = primaryAttachmentId ? buildPublicFilePath(primaryAttachmentId) : null;
      return {
        id: String(hit?.id || ""),
        title: String(hit?.title || ""),
        summary: hit?.summary || null,
        municipality_name: hit?.municipality_name || null,
        municipality_name_key: hit?.municipality_name_key || null,
        category: hit?.category || null,
        published_at: hit?.published_at || null,
        collected_at: hit?.collected_at || null,
        source_url: hit?.source_url || null,
        source_host: hit?.source_host || null,
        attachment_count: Number(hit?.attachment_count || 0),
        primary_attachment_id: primaryAttachmentId,
        primary_attachment_public_url:
          String(hit?.primary_attachment_public_url || "").trim() || publicFilePath,
      };
    });

    return res.json({
      ok: true,
      q,
      page,
      limit,
      total: Number.isFinite(total) ? total : 0,
      items,
    });
  } catch (err) {
    const statusCode = Number(err?.statusCode || 500);
    if (statusCode === 503) {
      return res.status(503).json({
        ok: false,
        error: "search_unavailable",
        message: "Search is temporarily unavailable.",
      });
    }
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: "Search request failed.",
    });
  }
});

app.get("/api/items/:id", async (req, res) => {
  try {
    const itemId = String(req.params.id || "").trim();
    if (!isUuid(itemId)) {
      return res.status(404).json({
        ok: false,
        error: "not_found",
        message: "Item not found.",
      });
    }

    const itemResult = await pool.query(
      `
      SELECT
        i.id,
        i.municipality_id,
        m.name_sq AS municipality_name,
        m.name_key AS municipality_name_key,
        i.category,
        i.title,
        i.summary,
        i.source_url,
        i.published_date AS published_at,
        i.collected_at,
        i.created_at,
        i.updated_at
      FROM items i
      JOIN municipalities m ON m.id = i.municipality_id
      WHERE i.id = $1
        AND i.status = 'published'
      LIMIT 1
      `,
      [itemId]
    );

    if (!itemResult.rowCount) {
      return res.status(404).json({
        ok: false,
        error: "not_found",
        message: "Item not found.",
      });
    }

    const attachmentResult = await pool.query(
      `
      SELECT
        a.id,
        a.file_name,
        a.mime_type,
        a.size_bytes,
        a.created_at
      FROM attachments a
      WHERE a.item_id = $1
      ORDER BY a.created_at ASC, a.id ASC
      `,
      [itemId]
    );

    const attachments = attachmentResult.rows.map((row) => ({
      id: row.id,
      file_name: row.file_name,
      mime_type: row.mime_type,
      size_bytes: Number(row.size_bytes || 0),
      created_at: row.created_at,
      public_file_url: buildPublicFilePath(row.id),
    }));
    const primaryAttachmentId =
      attachments.length > 0 ? String(attachments[0].id || "").trim() || null : null;

    return res.json({
      ok: true,
      item: itemResult.rows[0],
      attachments,
      attachment_count: attachments.length,
      primary_attachment_id: primaryAttachmentId,
      primary_attachment_public_url: primaryAttachmentId
        ? buildPublicFilePath(primaryAttachmentId)
        : null,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: safePublicErrorMessage(err, "Server operation failed"),
    });
  }
});

// ----------------------------
// Manual scraper: TIRANË → VENDIME (kept for debugging)
// ----------------------------
app.post("/api/scrape/tirana/vendime", async (req, res) => {
  try {
    const municipalityName = "Tiranë";
    const category = "Vendime";
    const year = parseYear(req.query.year, new Date().getUTCFullYear());
    if (year === null) {
      return badRequest(res, "Invalid year. year must be an integer between 2000 and 2100.");
    }
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));

    const municipalityId = await getMunicipalityIdByName(municipalityName);
    if (!municipalityId) {
      return res.status(404).json({
        ok: false,
        error: "not_found",
        message: `Municipality not found: ${municipalityName}`,
      });
    }

    const systemUserId = await getSystemUserId();

    const url = `https://tirana.al/kategoria-e-publikimit/vendime-te-keshillit-bashkiak-${year}-4290`;
    const result = await scrapeTiranaVendime({ year, limit, urlOverride: url });

    let inserted = 0;
    let skipped = 0;

    for (const it of result.items) {
      const sourceUrl = makeAbsoluteUrl(result.url, it.source_url);
      if (!sourceUrl) { skipped++; continue; }
      const sourcePageUrl = makeAbsoluteUrl(result.url, it.source_page_url || result.url);
      const sourceOrigin = getHost(sourcePageUrl || sourceUrl) || null;

      const safeDate = sanitizeISODate(it.published_date || null);
      const dateUnknown = safeDate ? false : true;
      const dedupKey = `vendime|${municipalityId}|${it.number || ""}|${sourceUrl || ""}`;

      const ins = await pool.query(
        `
        INSERT INTO items (
          municipality_id, category,
          title, title_normalized, summary,
          published_date, date_unknown, date_source,
          source_url, source_page_url, source_origin, source_url_missing_reason,
          collected_at, ingestion_method,
          dedup_key, possible_duplicate,
          status, created_by_user_id
        )
        VALUES (
          $1, $2,
          $3, $4, NULL,
          $5::date, $6, 'tirana_al_table',
          $7, $8, $9, NULL,
          now(), 'scrape',
          $10, false,
          'draft', $11
        )
        ON CONFLICT (source_url) WHERE source_url IS NOT NULL
        DO NOTHING
        RETURNING id
        `,
        [
          municipalityId,
          category,
          it.title,
          it.title_normalized || normalizeTitle(it.title),
          safeDate,
          dateUnknown,
          sourceUrl,
          sourcePageUrl,
          sourceOrigin,
          dedupKey,
          systemUserId,
        ]
      );

      if (ins.rowCount === 1) inserted++;
      else skipped++;
    }

    res.json({
      ok: true,
      municipality: municipalityName,
      category,
      year,
      scraped_from: result.url,
      parsed_rows_total: result.items.length,
      inserted,
      skipped,
      sample_title: result.items[0]?.title || null,
      next: "Next: use /api/scrape/run (registry-driven).",
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "scrape_error",
      message: safePublicErrorMessage(err, "Scrape failed"),
    });
  }
});

// ----------------------------
// Registry-driven scraper runner
// ----------------------------
app.post("/api/scrape/run", async (req, res) => {
  const startedAt = new Date();

  const municipality = req.query.municipality ? String(req.query.municipality) : null;
  const municipality_id = req.query.municipality_id ? String(req.query.municipality_id) : null;

  const requestedCategory =
    req.query.category !== undefined ? String(req.query.category) : "Vendime";
  const category = resolveSupportedCategory(requestedCategory, "Vendime");
  if (!category) {
    return res.status(400).json({
      ok: false,
      error: "unsupported_category",
      message: `Supported categories: ${SUPPORTED_CATEGORIES.join(", ")}`,
    });
  }
  const forceRun = String(req.query.force_run || "") === "true";
  const forcePublish =
    ["1", "true", "yes", "on"].includes(
      String(req.query.force_publish || "").trim().toLowerCase()
    );
  const debugEnabled = ["1", "true", "yes", "on"].includes(
    String(req.query.debug || "").trim().toLowerCase()
  );
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const offsetRaw =
    req.query.offset !== undefined && req.query.offset !== null
      ? req.query.offset
      : req.query.row_start;
  const offset = parseNonNegativeInt(offsetRaw, 0);
  if (offset === null) {
    return badRequest(res, "Invalid offset. offset (or row_start) must be an integer >= 0.");
  }
  const pageStart = parsePositiveInt(req.query.page_start, 1);
  if (pageStart === null) {
    return badRequest(res, "Invalid page_start. page_start must be an integer >= 1.");
  }
  const yearFilterRequested =
    req.query.year !== undefined &&
    req.query.year !== null &&
    String(req.query.year).trim() !== "";
  const year = parseYear(req.query.year, new Date().getUTCFullYear());
  if (year === null) {
    return badRequest(res, "Invalid year. year must be an integer between 2000 and 2100.");
  }

  let municipalityId = null;
  let registryRow = null;
  const hasMunicipalitySelector =
    (municipality !== null && String(municipality).trim() !== "") ||
    (municipality_id !== null && String(municipality_id).trim() !== "");
  const isProkurimeCategory = category === "Prokurime";
  const isVendimeCategory = category === "Vendime";
  const isKonsultimeCategory = category === "Konsultime publike";
  let isNationwideProkurime = false;
  let isNationwideVendime = false;
  let isNationwideKonsultime = false;
  let vendimeNationwideState = null;
  let konsultimeNationwideState = null;
  const registryUrlColumn = getRegistryUrlColumnForCategory(category);
  let baselineTargetUrl = null;

  try {
    municipalityId = await getMunicipalityId({ municipality, municipality_id });
    if (
      (isProkurimeCategory || isVendimeCategory || isKonsultimeCategory) &&
      hasMunicipalitySelector &&
      !municipalityId
    ) {
      return res.status(400).json({
        ok: false,
        error: "bad_request",
        message: "Invalid municipality (name_key/name_sq) or municipality_id",
      });
    }
    isNationwideProkurime = isProkurimeCategory && !municipalityId;
    isNationwideVendime = isVendimeCategory && !hasMunicipalitySelector && !municipalityId;
    isNationwideKonsultime = isKonsultimeCategory && !hasMunicipalitySelector && !municipalityId;

    if (isNationwideVendime || isNationwideKonsultime) {
      const nationwideRows = await pool.query(
        `
        SELECT m.id AS municipality_id, m.name_key
        FROM municipalities m
        JOIN source_registry sr
          ON sr.municipality_id = m.id
         AND sr.is_primary = TRUE
        ORDER BY lower(m.name_key) ASC, m.id ASC
        `
      );
      const total = nationwideRows.rowCount;
      if (offset >= total) {
        if (isNationwideKonsultime) {
          return res.json({
            ok: true,
            category: "Konsultime publike",
            nationwide: true,
            offset,
            next_offset: null,
            parsed_rows_total: 0,
            parsed_rows_kept: 0,
            inserted: 0,
            updated: 0,
            published_updated: 0,
            skipped: 0,
            skipped_missing_url: 0,
            skipped_missing_date: 0,
            skipped_wrong_year: 0,
            skipped_no_year_keyword: 0,
            skipped_no_year_source_policy: 0,
            skipped_no_municipality_match: 0,
            next: "Konsultime nationwide run completed.",
          });
        }
        return res.json({
          ok: true,
          category: "Vendime",
          nationwide: true,
          offset,
          next_offset: null,
          parsed_rows_total: 0,
          parsed_rows_kept: 0,
          inserted: 0,
          updated: 0,
          published_updated: 0,
          skipped: 0,
          skipped_missing_url: 0,
          skipped_missing_date: 0,
          skipped_wrong_year: 0,
          skipped_not_vendim: 0,
          skipped_not_municipality: 0,
          skipped_no_municipality_match: 0,
          next: "Vendime nationwide run completed.",
        });
      }

      const selected = nationwideRows.rows[offset];
      municipalityId = String(selected.municipality_id || "").trim();
      const nextOffset = offset + 1 < total ? offset + 1 : null;
      const state = {
        offset,
        next_offset: nextOffset,
        municipality_name_key: String(selected.name_key || "").trim() || null,
      };
      if (isNationwideVendime) {
        vendimeNationwideState = state;
      } else {
        konsultimeNationwideState = state;
      }
    }

    if (!isProkurimeCategory && !isNationwideVendime && !isNationwideKonsultime && !municipalityId) {
      return res.status(400).json({
        ok: false,
        error: "bad_request",
        message: "Provide municipality (name_key/name_sq) or municipality_id",
      });
    }

    if (!isNationwideProkurime && !isNationwideVendime && !isNationwideKonsultime) {
      registryRow = await loadRegistryRow(municipalityId);
      if (!registryRow) {
        return res.status(404).json({
          ok: false,
          error: "no_registry",
          message: "No source_registry row found for this municipality",
        });
      }

      if (
        !forceRun &&
        registryRow.cooldown_until_utc &&
        new Date(registryRow.cooldown_until_utc) > new Date()
      ) {
        return res.status(429).json({
          ok: false,
          error: "cooldown",
          message: "Source is in cooldown",
          cooldown_until_utc: registryRow.cooldown_until_utc,
          last_error_type: registryRow.last_error_type || null,
        });
      }

      baselineTargetUrl = isProkurimeCategory
        ? null
        : applyYearTemplate((registryUrlColumn ? registryRow[registryUrlColumn] : null) || null, year);

      // fallback only for Tirana if vendime_url missing (debug convenience)
      if (!isProkurimeCategory && category === "Vendime" && !baselineTargetUrl) {
        const tiranaId = await getTiranaId();
        if (tiranaId && municipalityId === tiranaId) {
          baselineTargetUrl = `https://tirana.al/kategoria-e-publikimit/vendime-te-keshillit-bashkiak-${year}-4290`;
        }
      }

      if (!isProkurimeCategory && !baselineTargetUrl) {
        await pool.query(
          `
          UPDATE source_registry
          SET last_error_type = 'CONFIG_MISSING_URL'
          WHERE id = $1
          `,
          [registryRow.id]
        );

        return res.status(400).json({
          ok: false,
          error: "missing_target_url",
          message: `${registryUrlColumn || "target_url"} is NULL in source_registry (and no fallback available)`,
          last_error_type: "CONFIG_MISSING_URL",
        });
      }

      // update registry attempt_count + last_checked_utc + hour_buckets_seen (invariants)
      const bucket = utcHourBucket(startedAt);
      const nextBuckets = appendHourBucket(registryRow.hour_buckets_seen, bucket);

      await pool.query(
        `
        UPDATE source_registry
        SET
          attempt_count = attempt_count + 1,
          first_seen_utc = COALESCE(first_seen_utc, now()),
          last_checked_utc = now(),
          hour_buckets_seen = $2,
          last_error_type = NULL
        WHERE id = $1
        `,
        [registryRow.id, nextBuckets]
      );
    } else if (isNationwideVendime || isNationwideKonsultime) {
      registryRow = await loadRegistryRow(municipalityId);
      if (!registryRow) {
        return res.status(404).json({
          ok: false,
          error: "no_registry",
          message: "No source_registry row found for this municipality",
        });
      }

      baselineTargetUrl = applyYearTemplate(
        (registryUrlColumn ? registryRow[registryUrlColumn] : null) || null,
        year
      );
      if (isNationwideVendime && !baselineTargetUrl) {
        const tiranaId = await getTiranaId();
        if (tiranaId && municipalityId === tiranaId) {
          baselineTargetUrl = `https://tirana.al/kategoria-e-publikimit/vendime-te-keshillit-bashkiak-${year}-4290`;
        }
      }

      if (!baselineTargetUrl) {
        await pool.query(
          `
          UPDATE source_registry
          SET last_error_type = 'CONFIG_MISSING_URL'
          WHERE id = $1
          `,
          [registryRow.id]
        );
        return res.json({
          ok: true,
          category: isNationwideKonsultime ? "Konsultime publike" : "Vendime",
          nationwide: true,
          municipality_id: municipalityId,
          municipality:
            konsultimeNationwideState?.municipality_name_key ||
            vendimeNationwideState?.municipality_name_key ||
            municipalityId,
          used_registry_id: registryRow.id,
          offset:
            konsultimeNationwideState?.offset !== undefined
              ? konsultimeNationwideState.offset
              : vendimeNationwideState?.offset,
          next_offset:
            konsultimeNationwideState?.next_offset !== undefined
              ? konsultimeNationwideState.next_offset
              : vendimeNationwideState?.next_offset ?? null,
          parsed_rows_total: 0,
          parsed_rows_kept: 0,
          inserted: 0,
          updated: 0,
          published_updated: 0,
          skipped: 1,
          skipped_missing_url: 1,
          skipped_missing_date: 0,
          skipped_wrong_year: 0,
          skipped_no_year_keyword: isNationwideKonsultime ? 0 : undefined,
          skipped_no_year_source_policy: isNationwideKonsultime ? 0 : undefined,
          skipped_not_vendim: isNationwideVendime ? 0 : undefined,
          skipped_not_municipality: isNationwideVendime ? 0 : undefined,
          skipped_no_municipality_match: 0,
          last_error_type: "CONFIG_MISSING_URL",
          next: isNationwideKonsultime
            ? "Next: continue konsultime nationwide run from next_offset."
            : "Next: continue vendime nationwide run from next_offset.",
        });
      }

      const bucket = utcHourBucket(startedAt);
      const nextBuckets = appendHourBucket(registryRow.hour_buckets_seen, bucket);
      await pool.query(
        `
        UPDATE source_registry
        SET
          attempt_count = attempt_count + 1,
          first_seen_utc = COALESCE(first_seen_utc, now()),
          last_checked_utc = now(),
          hour_buckets_seen = $2,
          last_error_type = NULL
        WHERE id = $1
        `,
        [registryRow.id, nextBuckets]
      );
    }

    if (category === "Prokurime") {
      const successPayload = await withTimeout(
        (async () => {
          const systemUserId = await getSystemUserId();
          let baselineResult = null;
          let checkedPrimaryMunicipalityIds = new Set();
          if (isNationwideProkurime) {
            const municipalityContexts = await loadAllMunicipalityMatchContexts();
            if (!municipalityContexts.length) {
              throw new Error("No municipality contexts found for nationwide Prokurime run.");
            }
            checkedPrimaryMunicipalityIds = await loadCheckedPrimaryRegistryMunicipalityIds(
              "Prokurime"
            );
            baselineResult = await scrapeProkurimeAppExport({
              year,
              limit,
              offset,
              municipalityContexts,
              requestTimeoutMs: SCRAPE_REQUEST_TIMEOUT_MS,
            });
          } else {
            const municipalityMatchContext = await getMunicipalityMatchContext(municipalityId);
            if (!municipalityMatchContext) {
              throw new Error("Municipality context not found.");
            }
            baselineResult = await scrapeProkurimeAppExport({
              year,
              limit,
              municipalityContext: municipalityMatchContext,
              requestTimeoutMs: SCRAPE_REQUEST_TIMEOUT_MS,
            });
          }
          const baselineSummary = {
            used_url: baselineResult.meta?.source_page_url || baselineResult.url || null,
            export_csv_url: baselineResult.meta?.export_csv_url || null,
            parsed_rows_total: Number(baselineResult.meta?.rows_total || baselineResult.items.length),
            rows_matched: Number(baselineResult.meta?.rows_matched || 0),
            skipped_no_municipality_match: Number(
              baselineResult.meta?.skipped_no_municipality_match || 0
            ),
            kept: 0,
            inserted: 0,
            updated: 0,
            skipped: 0,
            skipped_missing_date: 0,
            skipped_wrong_year: 0,
          };
          const matched_rows_total = Number(baselineSummary.rows_matched || 0);
          const nextOffset = isNationwideProkurime
            ? (baselineResult.meta?.next_offset ?? null)
            : null;

          const shouldPublish =
            !isNationwideProkurime && (forcePublish || isCategoryChecked(registryRow, "Prokurime"));

          let inserted = 0;
          let updated = 0;
          let skipped = 0;
          let skipped_missing_date = 0;
          let skipped_wrong_year = 0;
          let skipped_missing_url = 0;
          let draftInserted = 0;
          let publishedInserted = 0;
          let parsed_kept = 0;
          let sample_kept_title = null;
          const keptDedupKeysByMunicipality = new Map();
          const prokurimeExportCache = new Map();
          const skipped_no_municipality_match = Number(
            baselineResult.meta?.skipped_no_municipality_match || 0
          );

          for (const it of baselineResult.items) {
            const rowMunicipalityId = isNationwideProkurime
              ? String(it.municipality_id || "").trim()
              : municipalityId;
            if (!rowMunicipalityId) {
              skipped += 1;
              baselineSummary.skipped += 1;
              continue;
            }

            const shouldPublishForItem = isNationwideProkurime
              ? forcePublish || checkedPrimaryMunicipalityIds.has(rowMunicipalityId)
              : shouldPublish;
            const defaultStatus = shouldPublishForItem ? "published" : "draft";
            const title = it.title || "";
            const published_date = sanitizeISODate(it.published_date || null);
            const itemBaseUrl =
              String(it.source_page_url || "").trim() ||
              String(baselineResult.meta?.source_page_url || "").trim() ||
              String(baselineResult.meta?.export_csv_url || "").trim();
            const sourceUrl = makeAbsoluteUrl(itemBaseUrl, it.source_url);
            const sourcePageUrl = makeAbsoluteUrl(itemBaseUrl, it.source_page_url || itemBaseUrl);
            const sourceOrigin = String(it.source_origin || "").trim() || "app.gov.al";

            if (!sourceUrl) {
              skipped += 1;
              skipped_missing_url += 1;
              baselineSummary.skipped += 1;
              continue;
            }

            if (yearFilterRequested) {
              if (!published_date) {
                skipped += 1;
                skipped_missing_date += 1;
                baselineSummary.skipped += 1;
                baselineSummary.skipped_missing_date += 1;
                continue;
              }

              const itemYear = Number.parseInt(String(published_date).slice(0, 4), 10);
              if (!Number.isFinite(itemYear) || itemYear !== year) {
                skipped += 1;
                skipped_wrong_year += 1;
                baselineSummary.skipped += 1;
                baselineSummary.skipped_wrong_year += 1;
                continue;
              }
            }

            parsed_kept += 1;
            baselineSummary.kept += 1;
            if (!sample_kept_title) sample_kept_title = title;

            const titleNormalized = it.title_normalized || normalizeTitle(title);
            const dedupKey = buildProkurimeAppDedupKey({
              year,
              municipalityId: rowMunicipalityId,
              procedureId: it.procedure_id,
              publishedDate: published_date,
              title,
              titleNormalized,
            });
            if (shouldPublishForItem) {
              const keepSet = keptDedupKeysByMunicipality.get(rowMunicipalityId) || new Set();
              keepSet.add(dedupKey);
              keptDedupKeysByMunicipality.set(rowMunicipalityId, keepSet);
            }

            const action = await upsertRegistryDocumentItem({
              municipalityId: rowMunicipalityId,
              category,
              title,
              titleNormalized,
              publishedDate: published_date,
              sourceUrl,
              sourcePageUrl,
              sourceOrigin,
              dedupKey,
              shouldPublish: shouldPublishForItem,
              defaultStatus,
              systemUserId,
            });

            try {
              const itemId = await findItemIdByDedupKey({
                municipalityId: rowMunicipalityId,
                dedupKey,
              });
              if (!itemId) {
                console.warn(
                  `[prokurime_records] skip error item_not_found=true municipality_id=${rowMunicipalityId}`
                );
              } else {
                const parsedExportSource = parseAppExportDocumentUrl(sourceUrl);
                if (parsedExportSource.isExportDocument) {
                  let exportPayload = prokurimeExportCache.get(parsedExportSource.exportUrl);
                  if (!exportPayload) {
                    exportPayload = await fetchProkurimeExportPayload(parsedExportSource.exportUrl);
                    prokurimeExportCache.set(parsedExportSource.exportUrl, exportPayload);
                    if (exportPayload.kind === "non_csv") {
                      console.warn(
                        `[prokurime_records] skip non_csv export_url=${parsedExportSource.exportUrl} reason=${exportPayload.reason}`
                      );
                    } else if (exportPayload.kind === "error") {
                      console.warn(
                        `[prokurime_records] skip error export_url=${parsedExportSource.exportUrl} err=${exportPayload.reason}`
                      );
                    }
                  }

                  if (exportPayload.kind === "csv") {
                    if (!exportPayload.sampleLogged && exportPayload.records.length > 0) {
                      console.log(
                        `[prokurime_records] sample_row export_url=${parsedExportSource.exportUrl} row=${truncateLogJson(
                          exportPayload.records[0]
                        )}`
                      );
                      exportPayload.sampleLogged = true;
                    }

                    const bestRow = findBestExportRowForItem({
                      records: exportPayload.records,
                      procedureHint: parsedExportSource.procedureHint,
                      procedureId: it.procedure_id,
                    });
                    const extractedFields = extractProkurimeRecordFields({
                      record: bestRow?.record || {},
                      fallbackProcedureRef:
                        bestRow?.procedureRef ||
                        it.procedure_id ||
                        parsedExportSource.procedureHint ||
                        null,
                    });

                    await upsertProkurimeRecord({
                      itemId,
                      municipalityId: rowMunicipalityId,
                      amountValue: extractedFields.amountValue,
                      amountCurrency: extractedFields.amountCurrency,
                      supplierName: extractedFields.supplierName,
                      cpvCode: extractedFields.cpvCode,
                      procedureRef: extractedFields.procedureRef,
                      sourceExportUrl: parsedExportSource.exportUrl,
                    });
                  }
                }
              }
            } catch (prokurimeRecordErr) {
              const parsedExportSource = parseAppExportDocumentUrl(sourceUrl);
              console.warn(
                `[prokurime_records] skip error export_url=${parsedExportSource.exportUrl || "-"} err=${safePublicErrorMessage(
                  prokurimeRecordErr,
                  "prokurime_records_upsert_failed"
                )}`
              );
            }

            if (action === "inserted") {
              inserted += 1;
              baselineSummary.inserted += 1;
              if (shouldPublishForItem) publishedInserted += 1;
              else draftInserted += 1;
            } else if (action === "updated") {
              updated += 1;
              baselineSummary.updated += 1;
            } else {
              skipped += 1;
              baselineSummary.skipped += 1;
            }
          }

          let publishedUpdated = 0;
          for (const [publishMunicipalityId, keys] of keptDedupKeysByMunicipality.entries()) {
            if (!keys || !keys.size) continue;
            const keptKeys = Array.from(keys);
            const publishUpdate = await pool.query(
              `
              UPDATE items
              SET status = 'published',
                  updated_at = now()
              WHERE municipality_id = $1
                AND category = $2
                AND status <> 'published'
                AND dedup_key = ANY($3::text[])
              `,
              [publishMunicipalityId, category, keptKeys]
            );
            publishedUpdated += publishUpdate.rowCount;
          }

          if (!isNationwideProkurime) {
            await pool.query(
              `
              UPDATE source_registry
              SET
                last_seen_utc = now(),
                last_error_type = NULL,
                cooldown_until_utc = NULL
              WHERE id = $1
              `,
              [registryRow.id]
            );
          }

          return {
            ok: true,
            municipality: isNationwideProkurime ? null : municipality || municipalityId,
            municipality_id: isNationwideProkurime ? null : municipalityId,
            category,
            used_registry_id: isNationwideProkurime ? null : registryRow.id,
            scraped_from: baselineSummary.used_url || baselineSummary.export_csv_url || null,
            parsed_rows_total: baselineSummary.parsed_rows_total,
            matched_rows_total,
            parsed_rows_kept: parsed_kept,
            force_publish: forcePublish,
            should_publish: isNationwideProkurime ? null : shouldPublish,
            offset: isNationwideProkurime ? offset : undefined,
            next_offset: isNationwideProkurime ? nextOffset : undefined,
            page_start: pageStart,
            inserted,
            updated,
            published_updated: publishedUpdated,
            skipped,
            draft_inserted: draftInserted,
            published_inserted: publishedInserted,
            skipped_missing_url,
            skipped_missing_date,
            skipped_wrong_year,
            skipped_no_municipality_match,
            baseline: baselineSummary,
            sample_title: sample_kept_title || baselineResult.items[0]?.title || null,
            next: isNationwideProkurime
              ? "Next: verify /api/feed returns Prokurime rows across municipalities."
              : "Next: verify /api/feed returns this municipality/category.",
          };
        })(),
        SCRAPE_JOB_TIMEOUT_MS,
        isNationwideProkurime
          ? `scrape nationwide category ${category}`
          : `scrape municipality ${municipalityId} category ${category}`
      );

      return res.json(successPayload);
    }

    if (category === "Konsultime publike") {
      const successPayload = await withTimeout(
        (async () => {
          const systemUserId = await getSystemUserId();
          const municipalityKey = await getMunicipalityNameKeyById(municipalityId);
          const baselineResult = await scrapeGenericDocuments({
            targetUrl: baselineTargetUrl,
            year,
            limit,
            municipalityKey,
            pageStart,
            category,
          });
          const baselineSummary = {
            used_url: baselineResult.usedUrl || baselineResult.url || baselineTargetUrl,
            parsed_rows_total: baselineResult.items.length,
            kept: 0,
            inserted: 0,
            updated: 0,
            skipped: 0,
            skipped_missing_date: 0,
            skipped_wrong_year: 0,
            skipped_no_year_keyword: 0,
            skipped_no_year_source_policy: 0,
          };
          const fallbackSummary = {
            attempted: false,
            used_url: null,
            discovered_links_total: 0,
            used_links_total: 0,
            used_links: [],
            parsed_rows_total: 0,
            kept: 0,
            inserted: 0,
            updated: 0,
            skipped: 0,
            skipped_missing_date: 0,
            skipped_wrong_year: 0,
            skipped_no_year_keyword: 0,
            skipped_no_year_source_policy: 0,
          };
          const mergedScrapedItems = baselineResult.items.map((it) => ({
            ...it,
            source_kind: "baseline",
            source_base_url: baselineSummary.used_url || baselineTargetUrl,
          }));
          const municipalityBaseForHost =
            String(registryRow.final_url || "").trim() ||
            String(registryRow.base_url || "").trim() ||
            baselineTargetUrl;
          const municipalityHost = getHost(municipalityBaseForHost);

          if (category === "Konsultime publike") {
            let baselineKeepableCount = 0;
            const baselineBaseUrl = baselineSummary.used_url || baselineTargetUrl;
            for (const it of baselineResult.items) {
              const sourceUrl = makeAbsoluteUrl(baselineBaseUrl, it.source_url);
              if (!sourceUrl) continue;
              if (yearFilterRequested) {
                const publishedDate = sanitizeISODate(it.published_date || null);
                if (!publishedDate) continue;
                const itemYear = Number.parseInt(String(publishedDate).slice(0, 4), 10);
                if (!Number.isFinite(itemYear) || itemYear !== year) continue;
              } else if (
                category === "Konsultime publike" &&
                !shouldKeepKonsultimeWithoutYear({ title: it.title || "", sourceUrl })
              ) {
                continue;
              } else {
                const sourcePageUrl = makeAbsoluteUrl(
                  baselineBaseUrl,
                  it.source_page_url || baselineBaseUrl
                );
                const sourcePolicy = evaluateKonsultimeNoYearSourcePolicy({
                  municipalityHost,
                  sourceUrl,
                  sourcePageUrl,
                  itemBaseUrl: baselineBaseUrl,
                });
                if (!sourcePolicy.allowed) continue;
              }
              baselineKeepableCount++;
            }

            if (baselineSummary.parsed_rows_total === 0 || baselineKeepableCount === 0) {
              fallbackSummary.attempted = true;
              const discoveryStartUrl = baselineSummary.used_url || baselineTargetUrl;
              fallbackSummary.used_url = discoveryStartUrl;

              try {
                const discoveryFetch = await fetchHtmlForDiscovery(discoveryStartUrl);
                const discoveryBaseUrl = discoveryFetch.finalUrl || discoveryStartUrl;
                fallbackSummary.used_url = discoveryBaseUrl;
                const discoveredLinks = extractSameHostKeywordLinks({
                  startUrl: discoveryBaseUrl,
                  html: discoveryFetch.html,
                });

                fallbackSummary.discovered_links_total = discoveredLinks.length;
                for (const subpageUrl of discoveredLinks) {
                  const subResult = await scrapeGenericDocuments({
                    targetUrl: subpageUrl,
                    year,
                    limit,
                    municipalityKey,
                    pageStart,
                    category,
                  });
                  const subBaseUrl = subResult.usedUrl || subResult.url || subpageUrl;
                  fallbackSummary.used_links.push(subBaseUrl);
                  fallbackSummary.used_links_total = fallbackSummary.used_links.length;
                  fallbackSummary.parsed_rows_total += subResult.items.length;
                  mergedScrapedItems.push(
                    ...subResult.items.map((it) => ({
                      ...it,
                      source_kind: "fallback",
                      source_base_url: subBaseUrl,
                    }))
                  );
                }
              } catch (fallbackErr) {
                fallbackSummary.error = safePublicErrorMessage(
                  fallbackErr,
                  "Konsultime fallback discovery failed"
                );
              }
            }
          }

          const shouldPublish =
            forcePublish || isCategoryChecked(registryRow, "Konsultime publike");
          const defaultStatus = shouldPublish ? "published" : "draft";

          let inserted = 0;
          let updated = 0;
          let skipped = 0;
          let skipped_missing_date = 0;
          let skipped_wrong_year = 0;
          let skipped_missing_url = 0;
          let skipped_no_year_keyword = 0;
          let skipped_no_year_source_policy = 0;
          let parsed_kept = 0;
          let sample_kept_title = null;
          const keptTitlesSample = [];
          const keptDedupKeys = new Set();
          let uniqueScrapedItems = mergedScrapedItems;
          if (category === "Konsultime publike" && fallbackSummary.attempted) {
            uniqueScrapedItems = [];
            const seenMergedDedupKeys = new Set();
            for (const it of mergedScrapedItems) {
              const itemBaseUrl =
                String(it.source_base_url || "").trim() ||
                baselineSummary.used_url ||
                baselineTargetUrl;
              const sourceUrl = makeAbsoluteUrl(itemBaseUrl, it.source_url);
              if (!sourceUrl) {
                uniqueScrapedItems.push(it);
                continue;
              }
              const title = it.title || "";
              const publishedDate = sanitizeISODate(it.published_date || null);
              const titleNormalized = it.title_normalized || normalizeTitle(title);
              const dedupKey = dedupKeyRegistryDocumentV1({
                municipalityId,
                category,
                publishedDate,
                title,
                titleNormalized,
                sourceUrl,
              });
              if (seenMergedDedupKeys.has(dedupKey)) continue;
              seenMergedDedupKeys.add(dedupKey);
              uniqueScrapedItems.push(it);
            }
          }

          for (const it of uniqueScrapedItems) {
            const sourceKind = it.source_kind === "fallback" ? "fallback" : "baseline";
            const sourceSummary = sourceKind === "fallback" ? fallbackSummary : baselineSummary;
            const title = it.title || "";
            const published_date = sanitizeISODate(it.published_date || null);
            const itemBaseUrl =
              String(it.source_base_url || "").trim() || baselineSummary.used_url || baselineTargetUrl;
            const sourceUrl = makeAbsoluteUrl(itemBaseUrl, it.source_url);
            let sourcePageUrl = makeAbsoluteUrl(itemBaseUrl, it.source_page_url || itemBaseUrl);
            let sourceOrigin = String(it.source_origin || "").trim();

            if (!sourceUrl) {
              skipped++;
              sourceSummary.skipped++;
              skipped_missing_url++;
              continue;
            }

            if (yearFilterRequested) {
              if (!published_date) {
                skipped++;
                sourceSummary.skipped++;
                sourceSummary.skipped_missing_date++;
                skipped_missing_date++;
                continue;
              }
              const itemYear = Number.parseInt(String(published_date).slice(0, 4), 10);
              if (!Number.isFinite(itemYear) || itemYear !== year) {
                skipped++;
                sourceSummary.skipped++;
                sourceSummary.skipped_wrong_year++;
                skipped_wrong_year++;
                continue;
              }
            } else if (
              category === "Konsultime publike" &&
              !shouldKeepKonsultimeWithoutYear({ title, sourceUrl })
            ) {
              skipped++;
              sourceSummary.skipped++;
              sourceSummary.skipped_no_year_keyword++;
              skipped_no_year_keyword++;
              continue;
            } else if (category === "Konsultime publike") {
              const sourcePolicy = evaluateKonsultimeNoYearSourcePolicy({
                municipalityHost,
                sourceUrl,
                sourcePageUrl,
                itemBaseUrl,
              });
              if (!sourcePolicy.allowed) {
                skipped++;
                sourceSummary.skipped++;
                sourceSummary.skipped_no_year_source_policy++;
                skipped_no_year_source_policy++;
                continue;
              }
              sourcePageUrl = sourcePolicy.resolvedSourcePageUrl || sourcePageUrl;
            }
            sourceOrigin = sourceOrigin || getHost(sourcePageUrl || sourceUrl) || null;

            parsed_kept++;
            sourceSummary.kept++;
            if (!sample_kept_title) sample_kept_title = title;
            if (title && keptTitlesSample.length < 3) keptTitlesSample.push(title);
            const titleNormalized = it.title_normalized || normalizeTitle(title);
            const dedupKey = dedupKeyRegistryDocumentV1({
              municipalityId,
              category,
              publishedDate: published_date,
              title,
              titleNormalized,
              sourceUrl,
            });
            keptDedupKeys.add(dedupKey);

            const action = await upsertRegistryDocumentItem({
              municipalityId,
              category,
              title,
              titleNormalized,
              publishedDate: published_date,
              sourceUrl,
              sourcePageUrl,
              sourceOrigin,
              dedupKey,
              shouldPublish,
              defaultStatus,
              systemUserId,
            });

            if (action === "inserted") {
              inserted++;
              sourceSummary.inserted++;
            } else if (action === "updated") {
              updated++;
              sourceSummary.updated++;
            } else {
              skipped++;
              sourceSummary.skipped++;
            }
          }

          let publishedUpdated = 0;
          if (shouldPublish && keptDedupKeys.size > 0) {
            const keptKeys = Array.from(keptDedupKeys);
            const publishUpdate = await pool.query(
              `
              UPDATE items
              SET status = 'published',
                  updated_at = now()
              WHERE municipality_id = $1
                AND category = $2
                AND status <> 'published'
                AND dedup_key = ANY($3::text[])
              `,
              [municipalityId, category, keptKeys]
            );
            publishedUpdated = publishUpdate.rowCount;
          }

          await pool.query(
            `
            UPDATE source_registry
            SET
              last_seen_utc = now(),
              last_error_type = NULL,
              cooldown_until_utc = NULL
            WHERE id = $1
            `,
            [registryRow.id]
          );

          return {
            ok: true,
            municipality:
              konsultimeNationwideState?.municipality_name_key || municipality || municipalityId,
            municipality_id: municipalityId,
            category,
            nationwide: !!konsultimeNationwideState,
            offset: konsultimeNationwideState?.offset,
            next_offset: konsultimeNationwideState?.next_offset,
            used_registry_id: registryRow.id,
            scraped_from: baselineSummary.used_url || baselineTargetUrl,
            parsed_rows_total:
              baselineSummary.parsed_rows_total + Number(fallbackSummary.parsed_rows_total || 0),
            parsed_rows_kept: parsed_kept,
            force_publish: forcePublish,
            should_publish: shouldPublish,
            page_start: pageStart,
            inserted,
            updated,
            published_updated: publishedUpdated,
            skipped,
            skipped_missing_url,
            skipped_missing_date,
            skipped_wrong_year,
            skipped_no_year_keyword,
            skipped_no_year_source_policy,
            skipped_no_municipality_match: 0,
            baseline: baselineSummary,
            fallback:
              category === "Konsultime publike" && fallbackSummary.attempted
                ? fallbackSummary
                : undefined,
            sample_title: sample_kept_title || baselineResult.items[0]?.title || null,
            debug: debugEnabled
              ? {
                  used_url: baselineSummary.used_url || baselineTargetUrl,
                  kept_titles_sample: keptTitlesSample.slice(0, 3),
                  fallback_used_urls:
                    category === "Konsultime publike" && fallbackSummary.attempted
                      ? (fallbackSummary.used_links || []).slice(0, 10)
                      : [],
                }
              : undefined,
            next: konsultimeNationwideState
              ? "Next: continue konsultime nationwide run from next_offset."
              : "Next: verify /api/feed returns this municipality/category.",
          };
        })(),
        SCRAPE_JOB_TIMEOUT_MS,
        konsultimeNationwideState
          ? `scrape nationwide category ${category} municipality ${municipalityId}`
          : `scrape municipality ${municipalityId} category ${category}`
      );

      return res.json(successPayload);
    }

    const officialEnabled = asEnabledFlag(registryRow.vendime_official_enabled);
    const officialFromYear = parseOptionalInteger(registryRow.vendime_official_from_year);
    const officialToYear = parseOptionalInteger(registryRow.vendime_official_to_year);
    const yearWithinOfficialRange =
      (!officialFromYear || year >= officialFromYear) && (!officialToYear || year <= officialToYear);
    const officialTemplateUrl = registryRow.vendime_url_official || null;
    const officialTargetUrl =
      officialEnabled && yearWithinOfficialRange && officialTemplateUrl
        ? applyYearTemplate(officialTemplateUrl, year)
        : null;

    const successPayload = await withTimeout(
      (async () => {
        // scrape baseline first (required)
        const systemUserId = await getSystemUserId();
        const municipalityKey = await getMunicipalityNameKeyById(municipalityId);
        const baselineResult = await scrapeVendimeTarget({
          targetUrl: baselineTargetUrl,
          year,
          limit,
          municipalityKey,
          pageStart,
        });
        const baselineSummary = {
          used_url: baselineResult.usedUrl || baselineTargetUrl,
          parsed_rows_total: baselineResult.items.length,
          kept: 0,
          inserted: 0,
          updated: 0,
          skipped: 0,
          skipped_missing_date: 0,
          skipped_wrong_year: 0,
          skipped_not_municipality: Number(
            baselineResult.meta?.skipped_not_municipality || 0
          ),
        };
        const officialSummary = {
          attempted: false,
          updated_existing: 0,
          skipped_missing_date: 0,
          skipped_wrong_year: 0,
          skipped_not_municipality: 0,
        };

        const mergedScrapedItems = baselineResult.items.map((it) => ({
          ...it,
          source_kind: "baseline",
          source_base_url: baselineSummary.used_url,
        }));

        if (officialTargetUrl) {
          officialSummary.attempted = true;
          officialSummary.used_url = officialTargetUrl;
          try {
            const officialResult = await scrapeVendimeTarget({
              targetUrl: officialTargetUrl,
              year,
              limit,
              municipalityKey,
              pageStart,
            });
            officialSummary.used_url = officialResult.usedUrl || officialTargetUrl;
            officialSummary.parsed_rows_total = officialResult.items.length;
            officialSummary.kept = 0;
            officialSummary.inserted = 0;
            officialSummary.updated = 0;
            officialSummary.skipped = 0;
            officialSummary.skipped_not_municipality = Number(
              officialResult.meta?.skipped_not_municipality || 0
            );
            mergedScrapedItems.push(
              ...officialResult.items.map((it) => ({
                ...it,
                source_kind: "official",
                source_base_url: officialSummary.used_url,
              }))
            );
          } catch (officialErr) {
            officialSummary.error = safePublicErrorMessage(
              officialErr,
              "Official vendime scrape failed"
            );
          }
        }

        const shouldPublish = forcePublish || isCategoryChecked(registryRow, "Vendime");
        const defaultStatus = shouldPublish ? "published" : "draft";

        // insert items
        let inserted = 0;
        let updated = 0;
        let skipped = 0;
        let skipped_not_vendim = 0;
        let skipped_not_municipality =
          Number(baselineSummary.skipped_not_municipality || 0) +
          Number(officialSummary.skipped_not_municipality || 0);
        let skipped_missing_date = 0;
        let skipped_wrong_year = 0;
        let skipped_missing_url = 0;
        let parsed_kept = 0;
        let sample_kept_title = null;
        const keptDedupKeys = new Set();
        const keptOfficialSourceUrls = new Set();
        let publishedUpdated = 0;

        for (const it of mergedScrapedItems) {
          const sourceKind = it.source_kind === "official" ? "official" : "baseline";
          const sourceSummary = sourceKind === "official" ? officialSummary : baselineSummary;
          const title = it.title || "";
          const published_date_raw = it.published_date || null;
          const published_date = sanitizeISODate(published_date_raw);
          const itemBaseUrl = it.source_base_url || baselineSummary.used_url || baselineTargetUrl;

          const sourceUrl = makeAbsoluteUrl(itemBaseUrl, it.source_url);
          const sourcePageUrl = makeAbsoluteUrl(itemBaseUrl, it.source_page_url || itemBaseUrl);
          const sourceOrigin =
            String(it.source_origin || "").trim() || getHost(sourcePageUrl || sourceUrl) || null;
          if (!sourceUrl) {
            skipped++;
            sourceSummary.skipped = (sourceSummary.skipped || 0) + 1;
            skipped_missing_url++;
            continue;
          }

          if (!looksLikeVendim(title, sourceUrl)) {
            skipped++;
            sourceSummary.skipped = (sourceSummary.skipped || 0) + 1;
            skipped_not_vendim++;
            continue;
          }

          if (yearFilterRequested) {
            if (!published_date) {
              skipped++;
              sourceSummary.skipped = (sourceSummary.skipped || 0) + 1;
              sourceSummary.skipped_missing_date =
                (sourceSummary.skipped_missing_date || 0) + 1;
              skipped_missing_date++;
              continue;
            }
            const itemYear = Number.parseInt(String(published_date).slice(0, 4), 10);
            if (!Number.isFinite(itemYear) || itemYear !== year) {
              skipped++;
              sourceSummary.skipped = (sourceSummary.skipped || 0) + 1;
              sourceSummary.skipped_wrong_year =
                (sourceSummary.skipped_wrong_year || 0) + 1;
              skipped_wrong_year++;
              continue;
            }
          }

          parsed_kept++;
          sourceSummary.kept = (sourceSummary.kept || 0) + 1;
          if (sourceKind === "official") keptOfficialSourceUrls.add(sourceUrl);
          if (!sample_kept_title) sample_kept_title = title;
          const titleNormalized = it.title_normalized || normalizeTitle(title);
          const dedupKey = await resolveVendimeDedupKey({
            municipalityId,
            publishedDate: published_date,
            number: it.number,
            title,
            titleNormalized,
          });
          keptDedupKeys.add(dedupKey);

          const action = await upsertVendimeItem({
            municipalityId,
            title,
            titleNormalized,
            publishedDate: published_date,
            sourceUrl,
            sourcePageUrl,
            sourceOrigin,
            dedupKey,
            shouldPublish,
            defaultStatus,
            systemUserId,
            sourceKind,
          });

          if (action === "inserted") {
            inserted++;
            sourceSummary.inserted = (sourceSummary.inserted || 0) + 1;
          } else if (action === "updated") {
            updated++;
            sourceSummary.updated = (sourceSummary.updated || 0) + 1;
          } else {
            skipped++;
            sourceSummary.skipped = (sourceSummary.skipped || 0) + 1;
          }
        }

        if (shouldPublish && keptDedupKeys.size > 0) {
          const keptKeys = Array.from(keptDedupKeys);
          const publishUpdate = await pool.query(
            `
            UPDATE items
            SET status = 'published',
                updated_at = now()
            WHERE municipality_id = $1
              AND category = $2
              AND status <> 'published'
              AND dedup_key = ANY($3::text[])
            `,
            [municipalityId, "Vendime", keptKeys]
          );
          publishedUpdated = publishUpdate.rowCount;
        }

        if (officialSummary.attempted && keptOfficialSourceUrls.size > 0) {
          const officialSourceUrls = Array.from(keptOfficialSourceUrls);
          const officialListingUrl = officialSummary.used_url || officialTargetUrl || null;
          const officialOriginHost =
            getHost(officialListingUrl || officialTargetUrl || "") || null;
          try {
            let updatedExisting = 0;

            // Reconcile exact official URLs first so existing baseline rows inherit official provenance.
            for (const officialSourceUrl of officialSourceUrls) {
              const perItemUpdate = await pool.query(
                `
                UPDATE items
                SET
                  source_origin = COALESCE($3, source_origin),
                  source_page_url = $4,
                  status = CASE WHEN $5::boolean THEN 'published' ELSE status END,
                  updated_at = now()
                WHERE municipality_id = $1
                  AND category = 'Vendime'
                  AND source_url = $2
                `,
                [
                  municipalityId,
                  officialSourceUrl,
                  officialOriginHost,
                  officialListingUrl,
                  shouldPublish,
                ]
              );
              updatedExisting += perItemUpdate.rowCount;
            }

            // Fallback for known Tirana 2026 listing if item-level URL matching misses existing rows.
            if (
              updatedExisting === 0 &&
              String(officialListingUrl || "").includes(
                "vendime-te-keshillit-bashkiak-2026-4290"
              )
            ) {
              const bulkFallback = await pool.query(
                `
                UPDATE items
                SET
                  source_origin = COALESCE($2, source_origin),
                  source_page_url = $3,
                  status = CASE WHEN $4::boolean THEN 'published' ELSE status END,
                  updated_at = now()
                WHERE municipality_id = $1
                  AND category = 'Vendime'
                  AND source_url LIKE 'https://tirana.al/uploads/2026/%'
                `,
                [municipalityId, officialOriginHost, officialListingUrl, shouldPublish]
              );
              updatedExisting += bulkFallback.rowCount;
            }

            officialSummary.updated_existing = updatedExisting;
          } catch (reconcileErr) {
            const reconcileMsg = safePublicErrorMessage(
              reconcileErr,
              "Official vendime reconciliation failed"
            );
            officialSummary.error = officialSummary.error
              ? `${officialSummary.error}; ${reconcileMsg}`
              : reconcileMsg;
          }
        }

        // success update
        await pool.query(
          `
          UPDATE source_registry
          SET
            last_seen_utc = now(),
            last_error_type = NULL,
            cooldown_until_utc = NULL
          WHERE id = $1
          `,
          [registryRow.id]
        );

        // Smoke test:
        // 1) apply 017_vendime_official_sources.sql
        // 2) POST /api/scrape/run?municipality=tirane&category=Vendime&year=2026&limit=80 (Bearer token)
        // 3) verify response includes baseline+official and no duplicate vendime rows in /api/feed?municipality=tirane
        return {
          ok: true,
          municipality:
            vendimeNationwideState?.municipality_name_key || municipality || municipalityId,
          municipality_id: municipalityId,
          category: "Vendime",
          nationwide: !!vendimeNationwideState,
          offset: vendimeNationwideState?.offset,
          next_offset: vendimeNationwideState?.next_offset,
          used_registry_id: registryRow.id,
          scraped_from: baselineSummary.used_url || baselineTargetUrl,
          parsed_rows_total:
            baselineSummary.parsed_rows_total + Number(officialSummary.parsed_rows_total || 0),
          parsed_rows_kept: parsed_kept,
          force_publish: forcePublish,
          should_publish: shouldPublish,
          page_start: pageStart,
          inserted,
          updated,
          published_updated: publishedUpdated,
          skipped,
          skipped_missing_url,
          skipped_missing_date,
          skipped_wrong_year,
          skipped_not_vendim,
          skipped_not_municipality,
          skipped_no_municipality_match: 0,
          baseline: baselineSummary,
          official: officialSummary,
          sample_title: sample_kept_title || mergedScrapedItems[0]?.title || null,
          next: "Next: run the remaining checked municipalities and confirm parsed_rows_kept > 0.",
        };
      })(),
      SCRAPE_JOB_TIMEOUT_MS,
      `scrape municipality ${municipalityId}`
    );

    return res.json(successPayload);
  } catch (err) {
    const causeCode = err?.cause?.code || err?.code || "";
    const explicitErrorType = String(
      err?.last_error_type || err?.code || ""
    ).toUpperCase();
    const networkDownCodes = new Set([
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
    ]);
    let errorType = "SCRAPE_ERROR";

    if (/^HTTP_\d{3}$/.test(explicitErrorType)) {
      errorType = explicitErrorType;
    } else if (explicitErrorType === "TIMEOUT" || causeCode === "TIMEOUT") {
      errorType = "TIMEOUT";
    } else if (networkDownCodes.has(explicitErrorType) || networkDownCodes.has(String(causeCode).toUpperCase())) {
      errorType = "UPSTREAM_DOWN";
    } else if (causeCode === "CERT_HAS_EXPIRED") {
      errorType = "TLS_CERT_EXPIRED";
    } else if (causeCode === "DEPTH_ZERO_SELF_SIGNED_CERT") {
      errorType = "TLS_SELF_SIGNED";
    } else if (causeCode === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
      errorType = "TLS_UNVERIFIED_CHAIN";
    }

    const cooldownMinutes = Number(
      err?.cooldown_minutes || (errorType === "HTTP_403" ? HTTP_403_COOLDOWN_MINUTES : 30)
    );
    const safeCooldownMinutes = Number.isFinite(cooldownMinutes)
      ? cooldownMinutes
      : 30;
    const finalUrlOnError = String(err?.final_url || "").trim() || null;
    let updatedState = null;
    const controlledFailure =
      /^HTTP_\d{3}$/.test(errorType) ||
      ["TIMEOUT", "UPSTREAM_DOWN", "TLS_CERT_EXPIRED", "TLS_SELF_SIGNED", "TLS_UNVERIFIED_CHAIN"].includes(errorType);

    if (registryRow?.id) {
      const updated = await pool.query(
        `
        UPDATE source_registry
        SET
          last_error_type = $2,
          cooldown_until_utc = now() + make_interval(mins => $3::int),
          homepage_status = CASE
            WHEN $2 = 'HTTP_403' THEN 'BLOCKED'
            WHEN $2 = 'TIMEOUT' THEN 'ERROR'
            ELSE homepage_status
          END,
          feasibility = CASE WHEN $2 = 'HTTP_403' THEN 'C' ELSE feasibility END,
          final_url = COALESCE($4, final_url)
        WHERE id = $1
        RETURNING cooldown_until_utc, homepage_status, feasibility
        `,
        [registryRow.id, errorType, safeCooldownMinutes, finalUrlOnError]
      );
      updatedState = updated.rows[0] || null;
    }

    if (errorType === "HTTP_403") {
      console.warn(
        `[scrape.run] blocked municipality_id=${municipalityId || "unknown"} final_url=${finalUrlOnError || "-"}`
      );
    } else if (errorType === "TIMEOUT") {
      console.warn(
        `[scrape.run] timeout municipality_id=${municipalityId || "unknown"} label=${err?.timeout_label || "scrape job"}`
      );
    } 

    const statusCode = (() => {
      if (errorType === "HTTP_403") return 502;
      if (errorType === "TIMEOUT") return 504;
      if (errorType === "UPSTREAM_DOWN") return 502;
      if (errorType.startsWith("HTTP_")) return 502;
      return controlledFailure ? 502 : 500;
    })();

    return res.status(statusCode).json({
      ok: false,
      error: "scrape_error",
      message: safePublicErrorMessage(err, "Scrape failed"),
      scrape_error:
        errorType === "TIMEOUT"
          ? `Timeout: ${err?.timeout_label || "scrape job"}`
          : undefined,
      cause: causeCode || null,
      last_error_type: errorType,
      homepage_status: updatedState?.homepage_status || null,
      feasibility: updatedState?.feasibility || null,
      cooldown_until_utc: updatedState?.cooldown_until_utc || null,
    });
  }
});

const port = process.env.PORT || 5050;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

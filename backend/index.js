// backend/index.js
const path = require("path");

require("dotenv").config({
  path: process.env.DOTENV_CONFIG_PATH || path.join(__dirname, ".env"),
});

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const cheerio = require("cheerio");
const { Pool } = require("pg");
const dns = require("dns");
const net = require("net");
const crypto = require("crypto");
const { fetchVendimeStatusSummary } = require("./lib/vendimeStatus");

// Make Node prefer IPv4 first (helps on some Windows setups)
dns.setDefaultResultOrder("ipv4first");

// Scrapers
const { scrapeTiranaVendime } = require("./scrapers/tiranaVendime");
const { scrapeGenericDocuments } = require("./scrapers/genericDocuments");
const { scrapeVendimeAl } = require("./scrapers/vendimeAl");

console.log("LOADED INDEX.JS FROM:", __filename);

const app = express();
app.disable("x-powered-by");

const NODE_ENV = String(process.env.NODE_ENV || "development").toLowerCase();
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();
const PUBLIC_ORIGINS = String(process.env.PUBLIC_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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

app.use(
  cors({
    origin(origin, cb) {
      // Allow non-browser clients (curl, server-to-server) which do not send Origin.
      if (!origin) return cb(null, true);

      // If no allowlist configured, default to localhost-only in development.
      if (originAllowlist.size === 0) {
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
          return cb(null, true);
        }
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
const KONSULTIME_FALLBACK_KEYWORDS = [
  "njoftime",
  "proces",
  "verbale",
  "vendime",
  "konsultim",
  "degjes",
];
const KONSULTIME_FALLBACK_MAX_LINKS = 6;

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

function parseYear(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(String(value).trim());
  if (!Number.isInteger(n) || n < 2000 || n > 2100) return null;
  return n;
}

function parseOptionalInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function asEnabledFlag(value) {
  if (typeof value === "boolean") return value;
  const s = String(value || "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "t" || s === "yes" || s === "on";
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
      "/api/feed",
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
        id,
        municipality AS municipality_name,
        municipality_key AS municipality_name_key,
        category,
        title,
        source_url,
        published_date AS published_at,
        created_at,
        collected_at
      FROM v_public_feed
      ${whereSql}
      ORDER BY collected_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;

    const itemsResult = await pool.query(itemsSql, itemParams);
    res.json({
      ok: true,
      page,
      limit,
      total,
      items: itemsResult.rows,
    });
  } catch (err) {
    res.status(500).json({
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
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
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

  try {
    municipalityId = await getMunicipalityId({ municipality, municipality_id });
    if (!municipalityId) {
      return res.status(400).json({
        ok: false,
        error: "bad_request",
        message: "Provide municipality (name_key/name_sq) or municipality_id",
      });
    }

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

    const registryUrlColumn = getRegistryUrlColumnForCategory(category);
    let baselineTargetUrl = applyYearTemplate(
      (registryUrlColumn ? registryRow[registryUrlColumn] : null) || null,
      year
    );

    // fallback only for Tirana if vendime_url missing (debug convenience)
    if (category === "Vendime" && !baselineTargetUrl) {
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

    if (category !== "Vendime") {
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
          };
          const mergedScrapedItems = baselineResult.items.map((it) => ({
            ...it,
            source_kind: "baseline",
            source_base_url: baselineSummary.used_url || baselineTargetUrl,
          }));

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
            forcePublish || registryRow.verification_status === "CHECKED";
          const defaultStatus = shouldPublish ? "published" : "draft";

          let inserted = 0;
          let updated = 0;
          let skipped = 0;
          let skipped_missing_date = 0;
          let skipped_wrong_year = 0;
          let skipped_missing_url = 0;
          let parsed_kept = 0;
          let sample_kept_title = null;
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
            const sourcePageUrl = makeAbsoluteUrl(itemBaseUrl, it.source_page_url || itemBaseUrl);
            const sourceOrigin =
              String(it.source_origin || "").trim() || getHost(sourcePageUrl || sourceUrl) || null;

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
            }

            parsed_kept++;
            sourceSummary.kept++;
            if (!sample_kept_title) sample_kept_title = title;
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
            municipality: municipality || municipalityId,
            municipality_id: municipalityId,
            category,
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
            baseline: baselineSummary,
            fallback:
              category === "Konsultime publike" && fallbackSummary.attempted
                ? fallbackSummary
                : undefined,
            sample_title: sample_kept_title || baselineResult.items[0]?.title || null,
            next: "Next: verify /api/feed returns this municipality/category.",
          };
        })(),
        SCRAPE_JOB_TIMEOUT_MS,
        `scrape municipality ${municipalityId} category ${category}`
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

        // auto-publish if registry already CHECKED, or allow explicit forced publish for one-off runs.
        const shouldPublish =
          forcePublish || registryRow.verification_status === "CHECKED";
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
          municipality: municipality || municipalityId,
          municipality_id: municipalityId,
          category: "Vendime",
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

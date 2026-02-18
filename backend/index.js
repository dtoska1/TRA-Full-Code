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
const { Pool } = require("pg");
const dns = require("dns");
const net = require("net");
const { fetchVendimeStatusSummary } = require("./lib/vendimeStatus");

// Make Node prefer IPv4 first (helps on some Windows setups)
dns.setDefaultResultOrder("ipv4first");

// Scrapers
const { scrapeTiranaVendime } = require("./scrapers/tiranaVendime");
const { scrapeGenericDocuments } = require("./scrapers/genericDocuments");

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


async function getMunicipalityId({ municipality, municipality_id }) {
  if (municipality_id !== undefined && municipality_id !== null && String(municipality_id).trim() !== "") {
    const n = Number(String(municipality_id).trim());
    if (!Number.isInteger(n) || n < 1) return null;
    return n;
  }
  if (!municipality) return null;

  const key = toNameKey(municipality);

  const r = await pool.query(
    `SELECT id FROM municipalities WHERE name_key = $1 LIMIT 1`,
    [key]
  );
  return r.rowCount ? r.rows[0].id : null;
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

function getHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
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

    const offset = (page - 1) * limit;

    const params = [];
    const where = [];

    if (municipality) {
      params.push(municipality);
      where.push(`lower(municipality_key) = $${params.length}`);
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

      const safeDate = sanitizeISODate(it.published_date || null);
      const dateUnknown = safeDate ? false : true;
      const dedupKey = `vendime|${municipalityId}|${it.number || ""}|${sourceUrl || ""}`;

      const ins = await pool.query(
        `
        INSERT INTO items (
          municipality_id, category,
          title, title_normalized, summary,
          published_date, date_unknown, date_source,
          source_url, source_url_missing_reason,
          collected_at, ingestion_method,
          dedup_key, possible_duplicate,
          status, created_by_user_id
        )
        VALUES (
          $1, $2,
          $3, $4, NULL,
          $5::date, $6, 'tirana_al_table',
          $7, NULL,
          now(), 'scrape',
          $8, false,
          'draft', $9
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

  const category = req.query.category ? String(req.query.category) : "Vendime";
  const forceRun = String(req.query.force_run || "") === "true";
  const forcePublish =
    ["1", "true", "yes", "on"].includes(
      String(req.query.force_publish || "").trim().toLowerCase()
    );
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
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

    if (category.toLowerCase() !== "vendime") {
      return res.status(400).json({
        ok: false,
        error: "unsupported_category",
        message: "Only category=Vendime is supported for now",
      });
    }

    let targetUrl = applyYearTemplate(registryRow.vendime_url || null, year);

    // fallback only for Tirana if vendime_url missing (debug convenience)
    if (!targetUrl) {
      const tiranaId = await getTiranaId();
      if (tiranaId && municipalityId === tiranaId) {
        targetUrl = `https://tirana.al/kategoria-e-publikimit/vendime-te-keshillit-bashkiak-${year}-4290`;
      }
    }

    if (!targetUrl) {
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
        message: "vendime_url is NULL in source_registry (and no fallback available)",
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

    const successPayload = await withTimeout(
      (async () => {
        // scrape
        const systemUserId = await getSystemUserId();
        let usedUrl = targetUrl;
        let scrapedItems = [];

        const host = getHost(targetUrl);
        if (host.endsWith("tirana.al")) {
          const r = await scrapeTiranaVendime({ year, limit, urlOverride: targetUrl });
          usedUrl = r.url;
          scrapedItems = r.items;
        } else {
          const r = await scrapeGenericDocuments({ url: targetUrl, limit });
          usedUrl = r.url;
          scrapedItems = r.items;
        }

        // auto-publish if registry already CHECKED, or allow explicit forced publish for one-off runs.
        const defaultStatus =
          forcePublish || registryRow.verification_status === "CHECKED"
            ? "published"
            : "draft";

        // insert items
        let inserted = 0;
        let skipped = 0;
        let skipped_not_vendim = 0;
        let skipped_missing_url = 0;
        let parsed_kept = 0;
        let sample_kept_title = null;

        for (const it of scrapedItems) {
          const title = it.title || "";
          const published_date_raw = it.published_date || null;
          const published_date = sanitizeISODate(published_date_raw);

          const sourceUrl = makeAbsoluteUrl(usedUrl || targetUrl, it.source_url);
          if (!sourceUrl) {
            skipped++;
            skipped_missing_url++;
            continue;
          }

          if (!looksLikeVendim(title, sourceUrl)) {
            skipped++;
            skipped_not_vendim++;
            continue;
          }

          parsed_kept++;
          if (!sample_kept_title) sample_kept_title = title;

          const dateUnknown = published_date ? false : true;
          const dedupKey = `vendime|${municipalityId}|${it.number || ""}|${sourceUrl || ""}`;

          const ins = await pool.query(
            `
            INSERT INTO items (
              municipality_id, category,
              title, title_normalized, summary,
              published_date, date_unknown, date_source,
              source_url, source_url_missing_reason,
              collected_at, ingestion_method,
              dedup_key, possible_duplicate,
              status, created_by_user_id
            )
            VALUES (
              $1, $2,
              $3, $4, NULL,
              $5::date, $6, 'scrape_registry',
              $7, NULL,
              now(), 'scrape',
              $8, false,
              $9, $10
            )
            ON CONFLICT (source_url) WHERE source_url IS NOT NULL
            DO NOTHING
            RETURNING id
            `,
            [
              municipalityId,
              "Vendime",
              title,
              it.title_normalized || normalizeTitle(title),
              published_date,
              dateUnknown,
              sourceUrl,
              dedupKey,
              defaultStatus,
              systemUserId,
            ]
          );

          if (ins.rowCount === 1) inserted++;
          else skipped++;
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

        return {
          ok: true,
          municipality: municipality || municipalityId,
          municipality_id: municipalityId,
          category: "Vendime",
          used_registry_id: registryRow.id,
          scraped_from: usedUrl || targetUrl,
          parsed_rows_total: scrapedItems.length,
          parsed_rows_kept: parsed_kept,
          force_publish: forcePublish,
          inserted,
          skipped,
          skipped_missing_url,
          skipped_not_vendim,
          sample_title: sample_kept_title || scrapedItems[0]?.title || null,
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

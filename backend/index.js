// backend/index.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { Pool } = require("pg");
const dns = require("dns");

// Make Node prefer IPv4 first (helps on some Windows setups)
dns.setDefaultResultOrder("ipv4first");

// Scrapers
const { scrapeTiranaVendime } = require("./scrapers/tiranaVendime");
const { scrapeGenericDocuments } = require("./scrapers/genericDocuments");

console.log("LOADED INDEX.JS FROM:", __filename);

const app = express();

// --------------------
// Middleware
// --------------------
app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(morgan("dev"));

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
  options: "-c client_encoding=UTF8",
});

pool.on("connect", (client) => {
  client.query("SET client_encoding TO 'UTF8'").catch(() => {});
});

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
    .replace(/[^a-z0-9]+/g, "");
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
  if (municipality_id) return municipality_id;
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
  try {
    const r = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: r.rows[0].ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: "db_error", message: err.message });
  }
});

app.get("/api/debug/db-encoding", async (req, res) => {
  try {
    const r = await pool.query("SHOW client_encoding");
    res.json({ ok: true, client_encoding: r.rows[0].client_encoding });
  } catch (err) {
    res.status(500).json({ ok: false, error: "db_error", message: err.message });
  }
});

app.get("/api/municipalities", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name_sq, name_key FROM municipalities ORDER BY name_sq`
    );
    res.json({ rows: r.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: "db_error", message: err.message });
  }
});

// Public feed from v_public_feed (only published rows)
app.get("/api/feed", async (req, res) => {
  try {
    const { municipality, municipality_id, category, limit = 50, offset = 0 } = req.query;

    const params = [];
    const where = [];

    // Prefer municipality_id filtering. If a municipality name is provided,
    // resolve it via name_key and then filter by municipality_id.
    if (municipality_id) {
      params.push(String(municipality_id));
      where.push(`municipality_id = $${params.length}`);
    } else if (municipality) {
      const key = toNameKey(String(municipality));
      const r = await pool.query(`SELECT id FROM municipalities WHERE name_key = $1 LIMIT 1`, [key]);
      if (r.rowCount) {
        params.push(String(r.rows[0].id));
        where.push(`municipality_id = $${params.length}`);
      } else {
        // fallback: allow direct string match if view exposes municipality name (legacy)
        params.push(String(municipality));
        where.push(`municipality = $${params.length}`);
      }
    }

    if (category) {
      params.push(String(category));
      where.push(`category = $${params.length}`);
    }

    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);

    params.push(lim);
    const limitIdx = params.length;
    params.push(off);
    const offsetIdx = params.length;

    const sql = `
      SELECT *
      FROM v_public_feed
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY collected_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;

    const r2 = await pool.query(sql, params);
    res.json({ rows: r2.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: "server_error", message: err.message });
  }
});

// ----------------------------
// Manual scraper: TIRANË → VENDIME (kept for debugging)
// ----------------------------
app.post("/api/scrape/tirana/vendime", async (req, res) => {
  try {
    const municipalityName = "Tiranë";
    const category = "Vendime";
    const year = Number(req.query.year || 2026);
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
    res.status(500).json({ ok: false, error: "scrape_error", message: err.message });
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
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const year = Number(req.query.year || 2026);

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

    if (registryRow.cooldown_until_utc && new Date(registryRow.cooldown_until_utc) > new Date()) {
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

    // auto-publish if registry already CHECKED
    const defaultStatus = registryRow.verification_status === "CHECKED" ? "published" : "draft";

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

    return res.json({
      ok: true,
      municipality: municipality || municipalityId,
      municipality_id: municipalityId,
      category: "Vendime",
      used_registry_id: registryRow.id,
      scraped_from: usedUrl || targetUrl,
      parsed_rows_total: scrapedItems.length,
      parsed_rows_kept: parsed_kept,
      inserted,
      skipped,
      skipped_missing_url,
      skipped_not_vendim,
      sample_title: sample_kept_title || scrapedItems[0]?.title || null,
      next: "Next: run the remaining checked municipalities and confirm parsed_rows_kept > 0.",
    });
  } catch (err) {
    const causeCode = err?.cause?.code || err?.code || "";
    let errorType = "SCRAPE_ERROR";

    if (causeCode === "CERT_HAS_EXPIRED") errorType = "TLS_CERT_EXPIRED";
    else if (causeCode === "DEPTH_ZERO_SELF_SIGNED_CERT") errorType = "TLS_SELF_SIGNED";
    else if (causeCode === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") errorType = "TLS_UNVERIFIED_CHAIN";

    if (registryRow?.id) {
      await pool.query(
        `
        UPDATE source_registry
        SET
          last_error_type = $2,
          cooldown_until_utc = now() + interval '30 minutes'
        WHERE id = $1
        `,
        [registryRow.id, errorType]
      );
    }

    return res.status(502).json({
      ok: false,
      error: "scrape_error",
      message: String(err?.message || err),
      cause: causeCode || null,
      last_error_type: errorType,
    });
  }
});

const port = process.env.PORT || 5050;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

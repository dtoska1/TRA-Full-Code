// backend/scripts/discover-registry.js\

require("dotenv").config();
const { Pool } = require("pg");
const cheerio = require("cheerio");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreLink(text, href, type) {
  const t = norm(text);
  const h = norm(href);

  const keywords = {
    vendime: ["vendim", "vendime", "keshilli", "keshillit", "mbledhje", "projektvendim", "projekt-vendim", "akt"],
    prokurime: ["prokurim", "prokurime", "tender", "tendera", "kontrata publike", "kontrata"],
    konsultime: ["konsultim", "konsultime", "njoftim", "njoftimi", "degjesa", "publik", "regjistri i projekt akteve"]
  }[type];

  let s = 0;
  for (const k of keywords) {
    if (t.includes(k)) s += 5;
    if (h.includes(k)) s += 4;
  }

  // Bonuses
  if (h.includes("transparenc")) s += 2;
  if (h.includes("category")) s += 1;
  if (h.includes("wp-content/uploads")) s += 1;

  return s;
}

function absolutize(base, href) {
  try { return new URL(href, base).toString(); } catch { return href; }
}

async function fetchHtml(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "TransparencyRadarBot/1.0", Accept: "text/html" }
  });
  if (!r.ok) throw new Error(`fetch failed: ${r.status} ${r.statusText}`);
  return await r.text();
}

async function discoverForRow(row) {
  const base = row.base_url;
  const html = await fetchHtml(base);
  const $ = cheerio.load(html);

  const links = [];
  $("a").each((_, a) => {
    const text = $(a).text().trim();
    const href = $(a).attr("href");
    if (!href) return;
    const abs = absolutize(base, href);
    links.push({ text, href: abs });
  });

  function best(type) {
    let best = null;
    for (const l of links) {
      const sc = scoreLink(l.text, l.href, type);
      if (!best || sc > best.score) best = { ...l, score: sc };
    }
    return best && best.score >= 6 ? best : null; // threshold
  }

  const bVendime = best("vendime");
  const bProk = best("prokurime");
  const bKons = best("konsultime");

  return {
    vendime_url: row.vendime_url || (bVendime ? bVendime.href : null),
    vendime_confidence: row.vendime_confidence || (bVendime ? Math.min(1, bVendime.score / 20) : null),

    prokurime_url: row.prokurime_url || (bProk ? bProk.href : null),
    prokurime_confidence: row.prokurime_confidence || (bProk ? Math.min(1, bProk.score / 20) : null),

    konsultime_url: row.konsultime_url || (bKons ? bKons.href : null),
    konsultime_confidence: row.konsultime_confidence || (bKons ? Math.min(1, bKons.score / 20) : null)
  };
}

(async () => {
  const limit = Number(process.argv[2] || 10);

  const r = await pool.query(`
    SELECT *
    FROM source_registry
    WHERE is_primary = true
    ORDER BY updated_at ASC
    LIMIT $1
  `, [limit]);

  let updated = 0;

  for (const row of r.rows) {
    try {
      const found = await discoverForRow(row);

      await pool.query(`
        UPDATE source_registry
        SET
          vendime_url = COALESCE(vendime_url, $2),
          vendime_confidence = COALESCE(vendime_confidence, $3),
          prokurime_url = COALESCE(prokurime_url, $4),
          prokurime_confidence = COALESCE(prokurime_confidence, $5),
          konsultime_url = COALESCE(konsultime_url, $6),
          konsultime_confidence = COALESCE(konsultime_confidence, $7),
          verification_status = 'CHECKED'
        WHERE id = $1
      `, [
        row.id,
        found.vendime_url, found.vendime_confidence,
        found.prokurime_url, found.prokurime_confidence,
        found.konsultime_url, found.konsultime_confidence
      ]);

      updated++;
      console.log("UPDATED", row.base_url);
    } catch (e) {
      console.log("SKIP", row.base_url, "-", e.message);
    }
  }

  console.log("DONE updated:", updated);
  process.exit(0);
})();

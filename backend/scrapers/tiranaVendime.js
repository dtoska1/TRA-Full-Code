// backend/scrapers/tiranaVendime.js

const cheerio = require("cheerio");

function parseAlbanianDate_ddmmyyyy(s) {
  const m = String(s || "").trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeTitle(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function scrapeTiranaVendime({ year = 2026, limit = 50, urlOverride = null }) {
  const url =
    urlOverride ||
    `https://tirana.al/kategoria-e-publikimit/vendime-te-keshillit-bashkiak-${year}-4290`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "TransparencyRadarBot/1.0",
      Accept: "text/html",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Tirana vendime page: ${res.status} ${res.statusText}`);
  }

  // Use arrayBuffer -> utf8 decode (works for tirana.al pages you tested)
  const arrayBuffer = await res.arrayBuffer();
  const html = Buffer.from(arrayBuffer).toString("utf8");

  const $ = cheerio.load(html);

  const rows = [];
  $("table tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 3) return;

    const num = $(tds[0]).text().trim();
    const dateStr = $(tds[1]).text().trim();
    const linkEl = $(tds[2]).find("a").first();

    const title = linkEl.text().trim();
    const href = linkEl.attr("href");

    if (!title || !href) return;

    rows.push({
      number: num,
      published_date: parseAlbanianDate_ddmmyyyy(dateStr),
      date_raw: dateStr,
      title,
      title_normalized: normalizeTitle(title),
      source_url: href, // can be relative; index.js makes it absolute
    });
  });

  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  return { url, items: rows.slice(0, lim) };
}

module.exports = { scrapeTiranaVendime };

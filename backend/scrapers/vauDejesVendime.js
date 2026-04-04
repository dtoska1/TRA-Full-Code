"use strict";

const cheerio = require("cheerio");

const SCRAPE_REQUEST_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(String(process.env.SCRAPE_REQUEST_TIMEOUT_MS || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20000;
})();

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function makeAbsolute(baseUrl, href) {
  if (!href) return null;
  try {
    return new URL(String(href).trim(), baseUrl).toString();
  } catch {
    return null;
  }
}

function decodeHtml(value) {
  return cleanText(cheerio.load(`<div>${String(value || "")}</div>`)("div").text());
}

function extractNumberFromTitle(title) {
  const m =
    String(title || "").match(/^\s*([0-9]{1,5})\s*[\.)-]?\s*vendim\b/i) ||
    String(title || "").match(/\bnr\.?\s*([0-9]{1,5})\b/i);
  return m ? m[1] : null;
}

function extractFirstDocumentUrl(baseUrl, html) {
  const $ = cheerio.load(String(html || ""));
  let found = null;

  $("a[href]").each((_, a) => {
    if (found) return;
    const href = $(a).attr("href");
    const abs = makeAbsolute(baseUrl, href);
    if (!abs) return;
    if (!/\.(pdf|doc|docx|xls|xlsx)(\?|#|$)/i.test(abs)) return;
    found = abs;
  });

  return found;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`Vau i Dejes REST fetch failed: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`Vau i Dejes REST request timed out after ${SCRAPE_REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYearTermId(siteUrl, year) {
  const base = new URL("/wp-json/wp/v2/ept_vendime_viti", siteUrl);
  base.searchParams.set("per_page", "100");
  base.searchParams.set("_fields", "id,name,slug,count");

  const terms = await fetchJson(base.toString());
  if (!Array.isArray(terms)) {
    throw new Error("Vau i Dejes REST returned malformed vendime year taxonomy response");
  }

  const wanted = String(year || "").trim();
  const match = terms.find(
    (term) => String(term?.name || "").trim() === wanted || String(term?.slug || "").trim() === wanted
  );

  return Number.isFinite(Number(match?.id)) ? Number(match.id) : null;
}

async function scrapeVauDejesVendime({ url, year, limit = 50, pageStart = 1 }) {
  const siteUrl = url || "https://vaudejes.gov.al/vendime/";
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const yearTermId = await fetchYearTermId(siteUrl, year);
  if (!yearTermId) {
    return { url: siteUrl, items: [] };
  }

  const items = [];
  const seen = new Set();
  const perPage = Math.max(1, Math.min(100, lim));
  let page = Math.max(1, Number(pageStart) || 1);

  while (items.length < lim) {
    const endpoint = new URL("/wp-json/wp/v2/ept_vendime", siteUrl);
    endpoint.searchParams.set("ept_vendime_viti", String(yearTermId));
    endpoint.searchParams.set("per_page", String(perPage));
    endpoint.searchParams.set("page", String(page));
    endpoint.searchParams.set("_fields", "id,date,link,title,content");

    const posts = await fetchJson(endpoint.toString());
    if (!Array.isArray(posts)) {
      throw new Error("Vau i Dejes REST returned malformed vendime posts response");
    }
    if (posts.length === 0) break;

    for (const post of posts) {
      if (items.length >= lim) break;

      const title = decodeHtml(post?.title?.rendered || "");
      const sourcePageUrl = makeAbsolute(siteUrl, post?.link || "");
      const sourceUrl =
        extractFirstDocumentUrl(sourcePageUrl || siteUrl, post?.content?.rendered || "") ||
        sourcePageUrl;
      const publishedDate = cleanText(String(post?.date || "")).slice(0, 10) || null;

      if (!title || !sourceUrl || !publishedDate) continue;
      const key = `${sourceUrl}|${publishedDate}`;
      if (seen.has(key)) continue;
      seen.add(key);

      items.push({
        title,
        title_normalized: normalizeTitle(title),
        source_url: sourceUrl,
        source_page_url: sourcePageUrl,
        published_date: publishedDate,
        number: extractNumberFromTitle(title),
      });
    }

    if (posts.length < perPage) break;
    page += 1;
  }

  return { url: siteUrl, items };
}

module.exports = { scrapeVauDejesVendime };

"use strict";

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

function getHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function parseAlbanianNumericDate(value) {
  const raw = cleanText(value).replace(/[-/]/g, ".");
  const match = raw.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,5})\b/);
  if (!match) return null;

  let [, dd, mm, yyyy] = match;
  if (yyyy.length === 2) {
    const year = Number.parseInt(yyyy, 10);
    yyyy = year <= 30 ? `20${yyyy.padStart(2, "0")}` : `19${yyyy.padStart(2, "0")}`;
  } else if (yyyy.length === 5 && yyyy.startsWith("20")) {
    yyyy = yyyy.slice(0, 4);
  }

  const iso = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  if (
    date.getUTCFullYear() !== Number(yyyy) ||
    date.getUTCMonth() + 1 !== Number(mm) ||
    date.getUTCDate() !== Number(dd)
  ) {
    return null;
  }
  return iso;
}

function isSupportedVendimeYear(isoDate) {
  const year = Number.parseInt(String(isoDate || "").slice(0, 4), 10);
  return Number.isInteger(year) && year >= 2000 && year <= 2100;
}

function numberFromText(value) {
  const raw = cleanText(value);
  const match =
    raw.match(/\bnr\.?\s*:?\s*(\d{1,5})\b/i) ||
    raw.match(/\bnum(?:ri)?\.?\s*:?\s*(\d{1,5})\b/i) ||
    raw.match(/^\s*(\d{1,5})\s*$/);
  return match ? match[1] : null;
}

function isLikelyDocumentUrl(url) {
  return /\.(pdf|doc|docx|zip)(\?|#|$)/i.test(String(url || ""));
}

async function fetchText(url, { timeoutMs = 25000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        "Accept-Language": "sq-AL,sq;q=0.9,en;q=0.8",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        ...headers,
      },
    });
    const arrayBuffer = await res.arrayBuffer();
    return {
      ok: res.ok,
      status: res.status,
      url: res.url || url,
      text: Buffer.from(arrayBuffer).toString("utf8"),
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBufferWithLimit(
  url,
  { timeoutMs = 30000, maxBytes = 20 * 1024 * 1024, headers = {} } = {}
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        "Accept-Language": "sq-AL,sq;q=0.9,en;q=0.8",
        Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
        ...headers,
      },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, url: res.url || url, buffer: null };
    }

    const contentLength = Number.parseInt(String(res.headers.get("content-length") || ""), 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return {
        ok: false,
        status: 413,
        url: res.url || url,
        buffer: null,
        reason: `content_length_${contentLength}`,
      };
    }

    const chunks = [];
    let total = 0;
    const appendChunk = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        const err = new Error(`too_large_${total}`);
        err.code = "TOO_LARGE";
        err.total = total;
        throw err;
      }
      chunks.push(buffer);
    };

    try {
      if (res.body && typeof res.body.getReader === "function") {
        const reader = res.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            appendChunk(value);
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {}
        }
      } else if (res.body) {
        for await (const chunk of res.body) {
          appendChunk(chunk);
        }
      } else {
        appendChunk(Buffer.from(await res.arrayBuffer()));
      }
    } catch (err) {
      if (err?.code === "TOO_LARGE") {
        return {
          ok: false,
          status: 413,
          url: res.url || url,
          buffer: null,
          reason: err.message,
        };
      }
      throw err;
    }

    return {
      ok: true,
      status: res.status,
      url: res.url || url,
      buffer: Buffer.concat(chunks, total),
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  cleanText,
  fetchBufferWithLimit,
  fetchText,
  getHost,
  isLikelyDocumentUrl,
  isSupportedVendimeYear,
  makeAbsolute,
  normalizeTitle,
  numberFromText,
  parseAlbanianNumericDate,
};

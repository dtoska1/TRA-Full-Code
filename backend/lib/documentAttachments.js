"use strict";

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

function hasZipMagicBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  const head = buffer.slice(0, 4).toString("binary");
  return head === "PK\u0003\u0004" || head === "PK\u0005\u0006" || head === "PK\u0007\b";
}

function hasOleCompoundMagicBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false;
  return buffer.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
}

const SCRAPER_ATTACHMENT_TYPES = {
  pdf: { extension: "pdf", mimeType: "application/pdf" },
  doc: { extension: "doc", mimeType: "application/msword" },
  docx: {
    extension: "docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  zip: { extension: "zip", mimeType: "application/zip" },
};
const SCRAPER_ATTACHMENT_EXTENSIONS = new Set(Object.keys(SCRAPER_ATTACHMENT_TYPES));

function getAllowlistedAttachmentExtension(fileName) {
  const match = /\.([a-z0-9]+)$/i.exec(String(fileName || "").split(/[?#]/)[0] || "");
  if (!match) return null;
  const ext = match[1].toLowerCase();
  return SCRAPER_ATTACHMENT_EXTENSIONS.has(ext) ? ext : null;
}

function safeDecodeUrlPath(value) {
  const raw = String(value || "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function getAttachmentExtensionFromUrl(value) {
  const raw = parseHttpUrl(value);
  if (!raw) return null;

  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  const pathExt = getAllowlistedAttachmentExtension(safeDecodeUrlPath(parsed.pathname || ""));
  if (pathExt) return pathExt;

  for (const value of parsed.searchParams.values()) {
    const paramExt = getAllowlistedAttachmentExtension(safeDecodeUrlPath(value));
    if (paramExt) return paramExt;
  }

  return null;
}

function getAttachmentExtensionFromContentType(contentType) {
  const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "application/pdf") return "pdf";
  if (normalized === "application/msword") return "doc";
  if (normalized === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return "docx";
  }
  if (normalized === "application/zip" || normalized === "application/x-zip-compressed") {
    return "zip";
  }
  return null;
}

function detectScrapedAttachmentType({ sourceUrl, contentType, buffer }) {
  const urlExt = getAttachmentExtensionFromUrl(sourceUrl);
  const contentExt = getAttachmentExtensionFromContentType(contentType);
  const candidates = [urlExt, contentExt].filter(Boolean);

  if (candidates.includes("pdf") || hasPdfMagicBytes(buffer)) {
    return hasPdfMagicBytes(buffer) ? SCRAPER_ATTACHMENT_TYPES.pdf : null;
  }

  if (candidates.includes("doc")) {
    return hasOleCompoundMagicBytes(buffer) ? SCRAPER_ATTACHMENT_TYPES.doc : null;
  }

  if (candidates.includes("docx")) {
    return hasZipMagicBytes(buffer) ? SCRAPER_ATTACHMENT_TYPES.docx : null;
  }

  if (candidates.includes("zip")) {
    return hasZipMagicBytes(buffer) ? SCRAPER_ATTACHMENT_TYPES.zip : null;
  }

  if (hasZipMagicBytes(buffer)) return SCRAPER_ATTACHMENT_TYPES.zip;
  return null;
}

function isLikelyDocumentAttachmentUrl(value) {
  const raw = parseHttpUrl(value);
  if (!raw) return false;

  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }

  const lowerUrl = raw.toLowerCase();
  const lowerPath = safeDecodeUrlPath(parsed.pathname || "").toLowerCase();
  if (getAttachmentExtensionFromUrl(raw)) return true;
  if (/\/(download|downloads|file|files|attachment|attachments)(\/|$)/i.test(lowerPath)) {
    return true;
  }

  for (const [key, value] of parsed.searchParams.entries()) {
    const normalizedKey = String(key || "").toLowerCase();
    const normalizedValue = safeDecodeUrlPath(value).toLowerCase();
    if (getAllowlistedAttachmentExtension(normalizedValue)) return true;
    if (["download", "file", "attachment", "attachment_id", "document"].includes(normalizedKey)) {
      return true;
    }
  }

  return /\.(pdf|doc|docx|zip)(\?|#|$)/i.test(lowerUrl);
}

function normalizeAttachmentHost(value) {
  return String(value || "").trim().toLowerCase().replace(/^www\./, "");
}

function isSameOfficialHost(url, officialHost) {
  const normalizedOfficialHost = normalizeAttachmentHost(officialHost);
  if (!normalizedOfficialHost) return false;

  let parsed = null;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    return false;
  }

  return normalizeAttachmentHost(parsed.hostname) === normalizedOfficialHost;
}

module.exports = {
  detectScrapedAttachmentType,
  getAllowlistedAttachmentExtension,
  getAttachmentExtensionFromUrl,
  isLikelyDocumentAttachmentUrl,
  isSameOfficialHost,
  normalizeAttachmentHost,
  parseHttpUrl,
};

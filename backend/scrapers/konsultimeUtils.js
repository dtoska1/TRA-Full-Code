"use strict";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function foldText(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

function normalizeTitle(value) {
  return foldText(value).replace(/[^a-z0-9]+/g, " ").trim();
}

function classifyKind(title, excerpt = "") {
  const text = foldText(`${title || ""} ${excerpt || ""}`);
  return text.includes("degjes") ? "hearing" : "consultation_notice";
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

module.exports = {
  classifyKind,
  cleanText,
  foldText,
  getHost,
  makeAbsolute,
  normalizeTitle,
};

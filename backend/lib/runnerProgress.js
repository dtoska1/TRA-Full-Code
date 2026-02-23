"use strict";

const fs = require("fs");
const path = require("path");

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function loadProgress(filePath, defaults = {}) {
  const base = { ...asObject(defaults) };
  if (!fs.existsSync(filePath)) return base;

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return { ...base, ...asObject(parsed) };
  } catch {
    return base;
  }
}

function saveProgress(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(asObject(obj), null, 2)}\n`, "utf8");
}

function shouldSleep(ms) {
  const waitMs = Math.max(0, Number(ms) || 0);
  if (waitMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, waitMs));
}

function backoffOn429({ attempt, baseMs, maxMs }) {
  const safeAttempt = Math.max(0, Math.min(30, Number.parseInt(String(attempt), 10) || 0));
  const safeBaseMs = Math.max(1, Number.parseInt(String(baseMs), 10) || 1000);
  const safeMaxMs = Math.max(safeBaseMs, Number.parseInt(String(maxMs), 10) || 60000);
  return Math.min(safeMaxMs, safeBaseMs * Math.pow(2, safeAttempt));
}

module.exports = {
  loadProgress,
  saveProgress,
  shouldSleep,
  backoffOn429,
};

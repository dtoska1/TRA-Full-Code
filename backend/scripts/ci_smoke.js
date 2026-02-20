#!/usr/bin/env node
const BASE_URL = String(process.env.SMOKE_BASE_URL || "http://127.0.0.1:5050").replace(
  /\/+$/,
  ""
);
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson(path, init = {}) {
  const res = await fetch(`${BASE_URL}${path}`, init);
  const text = await res.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return { status: res.status, json, text };
}

async function run() {
  assert(ADMIN_TOKEN, "ADMIN_TOKEN must be set for ci_smoke.js");

  const health = await requestJson("/health");
  assert(health.status === 200, `GET /health expected 200, got ${health.status}`);
  assert(health.json && health.json.ok === true, "GET /health expected { ok: true }");

  const feed = await requestJson("/api/feed");
  assert(feed.status === 200, `GET /api/feed expected 200, got ${feed.status}`);
  assert(feed.json && feed.json.ok === true, "GET /api/feed expected { ok: true }");
  assert(Array.isArray(feed.json.items), "GET /api/feed expected items array");

  const scrapeNoAuth = await requestJson("/api/scrape/run", {
    method: "POST",
  });
  assert(
    scrapeNoAuth.status === 401,
    `POST /api/scrape/run without auth expected 401, got ${scrapeNoAuth.status}`
  );

  const categories = ["Prokurime", "Konsultime publike"];
  for (const category of categories) {
    const path =
      `/api/scrape/run?municipality=tirane&year=2026&limit=1&category=` +
      encodeURIComponent(category);
    const response = await requestJson(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
    });

    assert(
      response.status >= 400 && response.status < 500,
      `POST ${path} expected 4xx, got ${response.status}`
    );
    assert(
      response.json && response.json.error !== "unsupported_category",
      `POST ${path} should accept category, got unsupported_category`
    );
  }

  console.log("Smoke checks passed.");
}

run().catch((err) => {
  console.error("Smoke checks failed:", err.message);
  process.exit(1);
});

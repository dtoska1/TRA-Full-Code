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

  const coverageNoAuth = await requestJson("/api/admin/coverage");
  assert(
    coverageNoAuth.status === 401,
    `GET /api/admin/coverage without auth expected 401, got ${coverageNoAuth.status}`
  );

  const coverageWithAuth = await requestJson("/api/admin/coverage", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
  });
  assert(
    coverageWithAuth.status === 200,
    `GET /api/admin/coverage with auth expected 200, got ${coverageWithAuth.status}`
  );
  assert(
    coverageWithAuth.json && coverageWithAuth.json.ok === true,
    "GET /api/admin/coverage expected { ok: true }"
  );
  assert(
    Array.isArray(coverageWithAuth.json.items),
    "GET /api/admin/coverage expected items array"
  );
  if (coverageWithAuth.json.items.length > 0) {
    assert(
      typeof coverageWithAuth.json.items[0].category_checked === "boolean",
      "GET /api/admin/coverage expected category_checked boolean on rows"
    );
  }

  const sourceCheckedNoAuth = await requestJson(
    `/api/admin/source/checked?municipality=tirane&category=${encodeURIComponent("Vendime")}&checked=true`,
    {
      method: "POST",
    }
  );
  assert(
    sourceCheckedNoAuth.status === 401,
    `POST /api/admin/source/checked without auth expected 401, got ${sourceCheckedNoAuth.status}`
  );

  const publishNoAuth = await requestJson(
    `/api/admin/publish?municipality=tirane&category=${encodeURIComponent("Vendime")}`,
    {
      method: "POST",
    }
  );
  assert(
    publishNoAuth.status === 401,
    `POST /api/admin/publish without auth expected 401, got ${publishNoAuth.status}`
  );

  const sourceCheckedWithAuth = await requestJson(
    `/api/admin/source/checked?municipality=tirane&category=${encodeURIComponent(
      "Vendime"
    )}&checked=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
    }
  );
  assert(
    sourceCheckedWithAuth.status === 200,
    `POST /api/admin/source/checked with auth expected 200, got ${sourceCheckedWithAuth.status}`
  );
  assert(
    sourceCheckedWithAuth.json && sourceCheckedWithAuth.json.ok === true,
    "POST /api/admin/source/checked expected { ok: true }"
  );
  assert(
    sourceCheckedWithAuth.json && sourceCheckedWithAuth.json.checked === true,
    "POST /api/admin/source/checked expected checked=true"
  );

  const publishWithAuth = await requestJson(
    `/api/admin/publish?municipality=tirane&category=${encodeURIComponent("Vendime")}&year=2025`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
    }
  );
  assert(
    publishWithAuth.status === 200,
    `POST /api/admin/publish with auth expected 200, got ${publishWithAuth.status}`
  );
  assert(
    publishWithAuth.json && publishWithAuth.json.ok === true,
    "POST /api/admin/publish expected { ok: true }"
  );
  assert(
    Number.isFinite(Number(publishWithAuth.json?.published_updated)),
    "POST /api/admin/publish expected numeric published_updated"
  );

  const categories = ["Prokurime", "Konsultime publike"];
  for (const category of categories) {
    const path =
      `/api/scrape/run?municipality=tirane&year=1999&limit=1&category=` +
      encodeURIComponent(category);
    const response = await requestJson(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
    });

    assert(
      response.status === 400,
      `POST ${path} expected 400 (invalid year), got ${response.status}`
    );
    assert(
      response.json && response.json.error !== "unsupported_category",
      `POST ${path} should accept category, got unsupported_category`
    );
  }

  const nationwideProkurimePath = `/api/scrape/run?year=2025&limit=1&offset=0&category=${encodeURIComponent(
    "Prokurime"
  )}`;
  const nationwideProkurime = await requestJson(nationwideProkurimePath, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
  });
  assert(
    nationwideProkurime.status === 200,
    `POST ${nationwideProkurimePath} expected 200, got ${nationwideProkurime.status}`
  );
  assert(
    nationwideProkurime.json && nationwideProkurime.json.ok === true,
    "Nationwide Prokurime scrape expected { ok: true }"
  );
  assert(
    Number.isFinite(Number(nationwideProkurime.json?.matched_rows_total)),
    "Nationwide Prokurime scrape expected numeric matched_rows_total"
  );
  assert(
    Number(nationwideProkurime.json?.offset) === 0,
    "Nationwide Prokurime scrape expected offset=0"
  );
  assert(
    Number(nationwideProkurime.json?.next_offset) === 1,
    "Nationwide Prokurime scrape expected next_offset=1 in fixture chunk mode"
  );
  assert(
    Number.isFinite(Number(nationwideProkurime.json?.draft_inserted)),
    "Nationwide Prokurime scrape expected numeric draft_inserted"
  );
  assert(
    Number.isFinite(Number(nationwideProkurime.json?.published_inserted)),
    "Nationwide Prokurime scrape expected numeric published_inserted"
  );
  assert(
    Number.isFinite(Number(nationwideProkurime.json?.skipped_no_municipality_match)),
    "Nationwide Prokurime scrape expected numeric skipped_no_municipality_match"
  );
  assert(
    Number.isFinite(Number(nationwideProkurime.json?.inserted)),
    "Nationwide Prokurime scrape expected numeric inserted"
  );
  assert(
    Number.isFinite(Number(nationwideProkurime.json?.updated)),
    "Nationwide Prokurime scrape expected numeric updated"
  );
  assert(
    Number.isFinite(Number(nationwideProkurime.json?.skipped)),
    "Nationwide Prokurime scrape expected numeric skipped"
  );

  console.log("Smoke checks passed.");
}

run().catch((err) => {
  console.error("Smoke checks failed:", err.message);
  process.exit(1);
});

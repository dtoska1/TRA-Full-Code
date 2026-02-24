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

async function requestRaw(path, init = {}) {
  const res = await fetch(`${BASE_URL}${path}`, init);
  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    headers: res.headers,
    buffer,
  };
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

  const manualNoAuth = await requestJson("/api/admin/items/manual", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      municipality: "tirane",
      category: "Vendime",
      title: "Smoke manual no-auth",
      source_url: "https://example.org/no-auth.pdf",
    }),
  });
  assert(
    manualNoAuth.status === 401,
    `POST /api/admin/items/manual without auth expected 401, got ${manualNoAuth.status}`
  );

  const invalidUploadForm = new FormData();
  invalidUploadForm.set("municipality", "tirane");
  invalidUploadForm.set("category", "Vendime");
  invalidUploadForm.set("title", "Smoke invalid upload");
  invalidUploadForm.set("published_date", "2025-01-15");
  invalidUploadForm.set(
    "file",
    new Blob([Buffer.from("not a pdf", "utf8")], { type: "application/pdf" }),
    "invalid.pdf"
  );
  const invalidUpload = await requestJson("/api/admin/items/manual", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: invalidUploadForm,
  });
  assert(
    invalidUpload.status === 400,
    `POST /api/admin/items/manual invalid upload expected 400, got ${invalidUpload.status}`
  );

  const validPdfBytes = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n",
    "ascii"
  );
  const validUploadForm = new FormData();
  validUploadForm.set("municipality", "tirane");
  validUploadForm.set("category", "Vendime");
  validUploadForm.set("title", "Smoke valid upload");
  validUploadForm.set("published_date", "2025-01-15");
  validUploadForm.set(
    "file",
    new Blob([validPdfBytes], { type: "application/pdf" }),
    "valid.pdf"
  );
  const validUpload = await requestJson("/api/admin/items/manual", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: validUploadForm,
  });
  assert(
    validUpload.status === 201,
    `POST /api/admin/items/manual valid upload expected 201, got ${validUpload.status}`
  );
  assert(validUpload.json && validUpload.json.ok === true, "Valid upload expected { ok: true }");
  assert(
    typeof validUpload.json?.attachment_id === "string" && validUpload.json.attachment_id.length > 0,
    "Valid upload expected attachment_id"
  );
  const attachmentId = String(validUpload.json.attachment_id);

  const publicBeforePublish = await requestJson(`/api/public/files/${attachmentId}`);
  assert(
    publicBeforePublish.status === 404,
    `GET /api/public/files/:id before publish expected 404, got ${publicBeforePublish.status}`
  );

  const adminFileNoAuth = await requestJson(`/api/admin/files/${attachmentId}`);
  assert(
    adminFileNoAuth.status === 401,
    `GET /api/admin/files/:id without auth expected 401, got ${adminFileNoAuth.status}`
  );

  const adminFileWithAuth = await requestRaw(`/api/admin/files/${attachmentId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
  });
  assert(
    adminFileWithAuth.status === 200,
    `GET /api/admin/files/:id with auth expected 200, got ${adminFileWithAuth.status}`
  );
  assert(
    adminFileWithAuth.buffer.slice(0, 5).toString("ascii") === "%PDF-",
    "GET /api/admin/files/:id expected PDF magic bytes"
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
  assert(
    Number(publishWithAuth.json?.published_updated) >= 1,
    "POST /api/admin/publish expected to publish at least one draft manual item"
  );

  const publicAfterPublish = await requestRaw(`/api/public/files/${attachmentId}`);
  assert(
    publicAfterPublish.status === 200,
    `GET /api/public/files/:id after publish expected 200, got ${publicAfterPublish.status}`
  );
  assert(
    publicAfterPublish.buffer.slice(0, 5).toString("ascii") === "%PDF-",
    "GET /api/public/files/:id expected PDF magic bytes after publish"
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

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
  assert(
    typeof validUpload.json?.item_id === "string" && validUpload.json.item_id.length > 0,
    "Valid upload expected item_id"
  );
  const itemId = String(validUpload.json.item_id);
  const attachmentId = String(validUpload.json.attachment_id);

  const publicBeforePublish = await requestJson(`/api/public/files/${attachmentId}`);
  assert(
    publicBeforePublish.status === 404,
    `GET /api/public/files/:id before publish expected 404, got ${publicBeforePublish.status}`
  );
  const itemBeforePublish = await requestJson(`/api/items/${itemId}`);
  assert(
    itemBeforePublish.status === 404,
    `GET /api/items/:id before publish expected 404, got ${itemBeforePublish.status}`
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
  assert(
    Number.isFinite(Number(publishWithAuth.json?.published_with_attachments)),
    "POST /api/admin/publish expected numeric published_with_attachments"
  );
  assert(
    Number.isFinite(Number(publishWithAuth.json?.attachments_now_public_count)),
    "POST /api/admin/publish expected numeric attachments_now_public_count"
  );
  assert(
    Number(publishWithAuth.json?.published_with_attachments) >= 0,
    "POST /api/admin/publish expected non-negative published_with_attachments"
  );
  assert(
    Number(publishWithAuth.json?.attachments_now_public_count) >= 0,
    "POST /api/admin/publish expected non-negative attachments_now_public_count"
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

  const feedAfterPublish = await requestJson(
    `/api/feed?municipality=tirane&category=${encodeURIComponent("Vendime")}&limit=100`
  );
  assert(
    feedAfterPublish.status === 200,
    `GET /api/feed after publish expected 200, got ${feedAfterPublish.status}`
  );
  assert(
    feedAfterPublish.json && Array.isArray(feedAfterPublish.json.items),
    "GET /api/feed after publish expected items array"
  );
  const feedManualRow = (feedAfterPublish.json?.items || []).find((row) => String(row.id) === itemId);
  assert(feedManualRow, "GET /api/feed expected manual item row by id");
  assert(
    Number(feedManualRow.attachment_count) >= 1,
    "GET /api/feed expected attachment_count >= 1 for manual item"
  );
  assert(
    String(feedManualRow.primary_attachment_id || "") === attachmentId,
    "GET /api/feed expected primary_attachment_id to match uploaded attachment"
  );
  assert(
    String(feedManualRow.primary_attachment_public_url || "").includes(`/api/public/files/${attachmentId}`),
    "GET /api/feed expected primary_attachment_public_url for manual item"
  );

  const itemAfterPublish = await requestJson(`/api/items/${itemId}`);
  assert(
    itemAfterPublish.status === 200,
    `GET /api/items/:id after publish expected 200, got ${itemAfterPublish.status}`
  );
  assert(itemAfterPublish.json && itemAfterPublish.json.ok === true, "GET /api/items/:id expected { ok: true }");
  assert(
    Array.isArray(itemAfterPublish.json?.attachments),
    "GET /api/items/:id expected attachments array"
  );
  assert(
    Number(itemAfterPublish.json?.attachment_count) >= 1,
    "GET /api/items/:id expected attachment_count >= 1"
  );
  const itemAttachment = (itemAfterPublish.json?.attachments || []).find(
    (row) => String(row.id) === attachmentId
  );
  assert(itemAttachment, "GET /api/items/:id expected uploaded attachment in attachments array");
  assert(
    String(itemAttachment.public_file_url || "").includes(`/api/public/files/${attachmentId}`),
    "GET /api/items/:id expected attachment public_file_url"
  );
  assert(
    !String(JSON.stringify(itemAfterPublish.json)).includes("storage_uri"),
    "GET /api/items/:id must not expose storage_uri"
  );

  const coverageAfterPublish = await requestJson("/api/admin/coverage", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
  });
  assert(
    coverageAfterPublish.status === 200,
    `GET /api/admin/coverage after publish expected 200, got ${coverageAfterPublish.status}`
  );
  const coverageVendimeTirane = (coverageAfterPublish.json?.items || []).find(
    (row) => String(row.name_key) === "tirane" && String(row.category) === "Vendime"
  );
  assert(
    coverageVendimeTirane,
    "GET /api/admin/coverage expected tirane/Vendime row"
  );
  assert(
    Number.isFinite(Number(coverageVendimeTirane.published_attachment_count)),
    "Coverage row expected numeric published_attachment_count"
  );
  assert(
    Number.isFinite(Number(coverageVendimeTirane.draft_attachment_count)),
    "Coverage row expected numeric draft_attachment_count"
  );
  assert(
    coverageVendimeTirane.latest_attachment_id === null ||
      typeof coverageVendimeTirane.latest_attachment_id === "string",
    "Coverage row expected latest_attachment_id nullable string"
  );
  assert(
    coverageVendimeTirane.latest_attachment_item_status === null ||
      ["draft", "published"].includes(String(coverageVendimeTirane.latest_attachment_item_status)),
    "Coverage row expected latest_attachment_item_status in draft|published|null"
  );
  assert(
    coverageVendimeTirane.latest_admin_file_url === null ||
      String(coverageVendimeTirane.latest_admin_file_url).startsWith("/api/admin/files/"),
    "Coverage row expected latest_admin_file_url path"
  );
  assert(
    coverageVendimeTirane.latest_public_file_url === null ||
      String(coverageVendimeTirane.latest_public_file_url).startsWith("/api/public/files/"),
    "Coverage row expected latest_public_file_url path"
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

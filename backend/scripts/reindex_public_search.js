#!/usr/bin/env node
"use strict";

const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const { Pool } = require("pg");

const SEARCH_INDEX_UID = String(process.env.MEILI_PUBLIC_INDEX_UID || "public_items_v1").trim();
const MEILI_HOST = String(process.env.MEILI_HOST || "").trim().replace(/\/+$/, "");
const MEILI_MASTER_KEY = String(process.env.MEILI_MASTER_KEY || "").trim();

function parseArgs(argv) {
  const args = {};
  for (const token of argv.slice(2)) {
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    const eqIndex = body.indexOf("=");
    if (eqIndex === -1) {
      args[body] = true;
      continue;
    }
    args[body.slice(0, eqIndex)] = body.slice(eqIndex + 1);
  }
  return args;
}

function toInt(value, fallback) {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true) return true;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "t", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "f", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function buildPublicFilePath(attachmentId) {
  const id = String(attachmentId || "").trim();
  return id ? `/api/public/files/${encodeURIComponent(id)}` : null;
}

function toUnixTimestampMs(value, fallback = Date.now()) {
  const t = Date.parse(String(value || ""));
  if (Number.isFinite(t)) return t;
  return fallback;
}

function normalizeDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function meiliHeaders() {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (MEILI_MASTER_KEY) {
    headers.Authorization = `Bearer ${MEILI_MASTER_KEY}`;
  }
  return headers;
}

async function meiliRequest(method, routePath, body) {
  if (!MEILI_HOST) {
    throw new Error("MEILI_HOST is required.");
  }
  const url = `${MEILI_HOST}${routePath.startsWith("/") ? routePath : `/${routePath}`}`;
  const response = await fetch(url, {
    method,
    headers: meiliHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    const details = json && (json.message || json.code) ? `${json.code || "error"} ${json.message || ""}`.trim() : `HTTP ${response.status}`;
    const err = new Error(`Meili request failed (${method} ${routePath}): ${details}`);
    err.status = response.status;
    throw err;
  }
  return json;
}

function getTaskUid(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (Number.isFinite(Number(payload.taskUid))) return Number(payload.taskUid);
  if (Number.isFinite(Number(payload.uid))) return Number(payload.uid);
  return null;
}

async function waitForTask(taskUid, timeoutMs = 120000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const task = await meiliRequest("GET", `/tasks/${taskUid}`);
    const status = String(task?.status || "").toLowerCase();
    if (status === "succeeded") return task;
    if (status === "failed") {
      throw new Error(`Meili task ${taskUid} failed.`);
    }
    await sleep(350);
  }
  throw new Error(`Timed out waiting for Meili task ${taskUid}.`);
}

async function ensureIndexExists() {
  try {
    await meiliRequest("GET", `/indexes/${encodeURIComponent(SEARCH_INDEX_UID)}`);
    return;
  } catch (err) {
    if (Number(err?.status) !== 404) throw err;
  }
  const created = await meiliRequest("POST", "/indexes", {
    uid: SEARCH_INDEX_UID,
    primaryKey: "id",
  });
  const taskUid = getTaskUid(created);
  if (taskUid !== null) await waitForTask(taskUid);
}

async function applyIndexSettings() {
  const settingsTask = await meiliRequest(
    "PATCH",
    `/indexes/${encodeURIComponent(SEARCH_INDEX_UID)}/settings`,
    {
      searchableAttributes: [
        "title",
        "summary",
        "municipality_name",
        "category",
        "source_host",
      ],
      filterableAttributes: ["municipality_name_key", "category", "year"],
      sortableAttributes: ["published_ts", "collected_ts"],
    }
  );
  const taskUid = getTaskUid(settingsTask);
  if (taskUid !== null) await waitForTask(taskUid);
}

async function clearDocuments() {
  const clearTask = await meiliRequest(
    "DELETE",
    `/indexes/${encodeURIComponent(SEARCH_INDEX_UID)}/documents`
  );
  const taskUid = getTaskUid(clearTask);
  if (taskUid !== null) await waitForTask(taskUid);
}

function toSearchDocument(row) {
  const publishedAt = normalizeDateOnly(row.published_at);
  const collectedAt = row.collected_at ? new Date(row.collected_at).toISOString() : null;
  const year = publishedAt ? Number.parseInt(publishedAt.slice(0, 4), 10) : null;
  const sourceUrl = row.source_url ? String(row.source_url) : null;
  const sourceHost = getHost(sourceUrl);
  const primaryAttachmentId = String(row.primary_attachment_id || "").trim() || null;

  return {
    id: String(row.id),
    title: String(row.title || ""),
    summary: row.summary || null,
    municipality_name: row.municipality_name || null,
    municipality_name_key: row.municipality_name_key || null,
    category: row.category || null,
    published_at: publishedAt,
    collected_at: collectedAt,
    source_url: sourceUrl,
    source_host: sourceHost,
    attachment_count: Number(row.attachment_count || 0),
    primary_attachment_id: primaryAttachmentId,
    primary_attachment_public_url: buildPublicFilePath(primaryAttachmentId),
    year: Number.isFinite(year) ? year : null,
    published_ts: publishedAt
      ? toUnixTimestampMs(`${publishedAt}T00:00:00.000Z`, 0)
      : toUnixTimestampMs(collectedAt, 0),
    collected_ts: toUnixTimestampMs(collectedAt, 0),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const batchSize = Math.max(1, Math.min(2000, toInt(args.batch, 500)));
  const reset = toBool(args.reset, false);
  const dryRun = toBool(args.dry_run, false);

  if (!String(process.env.DATABASE_URL || "").trim()) {
    throw new Error("DATABASE_URL is required.");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM items WHERE status = 'published'`
    );
    const totalPublished = Number(countResult.rows[0]?.total || 0);
    console.log(
      `[reindex] start index=${SEARCH_INDEX_UID} total_published=${totalPublished} batch=${batchSize} dry_run=${dryRun} reset=${reset}`
    );

    let offset = 0;
    let indexed = 0;
    let sampleLogged = false;

    if (!dryRun) {
      await ensureIndexExists();
      await applyIndexSettings();
      if (reset) {
        await clearDocuments();
      }
    }

    while (true) {
      const rowsResult = await pool.query(
        `
        SELECT
          i.id::text AS id,
          i.title,
          i.summary,
          m.name_sq AS municipality_name,
          m.name_key AS municipality_name_key,
          i.category,
          i.published_date AS published_at,
          i.collected_at,
          i.source_url,
          COALESCE(att.attachment_count, 0)::int AS attachment_count,
          att.primary_attachment_id
        FROM items i
        JOIN municipalities m ON m.id = i.municipality_id
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS attachment_count,
            (ARRAY_AGG(a.id::text ORDER BY a.created_at ASC, a.id ASC))[1] AS primary_attachment_id
          FROM attachments a
          WHERE a.item_id = i.id
        ) att ON TRUE
        WHERE i.status = 'published'
        ORDER BY i.collected_at ASC, i.id ASC
        LIMIT $1 OFFSET $2
        `,
        [batchSize, offset]
      );

      if (!rowsResult.rowCount) break;

      const documents = rowsResult.rows.map(toSearchDocument);

      if (!sampleLogged && documents.length > 0) {
        const sample = {
          id: documents[0].id,
          title: documents[0].title,
          municipality_name_key: documents[0].municipality_name_key,
          category: documents[0].category,
        };
        console.log("[reindex] sample_document", JSON.stringify(sample));
        sampleLogged = true;
      }

      if (!dryRun) {
        const upsertTask = await meiliRequest(
          "POST",
          `/indexes/${encodeURIComponent(SEARCH_INDEX_UID)}/documents`,
          documents
        );
        const taskUid = getTaskUid(upsertTask);
        if (taskUid !== null) await waitForTask(taskUid);
      }

      indexed += documents.length;
      offset += rowsResult.rowCount;
      console.log(`[reindex] processed=${indexed}/${totalPublished}`);
    }

    console.log(`[reindex] done indexed=${indexed} dry_run=${dryRun}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[reindex] failed:", err.message);
  process.exit(1);
});

"use strict";

const COVERAGE_CATEGORIES = ["Vendime", "Prokurime", "Konsultime publike"];
const DEFAULT_PROKURIME_NATIONWIDE_SOURCE_URL =
  "https://www.app.gov.al/eksportimi-i-procedurave-te-publikuara/";

function resolveProkurimeNationwideSourceUrl() {
  const configured = String(process.env.PROKURIME_NATIONWIDE_SOURCE_URL || "").trim();
  return configured || DEFAULT_PROKURIME_NATIONWIDE_SOURCE_URL;
}

async function fetchCoverageSummary(pool, generatedAtUtc = new Date().toISOString()) {
  const prokurimeNationwideSourceUrl = resolveProkurimeNationwideSourceUrl();
  const query = `
    WITH categories AS (
      SELECT * FROM (VALUES
        ('Vendime'::text),
        ('Prokurime'::text),
        ('Konsultime publike'::text)
      ) AS c(category)
    ),
    registry AS (
      SELECT
        m.id AS municipality_id,
        m.name_key,
        m.name_sq,
        sr.id AS source_registry_id,
        sr.vendime_url,
        sr.prokurime_url,
        sr.konsultime_url,
        sr.verification_status,
        sr.vendime_checked,
        sr.prokurime_checked,
        sr.konsultime_checked,
        sr.last_error_type,
        sr.cooldown_until_utc,
        sr.last_checked_utc
      FROM municipalities m
      LEFT JOIN LATERAL (
        SELECT
          id,
          vendime_url,
          prokurime_url,
          konsultime_url,
          verification_status,
          vendime_checked,
          prokurime_checked,
          konsultime_checked,
          last_error_type,
          cooldown_until_utc,
          last_checked_utc
        FROM source_registry sr
        WHERE sr.municipality_id = m.id
          AND sr.is_primary = TRUE
        ORDER BY sr.updated_at DESC
        LIMIT 1
      ) sr ON TRUE
    )
    SELECT
      r.municipality_id,
      r.name_key,
      r.name_sq,
      c.category,
      r.source_registry_id,
      CASE
        WHEN c.category = 'Vendime' THEN r.vendime_url
        WHEN c.category = 'Prokurime' THEN $1::text
        WHEN c.category = 'Konsultime publike' THEN r.konsultime_url
        ELSE NULL
      END AS registry_url,
      CASE
        WHEN c.category = 'Vendime' THEN COALESCE(r.vendime_checked, FALSE)
        WHEN c.category = 'Prokurime' THEN COALESCE(r.prokurime_checked, FALSE)
        WHEN c.category = 'Konsultime publike' THEN COALESCE(r.konsultime_checked, FALSE)
        ELSE FALSE
      END AS checked_flag,
      CASE
        WHEN c.category = 'Prokurime' THEN TRUE
        WHEN c.category = 'Vendime' THEN (
          r.vendime_url IS NOT NULL
          AND btrim(COALESCE(r.vendime_url, '')) <> ''
        )
        WHEN c.category = 'Konsultime publike' THEN (
          r.konsultime_url IS NOT NULL
          AND btrim(COALESCE(r.konsultime_url, '')) <> ''
        )
        ELSE FALSE
      END AS registry_url_set,
      CASE
        WHEN c.category = 'Prokurime' THEN TRUE
        ELSE FALSE
      END AS is_nationwide_source,
      CASE
        WHEN c.category = 'Prokurime' THEN 'nationwide'::text
        ELSE 'municipality'::text
      END AS registry_url_origin,
      CASE
        WHEN c.category = 'Vendime' THEN COALESCE(r.vendime_checked, FALSE)
        WHEN c.category = 'Prokurime' THEN COALESCE(r.prokurime_checked, FALSE)
        WHEN c.category = 'Konsultime publike' THEN COALESCE(r.konsultime_checked, FALSE)
        ELSE FALSE
      END AS category_checked,
      r.verification_status,
      r.last_error_type,
      r.cooldown_until_utc,
      r.last_checked_utc,
      COALESCE(i.published_count, 0)::int AS published_count,
      COALESCE(i.draft_count, 0)::int AS draft_count,
      COALESCE(att_counts.published_attachment_count, 0)::int AS published_attachment_count,
      COALESCE(att_counts.draft_attachment_count, 0)::int AS draft_attachment_count,
      att_latest.latest_attachment_id,
      att_latest.latest_attachment_item_status,
      i.latest_published_date,
      i.latest_collected_at
    FROM registry r
    CROSS JOIN categories c
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (WHERE it.status = 'published') AS published_count,
        COUNT(*) FILTER (WHERE it.status = 'draft') AS draft_count,
        MAX(it.published_date) FILTER (WHERE it.status = 'published') AS latest_published_date,
        MAX(it.collected_at) AS latest_collected_at
      FROM items it
      WHERE it.municipality_id = r.municipality_id
        AND it.category = c.category
    ) i ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (WHERE it2.status = 'published') AS published_attachment_count,
        COUNT(*) FILTER (WHERE it2.status = 'draft') AS draft_attachment_count
      FROM attachments a2
      JOIN items it2 ON it2.id = a2.item_id
      WHERE it2.municipality_id = r.municipality_id
        AND it2.category = c.category
    ) att_counts ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        a3.id AS latest_attachment_id,
        CASE
          WHEN it3.status = 'draft' THEN 'draft'
          WHEN it3.status = 'published' THEN 'published'
          ELSE NULL
        END AS latest_attachment_item_status
      FROM attachments a3
      JOIN items it3 ON it3.id = a3.item_id
      WHERE it3.municipality_id = r.municipality_id
        AND it3.category = c.category
      ORDER BY a3.created_at DESC, a3.id DESC
      LIMIT 1
    ) att_latest ON TRUE
    ORDER BY r.name_key ASC, c.category ASC;
  `;

  const result = await pool.query(query, [prokurimeNationwideSourceUrl]);
  const items = result.rows;
  const municipalityCount = new Set(items.map((row) => String(row.municipality_id))).size;

  return {
    ok: true,
    generated_at_utc: generatedAtUtc,
    total_municipalities: municipalityCount,
    total_rows: items.length,
    categories: COVERAGE_CATEGORIES,
    items,
  };
}

module.exports = {
  COVERAGE_CATEGORIES,
  fetchCoverageSummary,
};

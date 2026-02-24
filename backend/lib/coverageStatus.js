"use strict";

const COVERAGE_CATEGORIES = ["Vendime", "Prokurime", "Konsultime publike"];

async function fetchCoverageSummary(pool, generatedAtUtc = new Date().toISOString()) {
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
        WHEN c.category = 'Prokurime' THEN r.prokurime_url
        WHEN c.category = 'Konsultime publike' THEN r.konsultime_url
        ELSE NULL
      END AS registry_url,
      (
        CASE
          WHEN c.category = 'Vendime' THEN r.vendime_url
          WHEN c.category = 'Prokurime' THEN r.prokurime_url
          WHEN c.category = 'Konsultime publike' THEN r.konsultime_url
          ELSE NULL
        END
      ) IS NOT NULL
      AND btrim(
        CASE
          WHEN c.category = 'Vendime' THEN COALESCE(r.vendime_url, '')
          WHEN c.category = 'Prokurime' THEN COALESCE(r.prokurime_url, '')
          WHEN c.category = 'Konsultime publike' THEN COALESCE(r.konsultime_url, '')
          ELSE ''
        END
      ) <> '' AS registry_url_set,
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
    ORDER BY r.name_key ASC, c.category ASC;
  `;

  const result = await pool.query(query);
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

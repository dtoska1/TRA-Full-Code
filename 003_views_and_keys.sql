BEGIN;

-- 1) Add name_key (needed by API)
ALTER TABLE municipalities
  ADD COLUMN IF NOT EXISTS name_key TEXT;

UPDATE municipalities
SET name_key = regexp_replace(translate(lower(name_sq), 'ëç', 'ec'), '[^a-z0-9]+', '', 'g')
WHERE name_key IS NULL;

ALTER TABLE municipalities
  ALTER COLUMN name_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_municipalities_name_key
ON municipalities (name_key);

-- 2) Public feed view (needed by /api/feed)
CREATE OR REPLACE VIEW v_public_feed AS
SELECT
  i.id,
  i.municipality_id,
  m.name_sq       AS municipality,
  m.name_key      AS municipality_key,
  i.category,
  i.title,
  i.summary,
  i.published_date,
  i.date_unknown,
  i.source_url,
  i.collected_at,
  i.ingestion_method,
  i.status,
  i.created_at,
  i.updated_at
FROM items i
JOIN municipalities m ON m.id = i.municipality_id
WHERE i.status = 'published';

COMMIT;

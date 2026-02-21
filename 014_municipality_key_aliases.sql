BEGIN;

CREATE EXTENSION IF NOT EXISTS unaccent;

-- Keep slugify available for manual key regeneration statements.
CREATE OR REPLACE FUNCTION slugify(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT trim(both '-' from regexp_replace(
    regexp_replace(
      lower(unaccent(coalesce(input, ''))),
      '[^a-z0-9]+', '-', 'g'
    ),
    '(^-+|-+$)', '', 'g'
  ));
$$;

CREATE TABLE IF NOT EXISTS municipality_key_aliases (
  alias_key TEXT PRIMARY KEY,
  municipality_id UUID NOT NULL REFERENCES municipalities(id) ON DELETE CASCADE,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_municipality_key_aliases_alias_key_format
    CHECK (alias_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT ck_municipality_key_aliases_alias_key_lower
    CHECK (alias_key = lower(alias_key))
);

CREATE INDEX IF NOT EXISTS ix_municipality_key_aliases_municipality_id
ON municipality_key_aliases (municipality_id);

-- Snapshot current keys as aliases so existing client URLs keep working.
INSERT INTO municipality_key_aliases (alias_key, municipality_id, note)
SELECT m.name_key, m.id, 'backfill_from_existing_name_key'
FROM municipalities m
WHERE m.name_key IS NOT NULL
  AND m.name_key <> ''
ON CONFLICT (alias_key) DO NOTHING;

COMMIT;

-- ------------------------------------------------------------------
-- Manual operation (run after fixing municipalities.name_sq text)
-- Regenerate clean municipality keys while preserving old keys as aliases.
-- ------------------------------------------------------------------
-- BEGIN;
-- WITH normalized AS (
--   SELECT
--     id,
--     name_key AS old_key,
--     slugify(name_sq) AS new_key
--   FROM municipalities
-- ),
-- changed AS (
--   SELECT id, old_key, new_key
--   FROM normalized
--   WHERE old_key IS DISTINCT FROM new_key
-- ),
-- preserved_aliases AS (
--   INSERT INTO municipality_key_aliases (alias_key, municipality_id, note)
--   SELECT c.old_key, c.id, 'legacy_key_before_regeneration'
--   FROM changed c
--   WHERE c.old_key IS NOT NULL AND c.old_key <> ''
--   ON CONFLICT (alias_key) DO NOTHING
--   RETURNING alias_key
-- )
-- UPDATE municipalities m
-- SET name_key = c.new_key
-- FROM changed c
-- WHERE m.id = c.id;
-- COMMIT;

BEGIN;

ALTER TABLE source_registry
  ADD COLUMN IF NOT EXISTS vendime_url_official TEXT,
  ADD COLUMN IF NOT EXISTS vendime_official_from_year INTEGER,
  ADD COLUMN IF NOT EXISTS vendime_official_to_year INTEGER,
  ADD COLUMN IF NOT EXISTS vendime_official_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS vendime_official_weight INTEGER NOT NULL DEFAULT 100;

UPDATE source_registry sr
SET
  vendime_url_official = 'https://tirana.al/kategoria-e-publikimit/vendime-te-keshillit-bashkiak-{year}-4290',
  vendime_official_from_year = 2026,
  vendime_official_enabled = TRUE,
  updated_at = now()
FROM municipalities m
WHERE m.id = sr.municipality_id
  AND sr.is_primary = TRUE
  AND lower(m.name_key) = 'tirane';

COMMIT;

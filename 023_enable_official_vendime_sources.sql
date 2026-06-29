BEGIN;

ALTER TABLE source_registry
  ADD COLUMN IF NOT EXISTS vendime_url_official TEXT,
  ADD COLUMN IF NOT EXISTS vendime_official_from_year INTEGER,
  ADD COLUMN IF NOT EXISTS vendime_official_to_year INTEGER,
  ADD COLUMN IF NOT EXISTS vendime_official_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS vendime_official_weight INTEGER NOT NULL DEFAULT 100;

UPDATE source_registry sr
SET
  vendime_url_official = 'https://tirana.al/kategoria-e-publikimit/vendime-keshilli-bashkiak-77',
  vendime_official_enabled = TRUE,
  vendime_official_from_year = NULL,
  vendime_official_to_year = NULL,
  vendime_official_weight = 100,
  updated_at = now()
FROM municipalities m
WHERE m.id = sr.municipality_id
  AND sr.is_primary = TRUE
  AND lower(m.name_key) = 'tirane';

UPDATE source_registry sr
SET
  vendime_url_official = 'https://bashkiashkoder.gov.al/vendimet-e-keshillit-bashkiak-2/',
  vendime_official_enabled = TRUE,
  vendime_official_from_year = NULL,
  vendime_official_to_year = NULL,
  vendime_official_weight = 100,
  updated_at = now()
FROM municipalities m
WHERE m.id = sr.municipality_id
  AND sr.is_primary = TRUE
  AND lower(m.name_key) = 'shkoder';

UPDATE source_registry sr
SET
  vendime_url_official = 'https://durres.gov.al/vendime-te-keshillit-bashkiak-2/',
  vendime_official_enabled = TRUE,
  vendime_official_from_year = NULL,
  vendime_official_to_year = NULL,
  vendime_official_weight = 100,
  updated_at = now()
FROM municipalities m
WHERE m.id = sr.municipality_id
  AND sr.is_primary = TRUE
  AND lower(m.name_key) = 'durres';

UPDATE source_registry sr
SET
  vendime_url_official = 'https://bashkiapogradec.gov.al/publikime-kategori/vendime-te-keshillit-2/',
  vendime_official_enabled = TRUE,
  vendime_official_from_year = NULL,
  vendime_official_to_year = NULL,
  vendime_official_weight = 100,
  updated_at = now()
FROM municipalities m
WHERE m.id = sr.municipality_id
  AND sr.is_primary = TRUE
  AND lower(m.name_key) = 'pogradec';

COMMIT;

-- Vlorë intentionally remains vendime.al-only: the official site does not expose
-- a usable Vendime feed.

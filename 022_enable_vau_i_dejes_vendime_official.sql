BEGIN;

UPDATE source_registry sr
SET
  vendime_url_official = 'https://vaudejes.gov.al/vendime/',
  vendime_official_enabled = TRUE,
  vendime_official_from_year = 2025,
  vendime_official_to_year = NULL,
  updated_at = now()
FROM municipalities m
WHERE m.id = sr.municipality_id
  AND sr.is_primary = TRUE
  AND lower(m.name_key) = 'vau-i-dejes';

COMMIT;

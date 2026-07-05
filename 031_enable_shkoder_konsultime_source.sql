BEGIN;

UPDATE source_registry sr
SET
  konsultime_url = COALESCE(
    NULLIF(btrim(sr.konsultime_url), ''),
    'https://bashkiashkoder.gov.al/keshillim-me-publikun/'
  ),
  konsultime_confidence = 0.95,
  konsultime_checked = TRUE,
  updated_at = now()
FROM municipalities m
WHERE m.id = sr.municipality_id
  AND sr.is_primary = TRUE
  AND lower(m.name_key) = 'shkoder';

COMMIT;

-- Shkodër konsultime source verified 2026-07. The scraper entry point remains the
-- official same-host consultation listing. Off-host electronic registers are
-- intentionally out of scope for archival.

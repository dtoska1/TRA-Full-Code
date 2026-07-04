BEGIN;

UPDATE source_registry sr
SET
  konsultime_url = COALESCE(
    NULLIF(btrim(sr.konsultime_url), ''),
    'https://durres.gov.al/konsultimet-publike/'
  ),
  konsultime_confidence = 0.95,
  konsultime_checked = TRUE,
  updated_at = now()
FROM municipalities m
WHERE m.id = sr.municipality_id
  AND sr.is_primary = TRUE
  AND lower(m.name_key) = 'durres';

COMMIT;


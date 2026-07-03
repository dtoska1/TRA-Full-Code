BEGIN;

UPDATE source_registry sr
SET
  konsultime_url = 'https://bashkiapogradec.gov.al/publikime-kategori/konsultim-publik-10/',
  konsultime_confidence = 0.95,
  konsultime_checked = TRUE,
  updated_at = now()
FROM municipalities m
WHERE m.id = sr.municipality_id
  AND sr.is_primary = TRUE
  AND lower(m.name_key) = 'pogradec';

COMMIT;

-- Pogradec's off-site Google Sheets registers remain intentionally out of scope.

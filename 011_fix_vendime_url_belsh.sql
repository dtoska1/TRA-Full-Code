BEGIN;

UPDATE source_registry sr
SET vendime_url = 'http://www.vendime.al/belsh/',
    verification_status = 'CHECKED'
FROM municipalities m
WHERE sr.municipality_id = m.id
  AND sr.is_primary = TRUE
  AND m.name_key = 'belsh';

COMMIT;

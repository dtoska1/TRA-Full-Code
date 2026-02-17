BEGIN;

UPDATE source_registry sr
SET vendime_url = 'https://www.vendime.al/fier/',
    verification_status = 'CHECKED',
    feasibility = COALESCE(NULLIF(sr.feasibility,''), 'TBD')
FROM municipalities m
WHERE sr.municipality_id = m.id
  AND sr.is_primary = TRUE
  AND m.name_key = 'fier';

COMMIT;

-- Verify (optional)
-- SELECT m.name_key, sr.vendime_url
-- FROM source_registry sr JOIN municipalities m ON m.id=sr.municipality_id
-- WHERE sr.is_primary=TRUE AND m.name_key='fier';

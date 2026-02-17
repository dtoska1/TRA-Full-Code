BEGIN;

-- Update only if vendime_url is missing OR equals base_url (so we can safely “upgrade”)
WITH m AS (
  SELECT id, name_key
  FROM municipalities
  WHERE name_key IN ('durres','vlore','shkoder','elbasan','fier')
)
UPDATE source_registry sr
SET vendime_url = CASE m.name_key
  WHEN 'durres'  THEN 'https://durres.gov.al/vendime-te-keshillit-bashkiak-2/'
  WHEN 'vlore'   THEN 'https://vlora.gov.al/transparenca/vendimet-e-keshillit/'
  WHEN 'shkoder' THEN 'https://bashkiashkoder.gov.al/vendimet-e-keshillit-bashkiak-2/'
  WHEN 'elbasan' THEN 'https://elbasani.gov.al/keshilli/vendimet-e-keshillit/'
  WHEN 'fier'    THEN 'https://bashkiafier.gov.al/vendimet/'
  ELSE sr.vendime_url
END,
verification_status = COALESCE(sr.verification_status, 'UNCHECKED')
FROM m
WHERE sr.municipality_id = m.id
  AND sr.is_primary = TRUE
  AND (
    sr.vendime_url IS NULL OR length(btrim(sr.vendime_url)) = 0
    OR sr.vendime_url = sr.base_url
  );

COMMIT;

-- Verify (optional)
-- SELECT m.name_key, sr.vendime_url
-- FROM source_registry sr JOIN municipalities m ON m.id=sr.municipality_id
-- WHERE sr.is_primary=TRUE AND m.name_key IN ('durres','vlore','shkoder','elbasan','fier');

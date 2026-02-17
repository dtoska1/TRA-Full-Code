BEGIN;

-- Fill vendime_url conservatively from base_url where missing.
-- This is NOT a fallback in code; it makes registry explicit.
UPDATE source_registry sr
SET vendime_url = sr.base_url
WHERE sr.is_primary = TRUE
  AND (sr.vendime_url IS NULL OR length(btrim(sr.vendime_url)) = 0)
  AND sr.base_url IS NOT NULL
  AND length(btrim(sr.base_url)) > 0;

COMMIT;

-- Sanity (optional)
-- SELECT count(*) AS missing_vendime_url
-- FROM source_registry
-- WHERE is_primary = TRUE AND (vendime_url IS NULL OR length(btrim(vendime_url)) = 0);

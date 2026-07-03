-- 024_enable_konsultime_sources.sql
-- Enables official Konsultime ("Konsultime publike") sources for the 5 priority municipalities.
-- Modeled on 023_enable_official_vendime_sources.sql. Transaction-wrapped (atomic).
--
-- IMPORTANT: Run only on a STABLE connection. Verify with the SELECT at the bottom after COMMIT.
-- URLs verified via live recon on 2026-06-29/30:
--   shkoder : bashkiashkoder.gov.al/keshillim-me-publikun/        (listing cards)
--   pogradec: bashkiapogradec.gov.al/publikime-kategori/konsultim-publik-10/
--   durres  : durres.gov.al/konsultimet-publike/                  (detail-posts only)
--   vlore   : vlora.gov.al/category/degjesat-publike/             (+ register, handled in scraper)
--   tirane  : tirana.al/kategori/konsultimi-publik                (+ register + hearing-info, in scraper)
--
-- NOTE: column name assumed `konsultime_url` (confirmed present in source_registry, was empty).
-- The dispatch (scrapeKonsultimeTarget) routes by municipality_key + host, so the URL here is the
-- listing entry point; multi-source scrapers (vlore, tirane) fetch their extra sources internally.

BEGIN;

UPDATE source_registry sr
SET konsultime_url = 'https://bashkiashkoder.gov.al/keshillim-me-publikun/',
    updated_at = now()
FROM municipalities m
WHERE m.id = sr.municipality_id
  AND sr.is_primary = TRUE
  AND lower(m.name_key) = 'shkoder';

UPDATE source_registry sr
SET konsultime_url = 'https://bashkiapogradec.gov.al/publikime-kategori/konsultim-publik-10/',
    updated_at = now()
FROM municipalities m
WHERE m.id = sr.municipality_id
  AND sr.is_primary = TRUE
  AND lower(m.name_key) = 'pogradec';

UPDATE source_registry sr
SET konsultime_url = 'https://durres.gov.al/konsultimet-publike/',
    updated_at = now()
FROM municipalities m
WHERE m.id = sr.municipality_id
  AND sr.is_primary = TRUE
  AND lower(m.name_key) = 'durres';

UPDATE source_registry sr
SET konsultime_url = 'https://vlora.gov.al/category/degjesat-publike/',
    updated_at = now()
FROM municipalities m
WHERE m.id = sr.municipality_id
  AND sr.is_primary = TRUE
  AND lower(m.name_key) = 'vlore';

UPDATE source_registry sr
SET konsultime_url = 'https://tirana.al/kategori/konsultimi-publik',
    updated_at = now()
FROM municipalities m
WHERE m.id = sr.municipality_id
  AND sr.is_primary = TRUE
  AND lower(m.name_key) = 'tirane';

COMMIT;

-- VERIFY after commit (should return EXACTLY these 5 rows, no others):
-- SELECT m.name_key, sr.konsultime_url
-- FROM source_registry sr JOIN municipalities m ON m.id = sr.municipality_id
-- WHERE sr.konsultime_url IS NOT NULL AND sr.konsultime_url <> ''
-- ORDER BY m.name_key;

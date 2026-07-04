BEGIN;

UPDATE source_registry sr
SET
  konsultime_url = COALESCE(
    NULLIF(btrim(sr.konsultime_url), ''),
    'https://vlora.gov.al/category/degjesat-publike/'
  ),
  konsultime_confidence = 0.95,
  konsultime_checked = TRUE,
  updated_at = now()
FROM municipalities m
WHERE m.id = sr.municipality_id
  AND sr.is_primary = TRUE
  AND lower(m.name_key) = 'vlore';

COMMIT;

-- Vlorë konsultime source verified 2026-07 (register + category + Ind1 page + Ind5 register column
-- + sample draft act all checked live). Score honestly remains 20: Ind2=10 (register), Ind3=10
-- (draft acts), Ind1=0 (no annual consultation plan — participation page verified non-qualifying),
-- Ind4=0 (vote dates blank in draft acts), Ind5=0 (register's own "Raporti për Rezultatet" column
-- shows "Jo"/No for most acts). This migration only marks the source checked; it does not change scores.
-- Vlorë's off-site/tabular register nuances and the is_unofficial_proxy Vendime exception are unaffected.

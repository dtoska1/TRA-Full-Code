BEGIN;

UPDATE source_registry sr
SET
  konsultime_url = COALESCE(
    NULLIF(btrim(sr.konsultime_url), ''),
    'https://tirana.al/kategori/konsultimi-publik'
  ),
  konsultime_confidence = 0.95,
  konsultime_checked = TRUE,
  updated_at = now()
FROM municipalities m
WHERE m.id = sr.municipality_id
  AND sr.is_primary = TRUE
  AND lower(m.name_key) = 'tirane';

COMMIT;

-- Tiranë konsultime source verified 2026-07 (register + activities-calendar page + 2024 annual
-- transparency report + a sample consultation page all checked live). Score honestly remains 20:
-- Ind2=10 (electronic register), Ind3=10 (draft acts / projektvendim), Ind1=0 ("Kalendari i
-- aktiviteteve" is an activities calendar, not an annual consultation calendar), Ind4=0 (vote
-- dates not determinable), Ind5=0 (the 2024 annual report logs the 4 consultations + comments
-- received + meetings held, but publishes NO institutional responses to input; the individual
-- consultation page likewise has notice + draft act but no response/summary document — verified
-- in both places). This migration only marks the source checked; it does not change scores.

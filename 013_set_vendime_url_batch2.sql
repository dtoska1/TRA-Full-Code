BEGIN;

-- Kamëz: point to Këshilli -> Vendimet
UPDATE source_registry sr
SET vendime_url = 'https://kamza.gov.al/keshilli/vendimet/',
    verification_status = 'CHECKED'
FROM municipalities m
WHERE sr.municipality_id = m.id
  AND sr.is_primary = TRUE
  AND m.name_key = 'kamez';

-- Kukës: use official /vendimet/ page (not vendime.al)
UPDATE source_registry sr
SET vendime_url = 'https://kukesi.gov.al/vendimet/',
    verification_status = 'CHECKED'
FROM municipalities m
WHERE sr.municipality_id = m.id
  AND sr.is_primary = TRUE
  AND m.name_key = 'kukes';

-- Mat: point to category "Vendime te Keshillit"
UPDATE source_registry sr
SET vendime_url = 'https://bashkiamat.gov.al/category/vendime/vendime-te-keshillit/',
    verification_status = 'CHECKED'
FROM municipalities m
WHERE sr.municipality_id = m.id
  AND sr.is_primary = TRUE
  AND m.name_key = 'mat';

COMMIT;

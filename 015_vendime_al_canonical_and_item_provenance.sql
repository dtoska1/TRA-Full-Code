BEGIN;

-- Minimal provenance fields for ingestion/debugging.
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS source_origin TEXT,
  ADD COLUMN IF NOT EXISTS source_page_url TEXT;

-- Canonical Vendime source: vendime.al for all primary municipality rows.
-- Default slug comes from municipalities.name_key.
-- Overrides handle known vendime.al slug differences.
WITH overrides(name_key, vendime_url) AS (
  VALUES
    ('bulqize', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-bulqize/'),
    ('delvine', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-delvine/'),
    ('diber', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-diber/'),
    ('dimal', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-ura-vajgurore-2/'),
    ('dropull', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-dropull/'),
    ('elbasan', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-elbasan/'),
    ('finiq', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-finiq/'),
    ('fushe-arrez', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-fushe-arres/'),
    ('has', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-has/'),
    ('himare', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-himare/'),
    ('kamez', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-kamez/'),
    ('kavaje', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-kavaje/'),
    ('kelcyre', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-kelcyre/'),
    ('klos', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-klos/'),
    ('kolonje', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-kolonje/'),
    ('konispol', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-konispol/'),
    ('kruje', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-kruje/'),
    ('kucove', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-kucove/'),
    ('kukes', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-kukes/'),
    ('kurbin', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-kurbin/'),
    ('librazhd', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-librazhd/'),
    ('malesi-e-madhe', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-malesi-e-madhe/'),
    ('maliq', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-maliq/'),
    ('mallakaster', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-mallakaster/'),
    ('mat', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-mat/'),
    ('memaliaj', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-memaliaj/'),
    ('mirdite', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-mirdite/'),
    ('patos', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-patos/'),
    ('peqin', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-peqin/'),
    ('pogradec', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-pogradec/'),
    ('polican', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-polican/'),
    ('puke', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-puke/'),
    ('pustec', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-pustec/'),
    ('roskovec', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-roskovec/'),
    ('rrogozhine', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-rrogozhine/'),
    ('sarande', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-sarande/'),
    ('shijak', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-shijak/'),
    ('tepelene', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-tepelene/'),
    ('tropoje', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-tropoje/'),
    ('vau-i-dejes', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-vau-i-dejes/'),
    ('vore', 'https://www.vendime.al/vendimet-e-keshillit-bashkiak-vore/')
),
resolved AS (
  SELECT
    sr.id AS source_registry_id,
    COALESCE(
      o.vendime_url,
      format('https://www.vendime.al/%s/', m.name_key)
    ) AS resolved_vendime_url
  FROM source_registry sr
  JOIN municipalities m ON m.id = sr.municipality_id
  LEFT JOIN overrides o ON o.name_key = m.name_key
  WHERE sr.is_primary = TRUE
)
UPDATE source_registry sr
SET
  vendime_url = resolved.resolved_vendime_url,
  updated_at = now()
FROM resolved
WHERE sr.id = resolved.source_registry_id
  AND sr.vendime_url IS DISTINCT FROM resolved.resolved_vendime_url;

DO $$
DECLARE
  primary_count INTEGER;
  filled_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO primary_count
  FROM source_registry
  WHERE is_primary = TRUE;

  IF primary_count <> 61 THEN
    RAISE EXCEPTION 'Expected 61 primary source_registry rows, found %', primary_count;
  END IF;

  SELECT COUNT(*) INTO filled_count
  FROM source_registry
  WHERE is_primary = TRUE
    AND vendime_url IS NOT NULL
    AND btrim(vendime_url) <> '';

  IF filled_count <> 61 THEN
    RAISE EXCEPTION 'Expected 61 primary rows with non-empty vendime_url, found %', filled_count;
  END IF;
END $$;

COMMIT;


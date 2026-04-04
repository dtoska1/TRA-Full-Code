BEGIN;

INSERT INTO municipality_key_aliases (alias_key, municipality_id, note)
SELECT
  'vau-dejes',
  m.id,
  'prokurime_app_authority_variant'
FROM municipalities m
WHERE lower(m.name_key) = 'vau-i-dejes'
ON CONFLICT (alias_key) DO NOTHING;

COMMIT;

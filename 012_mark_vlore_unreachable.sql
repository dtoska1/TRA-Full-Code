BEGIN;

UPDATE source_registry sr
SET
  feasibility = 'B',
  verification_status = 'CHECKED',
  last_error_type = 'CONNECT_TIMEOUT',
  cooldown_until_utc = now() + interval '12 hours',
  crawl_notes = concat_ws(
    E'\n',
    nullif(sr.crawl_notes, ''),
    '[2026-02-17] CONNECT_TIMEOUT from local tests; site unreachable via curl -I'
  ),
  updated_at = now()
FROM municipalities m
WHERE sr.municipality_id = m.id
  AND sr.is_primary = TRUE
  AND m.name_key = 'vlore';

COMMIT;

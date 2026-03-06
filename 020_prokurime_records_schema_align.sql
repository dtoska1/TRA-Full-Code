BEGIN;

ALTER TABLE prokurime_records
  ADD COLUMN IF NOT EXISTS cpv_group TEXT,
  ADD COLUMN IF NOT EXISTS procedure_type TEXT,
  ADD COLUMN IF NOT EXISTS contracting_authority TEXT,
  ADD COLUMN IF NOT EXISTS raw_row JSONB,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

UPDATE prokurime_records
SET created_at = COALESCE(created_at, extracted_at, now())
WHERE created_at IS NULL;

ALTER TABLE prokurime_records
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN created_at SET NOT NULL;

COMMIT;

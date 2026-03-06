BEGIN;

CREATE TABLE IF NOT EXISTS prokurime_records (
  item_id UUID,
  municipality_id UUID,
  amount_value NUMERIC(18,2),
  amount_currency TEXT,
  supplier_name TEXT,
  cpv_code TEXT,
  procedure_ref TEXT,
  source_export_url TEXT,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE prokurime_records
  ADD COLUMN IF NOT EXISTS item_id UUID,
  ADD COLUMN IF NOT EXISTS municipality_id UUID,
  ADD COLUMN IF NOT EXISTS amount_value NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS amount_currency TEXT,
  ADD COLUMN IF NOT EXISTS supplier_name TEXT,
  ADD COLUMN IF NOT EXISTS cpv_code TEXT,
  ADD COLUMN IF NOT EXISTS procedure_ref TEXT,
  ADD COLUMN IF NOT EXISTS source_export_url TEXT,
  ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE prokurime_records
SET
  extracted_at = COALESCE(extracted_at, now()),
  updated_at = COALESCE(updated_at, now());

ALTER TABLE prokurime_records
  ALTER COLUMN extracted_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN extracted_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_prokurime_records_item_id
  ON prokurime_records (item_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conname = 'fk_prokurime_records_item_id'
      AND c.conrelid = 'prokurime_records'::regclass
  ) THEN
    ALTER TABLE prokurime_records
      ADD CONSTRAINT fk_prokurime_records_item_id
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE NOT VALID;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS ix_prokurime_records_procedure_ref
  ON prokurime_records (procedure_ref);

CREATE INDEX IF NOT EXISTS ix_prokurime_records_cpv_code
  ON prokurime_records (cpv_code);

COMMIT;

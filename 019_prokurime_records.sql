BEGIN;

CREATE TABLE IF NOT EXISTS prokurime_records (
  item_id uuid PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  municipality_id uuid NOT NULL REFERENCES municipalities(id) ON DELETE CASCADE,

  amount_value numeric NULL,
  amount_currency text NULL,

  supplier_name text NULL,
  cpv_code text NULL,
  procedure_ref text NULL,

  raw_row jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prok_records_muni ON prokurime_records(municipality_id);
CREATE INDEX IF NOT EXISTS idx_prok_records_amount ON prokurime_records(amount_value);

COMMIT;
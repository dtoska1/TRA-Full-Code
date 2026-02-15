BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE municipalities  ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE users           ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE source_registry ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE items           ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE attachments     ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE item_revisions  ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE publish_events  ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE security_events ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE items DROP CONSTRAINT IF EXISTS ck_items_date_unknown_published_date;
ALTER TABLE items DROP CONSTRAINT IF EXISTS ck_items_date_unknown_published_date_published_only;

ALTER TABLE items
ADD CONSTRAINT ck_items_date_unknown_published_date_published_only
CHECK (
  status <> 'published'
  OR (
    (date_unknown = TRUE  AND published_date IS NULL)
    OR
    (date_unknown = FALSE AND published_date IS NOT NULL)
  )
);

DROP INDEX IF EXISTS ux_items_muni_cat_dedup;
DROP INDEX IF EXISTS ux_items_muni_cat_dedup_when_no_source_url;

CREATE UNIQUE INDEX IF NOT EXISTS ux_items_muni_cat_dedup_when_no_source_url
  ON items (municipality_id, category, dedup_key)
  WHERE source_url IS NULL;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to tables that have updated_at
DROP TRIGGER IF EXISTS trg_items_set_updated_at ON items;
CREATE TRIGGER trg_items_set_updated_at
BEFORE UPDATE ON items
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_source_registry_set_updated_at ON source_registry;
CREATE TRIGGER trg_source_registry_set_updated_at
BEFORE UPDATE ON source_registry
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;

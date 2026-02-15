BEGIN;

-- Optional but useful for real names (ë/ç etc.)
CREATE EXTENSION IF NOT EXISTS unaccent;

-- slugify: "Bashkia Tiranë" -> "bashkia-tirane"
CREATE OR REPLACE FUNCTION slugify(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT trim(both '-' from regexp_replace(
    regexp_replace(
      lower(unaccent(coalesce(input, ''))),
      '[^a-z0-9]+', '-', 'g'
    ),
    '(^-+|-+$)', '', 'g'
  ));
$$;

-- Fill name_key automatically when missing
CREATE OR REPLACE FUNCTION municipalities_set_name_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.name_key IS NULL OR NEW.name_key = '' THEN
    NEW.name_key := slugify(NEW.name_sq);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_municipalities_set_name_key ON municipalities;

CREATE TRIGGER trg_municipalities_set_name_key
BEFORE INSERT OR UPDATE OF name_sq, name_key ON municipalities
FOR EACH ROW
EXECUTE FUNCTION municipalities_set_name_key();

-- Backfill just in case (safe if empty)
UPDATE municipalities
SET name_key = slugify(name_sq)
WHERE name_key IS NULL OR name_key = '';

COMMIT;

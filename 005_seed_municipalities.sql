-- 005_seed_municipalities.sql
-- Seeds Albania's 61 municipalities (bashki) into public.municipalities.
-- Safe to re-run (idempotent). Updates county if municipality already exists.
-- Requires 002_hardening.sql (id defaults) and 003_views_and_keys.sql (name_key column).
-- NOTE: This script expects a clean municipalities table (exactly 61 rows).
--       If you previously ran schema_verification_check.sql, it creates test municipalities;
--       delete those rows or rebuild the DB before re-running this seed.


\set ON_ERROR_STOP on
\encoding UTF8

BEGIN;

INSERT INTO municipalities (name_sq, county)
VALUES
  ('Belsh','Elbasan'),
  ('Berat','Berat'),
  ('Bulqizë','Dibër'),
  ('Cërrik','Elbasan'),
  ('Delvinë','Vlorë'),
  ('Devoll','Korçë'),
  ('Dibër','Dibër'),
  ('Dimal','Berat'),
  ('Divjakë','Fier'),
  ('Dropull','Gjirokastër'),
  ('Durrës','Durrës'),
  ('Elbasan','Elbasan'),
  ('Fier','Fier'),
  ('Finiq','Vlorë'),
  ('Fushë-Arrëz','Shkodër'),
  ('Gjirokastër','Gjirokastër'),
  ('Gramsh','Elbasan'),
  ('Has','Kukës'),
  ('Himarë','Vlorë'),
  ('Kamëz','Tiranë'),
  ('Kavajë','Tiranë'),
  ('Këlcyrë','Gjirokastër'),
  ('Klos','Dibër'),
  ('Kolonjë','Korçë'),
  ('Konispol','Vlorë'),
  ('Korçë','Korçë'),
  ('Krujë','Durrës'),
  ('Kukës','Kukës'),
  ('Kuçovë','Berat'),
  ('Kurbin','Lezhë'),
  ('Lezhë','Lezhë'),
  ('Libohovë','Gjirokastër'),
  ('Librazhd','Elbasan'),
  ('Lushnjë','Fier'),
  ('Maliq','Korçë'),
  ('Mallakastër','Fier'),
  ('Malësi e Madhe','Shkodër'),
  ('Mat','Dibër'),
  ('Memaliaj','Gjirokastër'),
  ('Mirditë','Lezhë'),
  ('Patos','Fier'),
  ('Peqin','Elbasan'),
  ('Pogradec','Korçë'),
  ('Poliçan','Berat'),
  ('Përmet','Gjirokastër'),
  ('Prrenjas','Elbasan'),
  ('Pukë','Shkodër'),
  ('Pustec','Korçë'),
  ('Roskovec','Fier'),
  ('Rrogozhinë','Tiranë'),
  ('Sarandë','Vlorë'),
  ('Selenicë','Vlorë'),
  ('Shijak','Durrës'),
  ('Shkodër','Shkodër'),
  ('Skrapar','Berat'),
  ('Tepelenë','Gjirokastër'),
  ('Tiranë','Tiranë'),
  ('Tropojë','Kukës'),
  ('Vau i Dejës','Shkodër'),
  ('Vlorë','Vlorë'),
  ('Vorë','Tiranë')
ON CONFLICT (name_sq) DO UPDATE
  SET county = EXCLUDED.county;

DO $$
DECLARE
  missing_list text;
  extra_list   text;
  c            int;
BEGIN
  -- 1) Ensure all expected municipalities exist
  WITH expected(name_sq) AS (
    VALUES
    ('Belsh'),
    ('Berat'),
    ('Bulqizë'),
    ('Cërrik'),
    ('Delvinë'),
    ('Devoll'),
    ('Dibër'),
    ('Dimal'),
    ('Divjakë'),
    ('Dropull'),
    ('Durrës'),
    ('Elbasan'),
    ('Fier'),
    ('Finiq'),
    ('Fushë-Arrëz'),
    ('Gjirokastër'),
    ('Gramsh'),
    ('Has'),
    ('Himarë'),
    ('Kamëz'),
    ('Kavajë'),
    ('Këlcyrë'),
    ('Klos'),
    ('Kolonjë'),
    ('Konispol'),
    ('Korçë'),
    ('Krujë'),
    ('Kukës'),
    ('Kuçovë'),
    ('Kurbin'),
    ('Lezhë'),
    ('Libohovë'),
    ('Librazhd'),
    ('Lushnjë'),
    ('Maliq'),
    ('Mallakastër'),
    ('Malësi e Madhe'),
    ('Mat'),
    ('Memaliaj'),
    ('Mirditë'),
    ('Patos'),
    ('Peqin'),
    ('Pogradec'),
    ('Poliçan'),
    ('Përmet'),
    ('Prrenjas'),
    ('Pukë'),
    ('Pustec'),
    ('Roskovec'),
    ('Rrogozhinë'),
    ('Sarandë'),
    ('Selenicë'),
    ('Shijak'),
    ('Shkodër'),
    ('Skrapar'),
    ('Tepelenë'),
    ('Tiranë'),
    ('Tropojë'),
    ('Vau i Dejës'),
    ('Vlorë'),
    ('Vorë')
  )
  SELECT string_agg(e.name_sq, ', ' ORDER BY e.name_sq)
  INTO missing_list
  FROM expected e
  LEFT JOIN municipalities m ON m.name_sq = e.name_sq
  WHERE m.id IS NULL;

  IF missing_list IS NOT NULL THEN
    RAISE EXCEPTION 'Missing municipalities: %', missing_list;
  END IF;

  -- 2) Ensure there are no unexpected municipalities in the table
  WITH expected(name_sq) AS (
    VALUES
    ('Belsh'),
    ('Berat'),
    ('Bulqizë'),
    ('Cërrik'),
    ('Delvinë'),
    ('Devoll'),
    ('Dibër'),
    ('Dimal'),
    ('Divjakë'),
    ('Dropull'),
    ('Durrës'),
    ('Elbasan'),
    ('Fier'),
    ('Finiq'),
    ('Fushë-Arrëz'),
    ('Gjirokastër'),
    ('Gramsh'),
    ('Has'),
    ('Himarë'),
    ('Kamëz'),
    ('Kavajë'),
    ('Këlcyrë'),
    ('Klos'),
    ('Kolonjë'),
    ('Konispol'),
    ('Korçë'),
    ('Krujë'),
    ('Kukës'),
    ('Kuçovë'),
    ('Kurbin'),
    ('Lezhë'),
    ('Libohovë'),
    ('Librazhd'),
    ('Lushnjë'),
    ('Maliq'),
    ('Mallakastër'),
    ('Malësi e Madhe'),
    ('Mat'),
    ('Memaliaj'),
    ('Mirditë'),
    ('Patos'),
    ('Peqin'),
    ('Pogradec'),
    ('Poliçan'),
    ('Përmet'),
    ('Prrenjas'),
    ('Pukë'),
    ('Pustec'),
    ('Roskovec'),
    ('Rrogozhinë'),
    ('Sarandë'),
    ('Selenicë'),
    ('Shijak'),
    ('Shkodër'),
    ('Skrapar'),
    ('Tepelenë'),
    ('Tiranë'),
    ('Tropojë'),
    ('Vau i Dejës'),
    ('Vlorë'),
    ('Vorë')
  )
  SELECT string_agg(m.name_sq, ', ' ORDER BY m.name_sq)
  INTO extra_list
  FROM municipalities m
  LEFT JOIN expected e ON e.name_sq = m.name_sq
  WHERE e.name_sq IS NULL;

  IF extra_list IS NOT NULL THEN
    RAISE EXCEPTION 'Extra municipalities present (expected exactly 61 rows): %', extra_list;
  END IF;

  -- 3) Count must be exactly 61
  SELECT count(*) INTO c FROM municipalities;
  IF c <> 61 THEN
    RAISE EXCEPTION 'Expected 61 municipalities, got %', c;
  END IF;
END $$;

COMMIT;
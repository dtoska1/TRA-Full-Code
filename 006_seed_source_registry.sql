-- 006_seed_source_registry.sql
-- Seeds exactly one PRIMARY source_registry row per municipality (61 total).
-- Idempotent / re-runnable: uses WHERE NOT EXISTS against the partial-unique primary rule.

\set ON_ERROR_STOP on
\encoding UTF8

BEGIN;

WITH seed(name_sq, base_url, crawl_notes, vendime_url) AS (
VALUES
  ('Berat', 'https://bashkiaberat.gov.al/', '', NULL),
  ('Kuçovë', 'https://bashkiakucove.gov.al/', '', NULL),
  ('Poliçan', 'https://www.polican.gov.al/', '', NULL),
  ('Skrapar', 'https://bashkiaskrapar.gov.al/', '', NULL),
  ('Dimal', 'https://bashkiadimal.gov.al/', 'Renamed from Ura Vajgurore in 2021', NULL),
  ('Bulqizë', 'https://bulqiza.gov.al/', '', NULL),
  ('Dibër', 'https://dibra.gov.al/', 'Website Down! CORRECT DOMAIN', NULL),
  ('Klos', 'https://bashkiaklos.gov.al/', '', NULL),
  ('Mat', 'https://bashkiamat.gov.al/', '', NULL),
  ('Durrës', 'https://durres.gov.al/', 'Major port city - Priority', NULL),
  ('Krujë', 'https://kruja.gov.al/', '', NULL),
  ('Shijak', 'https://shijak.gov.al/', '', NULL),
  ('Belsh', 'https://bashkiabelsh.al/', 'Uses .al (not .gov.al)', NULL),
  ('Cërrik', 'https://bashkiacerrik.gov.al/', '', NULL),
  ('Elbasan', 'https://elbasani.gov.al/', 'Major city - Priority', NULL),
  ('Gramsh', 'https://bashkiagramsh.gov.al/', '', NULL),
  ('Librazhd', 'https://bashkialibrazhd.gov.al/', '', NULL),
  ('Peqin', 'https://peqini.gov.al/', 'Uses "peqini" not "bashkiapeqin"', NULL),
  ('Prrenjas', 'https://bashkiaprrenjas.gov.al/', '', NULL),
  ('Divjakë', 'https://bashkiadivjake.gov.al/', '', NULL),
  ('Fier', 'https://bashkiafier.gov.al/', 'Unsafe Error, Not Secure, Servers down!', NULL),
  ('Lushnjë', 'https://bashkialushnje.gov.al/', '', NULL),
  ('Mallakastër', 'https://bashkiamallakaster.gov.al/', '', NULL),
  ('Patos', 'https://bashkiapatos.gov.al/', '', NULL),
  ('Roskovec', 'https://bashkiaroskovec.gov.al/', '', NULL),
  ('Dropull', 'https://bashkiadropull.gov.al/', '', NULL),
  ('Gjirokastër', 'https://bashkiagjirokaster.gov.al/', 'UNESCO site', NULL),
  ('Këlcyrë', 'https://bashkiakelcyre.gov.al/', '', NULL),
  ('Libohovë', 'https://bashkialibohove.gov.al/', '', NULL),
  ('Memaliaj', 'https://memaliaj.gov.al/', '', NULL),
  ('Përmet', 'https://bashkiapermet.gov.al/', '', NULL),
  ('Tepelenë', 'https://tepelena.gov.al/', '', NULL),
  ('Devoll', 'https://bashkiadevoll.gov.al/', '', NULL),
  ('Kolonjë', 'https://kolonja.gov.al/', '', NULL),
  ('Korçë', 'https://bashkiakorce.gov.al/', 'Major city - Priority', NULL),
  ('Maliq', 'https://bashkiamaliq.gov.al/', '', NULL),
  ('Pogradec', 'https://bashkiapogradec.gov.al/', 'Tourist area', NULL),
  ('Pustec', 'https://bashkiapustec.gov.al/', '', NULL),
  ('Has', 'https://bashkiahas.gov.al/', '', NULL),
  ('Kukës', 'https://kukesi.gov.al/', '', NULL),
  ('Tropojë', 'https://tropoje.gov.al/', '', NULL),
  ('Kurbin', 'https://bashkiakurbin.gov.al/', '', NULL),
  ('Lezhë', 'https://lezha.gov.al/', '', NULL),
  ('Mirditë', 'https://bashkiamirdite.gov.al/', 'Unsafe Error, Not Secure, Servers down!', NULL),
  ('Fushë-Arrëz', 'https://bashkiafushearrez.gov.al/', 'Standard pattern', NULL),
  ('Malësi e Madhe', 'https://bashkiamalesiemadhe.gov.al/', 'Standard pattern', NULL),
  ('Pukë', 'https://bashkiapuke.gov.al/', 'Standard pattern', NULL),
  ('Shkodër', 'https://bashkiashkoder.gov.al/', 'Major city', NULL),
  ('Vau i Dejës', 'https://vaudejes.gov.al/', 'Standard pattern - needs verification', NULL),
  ('Kamëz', 'https://kamza.gov.al/', 'Uses "kamza" not "kamez"', NULL),
  ('Kavajë', 'https://kavajajone.al/', 'Uses kavajajone.al (special domain)', NULL),
  ('Rrogozhinë', 'https://bashkiarrogozhine.gov.al/', 'Standard pattern', NULL),
  ('Tiranë', 'https://tirana.al/', 'CAPITAL - TOP PRIORITY - Uses tirana.al', 'https://tirana.al/kategoria-e-publikimit/vendime-te-keshillit-bashkiak-{year}-4290'),
  ('Vorë', 'https://bashkiavore.gov.al/', 'Standard pattern', NULL),
  ('Delvinë', 'https://bashkiadelvine.gov.al/', 'Standard pattern', NULL),
  ('Finiq', 'https://bfiniq.gov.al/', 'Standard pattern', NULL),
  ('Himarë', 'https://himara.gov.al/', 'Coastal tourist area', NULL),
  ('Konispol', 'https://bashkiakonispol.gov.al/', '', NULL),
  ('Sarandë', 'https://bashkiasarande.gov.al/', 'Major tourist city', NULL),
  ('Selenicë', 'https://selenica.gov.al/', 'Uses selenica not bashkiaselenice.', NULL),
  ('Vlorë', 'https://vlora.gov.al/', 'Major port city - Priority', NULL)
),
muni AS (
  SELECT m.id AS municipality_id, s.*
  FROM seed s
  JOIN municipalities m ON m.name_sq = s.name_sq
)
INSERT INTO source_registry (
  municipality_id,
  is_primary,
  base_url,
  data_tier,
  verification_status,
  homepage_status,
  robots_respected,
  feasibility,
  classification_confidence,
  crawl_notes,
  vendime_url
)
SELECT
  muni.municipality_id,
  TRUE,
  muni.base_url,
  'TBD',
  'UNCHECKED',
  'UNCHECKED',
  'UNKNOWN',
  'TBD',
  0.0,
  NULLIF(muni.crawl_notes, ''),
  muni.vendime_url
FROM muni
WHERE NOT EXISTS (
  SELECT 1
  FROM source_registry sr
  WHERE sr.municipality_id = muni.municipality_id
    AND sr.is_primary = TRUE
);

-- Sanity: must have 61 municipalities and 61 primary registry rows
DO $$
DECLARE
  m_count INT;
  sr_count INT;
BEGIN
  SELECT COUNT(*) INTO m_count FROM municipalities;
  IF m_count <> 61 THEN
    RAISE EXCEPTION 'Expected 61 municipalities, found %', m_count;
  END IF;

  SELECT COUNT(*) INTO sr_count FROM source_registry WHERE is_primary = TRUE;
  IF sr_count <> 61 THEN
    RAISE EXCEPTION 'Expected 61 primary source_registry rows, found %', sr_count;
  END IF;
END $$;

COMMIT;

-- Verification query (should return 61):
-- SELECT COUNT(*) AS primary_rows FROM source_registry WHERE is_primary = TRUE;

-- 006_seed_source_registry.sql
-- Seeds one PRIMARY source_registry row per municipality, using Albanian Municipalities.xlsx.
-- Idempotent: will not create duplicates if a primary already exists for that municipality.

BEGIN;

WITH seed(name_sq, base_url, data_tier, homepage_status, notes, vendime_url) AS (
  VALUES
  ('Berat', 'https://bashkiaberat.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Kuçovë', 'https://bashkiakucove.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Poliçan', 'https://www.polican.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Skrapar', 'https://bashkiaskrapar.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Dimal', 'https://bashkiadimal.gov.al/', 'TBD', 'VERIFIED', 'Renamed from Ura Vajgurore in 2021', NULL),
  ('Bulqizë', 'https://bulqiza.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Dibër', 'https://dibra.gov.al/', 'TBD', 'ERROR', 'Website Down! CORRECT DOMAIN', NULL),
  ('Klos', 'https://bashkiaklos.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Mat', 'https://bashkiamat.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Durrës', 'https://durres.gov.al/', 'Tier 1', 'VERIFIED', 'Major port city - Priority', NULL),
  ('Krujë', 'https://kruja.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Shijak', 'https://shijak.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Belsh', 'https://bashkiabelsh.al/', 'TBD', 'VERIFIED', 'Uses .al (not .gov.al)', NULL),
  ('Cërrik', 'https://bashkiacerrik.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Elbasan', 'https://elbasani.gov.al/', 'Tier 1', 'VERIFIED', 'Major city - Priority', NULL),
  ('Gramsh', 'https://bashkiagramsh.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Librazhd', 'https://bashkialibrazhd.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Peqin', 'https://peqini.gov.al/', 'TBD', 'VERIFIED', 'Uses "peqini" not "bashkiapeqin"', NULL),
  ('Prrenjas', 'https://bashkiaprrenjas.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Divjakë', 'https://bashkiadivjake.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Fier', 'https://bashkiafier.gov.al/', 'TBD', 'VERIFIED', 'Unsafe Error, Not Secure, Servers down!', NULL),
  ('Lushnjë', 'https://bashkialushnje.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Mallakastër', 'https://bashkiamallakaster.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Patos', 'https://bashkiapatos.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Roskovec', 'https://bashkiaroskovec.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Dropull', 'https://bashkiadropull.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Gjirokastër', 'https://bashkiagjirokaster.gov.al/', 'TBD', 'VERIFIED', 'UNESCO site', NULL),
  ('Këlcyrë', 'https://bashkiakelcyre.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Libohovë', 'https://bashkialibohove.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Memaliaj', 'https://memaliaj.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Përmet', 'https://bashkiapermet.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Tepelenë', 'https://tepelena.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Devoll', 'https://bashkiadevoll.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Kolonjë', 'https://kolonja.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Korçë', 'https://bashkiakorce.gov.al/', 'Tier 1', 'VERIFIED', 'Major city - Priority', NULL),
  ('Maliq', 'https://bashkiamaliq.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Pogradec', 'https://bashkiapogradec.gov.al/', 'TBD', 'VERIFIED', 'Tourist area', NULL),
  ('Pustec', 'https://bashkiapustec.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Has', 'https://bashkiahas.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Kukës', 'https://kukesi.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Tropojë', 'https://tropoje.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Kurbin', 'https://bashkiakurbin.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Lezhë', 'https://lezha.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Mirditë', 'https://bashkiamirdite.gov.al/', 'TBD', 'VERIFIED', 'Unsafe Error, Not Secure, Servers down!', NULL),
  ('Fushë-Arrëz', 'https://bashkiafushearrez.gov.al/', 'TBD', 'VERIFIED', 'Standard pattern', NULL),
  ('Malësi e Madhe', 'https://bashkiamalesiemadhe.gov.al/', 'TBD', 'VERIFIED', 'Standard pattern', NULL),
  ('Pukë', 'https://bashkiapuke.gov.al/', 'TBD', 'VERIFIED', 'Standard pattern', NULL),
  ('Shkodër', 'https://bashkiashkoder.gov.al/', 'Tier 1', 'VERIFIED', 'Major city', NULL),
  ('Vau i Dejës', 'https://vaudejes.gov.al/', 'TBD', 'VERIFIED', 'Standard pattern - needs verification', NULL),
  ('Kamëz', 'https://kamza.gov.al/', 'TBD', 'VERIFIED', 'Uses "kamza" not "kamez"', NULL),
  ('Kavajë', 'https://kavajajone.al/', 'TBD', 'VERIFIED', 'Uses kavajajone.al (special domain)', NULL),
  ('Rrogozhinë', 'https://bashkiarrogozhine.gov.al/', 'TBD', 'VERIFIED', 'Standard pattern', NULL),
  ('Tiranë', 'https://tirana.al/', 'Tier 1', 'VERIFIED', 'CAPITAL - TOP PRIORITY - Uses tirana.al', 'https://tirana.al/kategoria-e-publikimit/vendime-te-keshillit-bashkiak-{year}-4290'),
  ('Vorë', 'https://bashkiavore.gov.al/', 'TBD', 'VERIFIED', 'Standard pattern', NULL),
  ('Delvinë', 'https://bashkiadelvine.gov.al/', 'TBD', 'VERIFIED', 'Standard pattern', NULL),
  ('Finiq', 'https://bfiniq.gov.al/', 'TBD', 'VERIFIED', 'Standard pattern', NULL),
  ('Himarë', 'https://himara.gov.al/', 'TBD', 'VERIFIED', 'Coastal tourist area', NULL),
  ('Konispol', 'https://bashkiakonispol.gov.al/', 'TBD', 'VERIFIED', '', NULL),
  ('Sarandë', 'https://bashkiasarande.gov.al/', 'TBD', 'VERIFIED', 'Major tourist city', NULL),
  ('Selenicë', 'https://selenica.gov.al/', 'TBD', 'VERIFIED', 'Uses selenica not bashkiaselenice.', NULL),
  ('Vlorë', 'https://vlora.gov.al/', 'Tier 1', 'VERIFIED', 'Major port city - Priority', NULL)
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
  homepage_status,
  verification_status,
  notes,
  vendime_url
)
SELECT
  muni.municipality_id,
  TRUE,
  muni.base_url,
  muni.data_tier,
  muni.homepage_status,
  'UNCHECKED',
  muni.notes,
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

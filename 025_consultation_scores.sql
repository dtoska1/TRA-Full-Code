-- 025_consultation_scores.sql
-- Task B / Stage B1: storage for the Public Consultation Matrix (Law 146/2014).
-- Per-municipality assessment: 5 indicators x 20 = 100 pts.
-- Design: auto-propose (with confidence + argument) → publish immediately → reviewer override.
-- Purely ADDITIVE: one new table, no changes to items/documents/registry. Transaction-wrapped.
--
-- Patterns matched to existing schema (confirmed via \d items):
--   - UUID PK (gen_random_uuid)
--   - municipality_id uuid FK → municipalities(id) ON DELETE CASCADE
--   - updated_at timestamptz + set_updated_at() trigger (function already exists in schema)
--
-- Each indicator stores: auto_score (engine), final_score (reviewer, defaults to auto),
-- confidence, argument (machine/reviewer justification citing evidence), overridden flag.
-- Total + tier are DERIVED at read time from the 5 final_* scores (not stored denormalized,
-- to avoid drift). A helper view is provided for convenience.

BEGIN;

CREATE TABLE IF NOT EXISTS consultation_scores (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  municipality_id          uuid NOT NULL REFERENCES municipalities(id) ON DELETE CASCADE,

  -- Indicator 1: Consultation Calendar (Pre) — 0/5/10/20
  ind1_auto_score          smallint NOT NULL DEFAULT 0,
  ind1_final_score         smallint,
  ind1_confidence          text NOT NULL DEFAULT 'low',
  ind1_argument            text,
  ind1_overridden          boolean NOT NULL DEFAULT false,

  -- Indicator 2: Centralized Digital Register (Pre) — 0/10/20
  ind2_auto_score          smallint NOT NULL DEFAULT 0,
  ind2_final_score         smallint,
  ind2_confidence          text NOT NULL DEFAULT 'low',
  ind2_argument            text,
  ind2_overridden          boolean NOT NULL DEFAULT false,

  -- Indicator 3: Draft Acts & Explanatory Memos (Active) — 0/5/10/20
  ind3_auto_score          smallint NOT NULL DEFAULT 0,
  ind3_final_score         smallint,
  ind3_confidence          text NOT NULL DEFAULT 'low',
  ind3_argument            text,
  ind3_overridden          boolean NOT NULL DEFAULT false,

  -- Indicator 4: Legal Timeframe (Active) — 0/10/20
  ind4_auto_score          smallint NOT NULL DEFAULT 0,
  ind4_final_score         smallint,
  ind4_confidence          text NOT NULL DEFAULT 'low',
  ind4_argument            text,
  ind4_overridden          boolean NOT NULL DEFAULT false,

  -- Indicator 5: Reports & Institutional Responses (Post) — 0/10/20
  ind5_auto_score          smallint NOT NULL DEFAULT 0,
  ind5_final_score         smallint,
  ind5_confidence          text NOT NULL DEFAULT 'low',
  ind5_argument            text,
  ind5_overridden          boolean NOT NULL DEFAULT false,

  -- Provenance / lifecycle
  computed_at              timestamptz,                       -- when the auto-engine last ran
  reviewed_at              timestamptz,                       -- when a reviewer last touched it
  reviewed_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  status                   text NOT NULL DEFAULT 'published', -- 'published' (auto-live) | 'draft'
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- one active score row per municipality
  CONSTRAINT ux_consultation_scores_municipality UNIQUE (municipality_id),

  -- validity guards: scores must be one of the allowed rubric values (0/5/10/20)
  CONSTRAINT ck_cs_ind1 CHECK (ind1_auto_score  IN (0,5,10,20) AND (ind1_final_score IS NULL OR ind1_final_score IN (0,5,10,20))),
  CONSTRAINT ck_cs_ind2 CHECK (ind2_auto_score  IN (0,10,20)   AND (ind2_final_score IS NULL OR ind2_final_score IN (0,10,20))),
  CONSTRAINT ck_cs_ind3 CHECK (ind3_auto_score  IN (0,5,10,20) AND (ind3_final_score IS NULL OR ind3_final_score IN (0,5,10,20))),
  CONSTRAINT ck_cs_ind4 CHECK (ind4_auto_score  IN (0,10,20)   AND (ind4_final_score IS NULL OR ind4_final_score IN (0,10,20))),
  CONSTRAINT ck_cs_ind5 CHECK (ind5_auto_score  IN (0,10,20)   AND (ind5_final_score IS NULL OR ind5_final_score IN (0,10,20))),
  CONSTRAINT ck_cs_confidence CHECK (
    ind1_confidence IN ('high','medium','low') AND
    ind2_confidence IN ('high','medium','low') AND
    ind3_confidence IN ('high','medium','low') AND
    ind4_confidence IN ('high','medium','low') AND
    ind5_confidence IN ('high','medium','low')
  ),
  CONSTRAINT ck_cs_status CHECK (status IN ('published','draft'))
);

-- reuse the existing updated_at trigger function (present on items)
CREATE TRIGGER trg_consultation_scores_set_updated_at
  BEFORE UPDATE ON consultation_scores
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- convenience view: effective score per indicator (final if set, else auto), total, tier
CREATE OR REPLACE VIEW consultation_scores_effective AS
SELECT
  cs.id,
  cs.municipality_id,
  m.name_key AS municipality_key,
  COALESCE(cs.ind1_final_score, cs.ind1_auto_score) AS ind1,
  COALESCE(cs.ind2_final_score, cs.ind2_auto_score) AS ind2,
  COALESCE(cs.ind3_final_score, cs.ind3_auto_score) AS ind3,
  COALESCE(cs.ind4_final_score, cs.ind4_auto_score) AS ind4,
  COALESCE(cs.ind5_final_score, cs.ind5_auto_score) AS ind5,
  (COALESCE(cs.ind1_final_score, cs.ind1_auto_score)
   + COALESCE(cs.ind2_final_score, cs.ind2_auto_score)
   + COALESCE(cs.ind3_final_score, cs.ind3_auto_score)
   + COALESCE(cs.ind4_final_score, cs.ind4_auto_score)
   + COALESCE(cs.ind5_final_score, cs.ind5_auto_score)) AS total,
  CASE
    WHEN (COALESCE(cs.ind1_final_score,cs.ind1_auto_score)+COALESCE(cs.ind2_final_score,cs.ind2_auto_score)+COALESCE(cs.ind3_final_score,cs.ind3_auto_score)+COALESCE(cs.ind4_final_score,cs.ind4_auto_score)+COALESCE(cs.ind5_final_score,cs.ind5_auto_score)) >= 90 THEN 'Excellent'
    WHEN (COALESCE(cs.ind1_final_score,cs.ind1_auto_score)+COALESCE(cs.ind2_final_score,cs.ind2_auto_score)+COALESCE(cs.ind3_final_score,cs.ind3_auto_score)+COALESCE(cs.ind4_final_score,cs.ind4_auto_score)+COALESCE(cs.ind5_final_score,cs.ind5_auto_score)) >= 75 THEN 'Good'
    WHEN (COALESCE(cs.ind1_final_score,cs.ind1_auto_score)+COALESCE(cs.ind2_final_score,cs.ind2_auto_score)+COALESCE(cs.ind3_final_score,cs.ind3_auto_score)+COALESCE(cs.ind4_final_score,cs.ind4_auto_score)+COALESCE(cs.ind5_final_score,cs.ind5_auto_score)) >= 60 THEN 'Moderate'
    WHEN (COALESCE(cs.ind1_final_score,cs.ind1_auto_score)+COALESCE(cs.ind2_final_score,cs.ind2_auto_score)+COALESCE(cs.ind3_final_score,cs.ind3_auto_score)+COALESCE(cs.ind4_final_score,cs.ind4_auto_score)+COALESCE(cs.ind5_final_score,cs.ind5_auto_score)) >= 40 THEN 'Weak'
    ELSE 'Critical'
  END AS tier,
  cs.status,
  cs.computed_at,
  cs.reviewed_at,
  cs.updated_at
FROM consultation_scores cs
JOIN municipalities m ON m.id = cs.municipality_id;

COMMIT;

-- ROLLBACK (manual reversal if needed):
--   BEGIN;
--   DROP VIEW IF EXISTS consultation_scores_effective;
--   DROP TABLE IF EXISTS consultation_scores;  -- CASCADE not needed; nothing references it
--   COMMIT;

-- VERIFY after commit:
--   \d consultation_scores
--   SELECT * FROM consultation_scores_effective;   -- empty until the engine runs

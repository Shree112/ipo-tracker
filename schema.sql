-- ============================================================
-- IPO Tracker - schema
-- Postgres 15+ (Supabase). Idempotent: safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- Append-only guard. Used on tables where history is the point
-- and a silent overwrite would destroy something we cannot
-- reconstruct later.
--
-- To repair bad rows deliberately:
--   ALTER TABLE gmp_history DISABLE TRIGGER gmp_history_append_only;
--   ... fix ...
--   ALTER TABLE gmp_history ENABLE TRIGGER gmp_history_append_only;
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only; % is not permitted. Disable the trigger explicitly if you really mean it.',
    TG_TABLE_NAME, TG_OP;
END $$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;


-- ============================================================
-- issues - one row per IPO, mainboard or SME
-- ============================================================
CREATE TABLE IF NOT EXISTS issues (
  id                bigserial PRIMARY KEY,
  slug              text        NOT NULL UNIQUE,
  name              text        NOT NULL,
  board             text        NOT NULL DEFAULT 'mainboard'
                                CHECK (board IN ('mainboard','sme')),
  exchanges         text,
  chittorgarh_id    integer,
  chittorgarh_url   text,

  open_date         date,
  close_date        date,
  listing_date      date,

  price_band_low    numeric(12,2),
  price_band_high   numeric(12,2),
  issue_price       numeric(12,2),
  lot_size          integer,
  issue_size_cr     numeric(14,2),
  rhp_url           text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS issues_open_date_idx    ON issues (open_date DESC);
CREATE INDEX IF NOT EXISTS issues_listing_date_idx ON issues (listing_date DESC);
CREATE INDEX IF NOT EXISTS issues_board_idx        ON issues (board);
CREATE UNIQUE INDEX IF NOT EXISTS issues_cg_id_idx ON issues (chittorgarh_id)
  WHERE chittorgarh_id IS NOT NULL;

DROP TRIGGER IF EXISTS issues_touch ON issues;
CREATE TRIGGER issues_touch BEFORE UPDATE ON issues
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ============================================================
-- gmp_history - APPEND ONLY.
-- The time series is the whole point: slope, and later the
-- calibration curve, are both unreconstructable if we overwrite.
-- ============================================================
CREATE TABLE IF NOT EXISTS gmp_history (
  id                bigserial PRIMARY KEY,
  issue_id          bigint      NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  source            text        NOT NULL CHECK (source IN ('investorgain','ipowatch','chittorgarh')),
  observed_at       timestamptz NOT NULL,
  gmp_amount        numeric(12,2),
  gmp_pct           numeric(8,3),
  est_listing_price numeric(12,2),
  raw               jsonb,
  UNIQUE (issue_id, source, observed_at)
);

CREATE INDEX IF NOT EXISTS gmp_history_issue_time_idx
  ON gmp_history (issue_id, observed_at DESC);

DROP TRIGGER IF EXISTS gmp_history_append_only ON gmp_history;
CREATE TRIGGER gmp_history_append_only BEFORE UPDATE OR DELETE ON gmp_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();


-- ============================================================
-- subscription - category-wise subscription, official, during window
-- ============================================================
CREATE TABLE IF NOT EXISTS subscription (
  id            bigserial PRIMARY KEY,
  issue_id      bigint      NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  observed_at   timestamptz NOT NULL,
  source        text        NOT NULL DEFAULT 'nse' CHECK (source IN ('nse','bse','chittorgarh')),
  qib_x         numeric(10,3),
  nii_x         numeric(10,3),
  rii_x         numeric(10,3),
  employee_x    numeric(10,3),
  total_x       numeric(10,3),
  UNIQUE (issue_id, source, observed_at)
);

CREATE INDEX IF NOT EXISTS subscription_issue_time_idx
  ON subscription (issue_id, observed_at DESC);


-- ============================================================
-- signal_snapshot - APPEND ONLY, one row per issue per phase.
-- Frozen BEFORE the outcome is known. A snapshot written after
-- listing is contaminated by hindsight and worse than nothing.
-- ============================================================
CREATE TABLE IF NOT EXISTS signal_snapshot (
  id                bigserial PRIMARY KEY,
  issue_id          bigint      NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  phase             text        NOT NULL CHECK (phase IN ('t_minus_1','close_day')),
  taken_at          timestamptz NOT NULL DEFAULT now(),

  gmp_amount        numeric(12,2),
  gmp_pct           numeric(8,3),

  sub_qib_x         numeric(10,3),
  sub_nii_x         numeric(10,3),
  sub_rii_x         numeric(10,3),
  sub_total_x       numeric(10,3),

  anchor_total_cr   numeric(14,2),
  anchor_mf_pct     numeric(6,2),
  anchor_top5_pct   numeric(6,2),

  pe_issue          numeric(10,2),
  pe_peer_median    numeric(10,2),

  comment_count     integer,

  extras            jsonb,
  UNIQUE (issue_id, phase)
);

DROP TRIGGER IF EXISTS signal_snapshot_append_only ON signal_snapshot;
CREATE TRIGGER signal_snapshot_append_only BEFORE UPDATE OR DELETE ON signal_snapshot
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();


-- ============================================================
-- listing_outcome - the other half of the loop.
--
-- price_basis is load-bearing. The backfill is entirely
-- close-based (that is all the tracker publishes); live rows
-- will mostly be open-based. Regressing across both compares
-- two different quantities. Never mix them in one curve.
-- ============================================================
CREATE TABLE IF NOT EXISTS listing_outcome (
  id                bigserial PRIMARY KEY,
  issue_id          bigint      NOT NULL UNIQUE REFERENCES issues(id) ON DELETE CASCADE,
  listing_date      date,

  issue_price       numeric(12,2) NOT NULL CHECK (issue_price > 0),
  listing_open      numeric(12,2),
  listing_close     numeric(12,2),

  price_basis       text        NOT NULL CHECK (price_basis IN ('open','close')),
  headline_price    numeric(12,2) NOT NULL,

  listing_gain_pct  numeric(10,3)
                    GENERATED ALWAYS AS
                    (round(((headline_price - issue_price) / issue_price) * 100, 3)) STORED,

  price_t30         numeric(12,2),
  gain_t30_pct      numeric(10,3)
                    GENERATED ALWAYS AS
                    (CASE WHEN price_t30 IS NULL THEN NULL
                          ELSE round(((price_t30 - issue_price) / issue_price) * 100, 3) END) STORED,

  source            text        NOT NULL,
  captured_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS listing_outcome_basis_idx ON listing_outcome (price_basis);
CREATE INDEX IF NOT EXISTS listing_outcome_date_idx  ON listing_outcome (listing_date DESC);


-- ============================================================
-- issue_status - drives the digest, and is the first column
-- of the calibration log
-- ============================================================
CREATE TABLE IF NOT EXISTS issue_status (
  issue_id          bigint      PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
  status            text        NOT NULL DEFAULT 'eligible'
                                CHECK (status IN ('eligible','notified','applied','skipped','closed')),
  first_notified_at timestamptz,
  resolved_at       timestamptz,
  note              text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS issue_status_touch ON issue_status;
CREATE TRIGGER issue_status_touch BEFORE UPDATE ON issue_status
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ============================================================
-- scrape_run - did the pipeline actually run, and did it find
-- anything? A scraper returning zero rows must be loud, not silent.
-- ============================================================
CREATE TABLE IF NOT EXISTS scrape_run (
  id            bigserial PRIMARY KEY,
  source        text        NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text        NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running','ok','empty','error')),
  rows_seen     integer     NOT NULL DEFAULT 0,
  rows_written  integer     NOT NULL DEFAULT 0,
  message       text
);

CREATE INDEX IF NOT EXISTS scrape_run_source_time_idx
  ON scrape_run (source, started_at DESC);


-- ============================================================
-- Convenience view: the calibration join, basis kept separate.
-- ============================================================
CREATE OR REPLACE VIEW calibration AS
SELECT
  i.id                AS issue_id,
  i.name,
  i.board,
  i.listing_date,
  s.phase,
  s.gmp_pct           AS predicted_gain_pct,
  o.price_basis,
  o.listing_gain_pct  AS actual_gain_pct,
  o.listing_gain_pct - s.gmp_pct AS error_pct,
  st.status           AS my_decision
FROM issues i
JOIN listing_outcome o  ON o.issue_id = i.id
LEFT JOIN signal_snapshot s ON s.issue_id = i.id AND s.phase = 't_minus_1'
LEFT JOIN issue_status  st ON st.issue_id = i.id;


-- ============================================================
-- Added after the Chittorgarh probe: the tracker distinguishes
-- IPO from REIT / InvIT / SM REIT in the same table.
-- ============================================================
ALTER TABLE issues ADD COLUMN IF NOT EXISTS issue_type text;
ALTER TABLE listing_outcome ADD COLUMN IF NOT EXISTS listing_low  numeric(12,2);
ALTER TABLE listing_outcome ADD COLUMN IF NOT EXISTS listing_high numeric(12,2);


-- ============================================================
-- Added for the GMP backfill (IPO Watch day-wise history).
-- A backfilled row was read off a page after the fact; a live row was
-- observed on the day. They are kept distinguishable forever, because
-- nobody can prove a site never edited an old row - comparing our own
-- live readings with what the site shows later is how we find out.
-- IPO Watch gives dates, not times, so precision is recorded too.
-- ============================================================
ALTER TABLE gmp_history ADD COLUMN IF NOT EXISTS capture_mode text NOT NULL DEFAULT 'live'
  CHECK (capture_mode IN ('live','backfill'));
ALTER TABLE gmp_history ADD COLUMN IF NOT EXISTS observed_precision text NOT NULL DEFAULT 'minute'
  CHECK (observed_precision IN ('minute','day'));
ALTER TABLE issues ADD COLUMN IF NOT EXISTS ipowatch_url text;


-- ============================================================
-- Added for the live scrapers (InvestorGain calendar + GMP).
-- InvestorGain's cor_id is Chittorgarh's ipo id, so chittorgarh_id stays the
-- one join key across both sites; investorgain_id is its own page id.
-- ============================================================
ALTER TABLE issues ADD COLUMN IF NOT EXISTS investorgain_id   integer;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS investorgain_url  text;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS anchor_date       date;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS min_order_amount  numeric(14,2);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS anchor_report_url text;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS nse_symbol        text;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS bse_code          text;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS site_status       text;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS withdrawn         boolean;
CREATE UNIQUE INDEX IF NOT EXISTS issues_investorgain_id_uidx
  ON issues (investorgain_id) WHERE investorgain_id IS NOT NULL;


-- ============================================================
-- digest_run - one row per digest actually sent, so a rerun of the
-- morning job on the same day never mails twice.
-- ============================================================
CREATE TABLE IF NOT EXISTS digest_run (
  digest_date  date        PRIMARY KEY,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  issue_ids    bigint[]    NOT NULL,
  subject      text,
  provider_id  text
);


-- Issue size split, for the digest: fresh issue (money to the company)
-- vs offer for sale (existing shareholders selling).
ALTER TABLE issues ADD COLUMN IF NOT EXISTS fresh_issue_cr numeric(14,2);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS ofs_cr         numeric(14,2);

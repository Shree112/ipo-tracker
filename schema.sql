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


-- ============================================================
-- Live subscription from InvestorGain's subscription report (one page
-- for every open issue). The exchanges stay the authority; this is the
-- practical feed until the NSE handshake is proven from a datacentre IP.
-- SHNI / BHNI are the small (2-10 lakh) and big (>10 lakh) NII buckets.
-- ============================================================
ALTER TABLE subscription DROP CONSTRAINT IF EXISTS subscription_source_check;
ALTER TABLE subscription ADD CONSTRAINT subscription_source_check
  CHECK (source IN ('nse','bse','chittorgarh','investorgain'));
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS shni_x numeric(10,3);
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS bhni_x numeric(10,3);
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS raw    jsonb;
ALTER TABLE issues       ADD COLUMN IF NOT EXISTS pe_ratio numeric(10,2);


-- ============================================================
-- issue_detail - the per-issue research block, refreshed each run from
-- the InvestorGain issue page: anchor book (with an inferred investor
-- category), restated financials, the RHP's listed-peer table, objects of
-- the issue, and KPIs. One row per issue, overwritten as it firms up
-- (the anchor book only appears the day before opening).
-- ============================================================
CREATE TABLE IF NOT EXISTS issue_detail (
  issue_id          bigint PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
  anchor            jsonb,
  anchor_summary    jsonb,
  anchor_lockin_30  date,
  anchor_lockin_90  date,
  financials        jsonb,
  peers             jsonb,
  objects           jsonb,
  kpis              jsonb,
  source            text NOT NULL DEFAULT 'investorgain',
  updated_at        timestamptz NOT NULL DEFAULT now()
);


-- ============================================================
-- MULTI-USER. Sign-in is Supabase Auth (Google); these tables hold who is
-- allowed in, what each person wants alerts for, and their own decisions.
-- user_id is auth.users.id. No FK to auth.users so the schema also applies
-- to a plain Postgres (tests); the app only ever inserts real ids.
-- ============================================================
CREATE TABLE IF NOT EXISTS app_users (
  user_id       uuid PRIMARY KEY,
  email         text NOT NULL,
  name          text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  is_admin      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  last_seen_at  timestamptz
);

-- One rule set per person. A NULL threshold means "not used".
CREATE TABLE IF NOT EXISTS alert_rules (
  user_id            uuid PRIMARY KEY REFERENCES app_users(user_id) ON DELETE CASCADE,
  gmp_pct_min        numeric(6,2) DEFAULT 10,
  profit_per_lot_min numeric(12,2),          -- GMP (Rs/share) x lot size
  sub_total_min      numeric(8,2),
  sub_retail_min     numeric(8,2),
  sub_qib_min        numeric(8,2),
  anchor_mf_min      numeric(5,2),           -- % of the anchor book taken by mutual funds
  size_min_cr        numeric(12,2),
  size_max_cr        numeric(12,2),
  match_mode         text NOT NULL DEFAULT 'all' CHECK (match_mode IN ('all','any')),
  digest_hour        smallint NOT NULL DEFAULT 8 CHECK (digest_hour BETWEEN 5 AND 22),
  digest_days        text NOT NULL DEFAULT 'daily' CHECK (digest_days IN ('daily','weekdays')),
  start_at           text NOT NULL DEFAULT 't_minus_1' CHECK (start_at IN ('t_minus_1','open')),
  last_day_reminder  boolean NOT NULL DEFAULT false,
  email_to           text,
  paused             boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_issue_status (
  user_id            uuid   NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  issue_id           bigint NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  status             text   NOT NULL DEFAULT 'notified' CHECK (status IN ('notified','applied','skipped','closed')),
  first_notified_at  timestamptz,
  resolved_at        timestamptz,
  note               text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, issue_id)
);

CREATE TABLE IF NOT EXISTS user_digest_run (
  user_id      uuid NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  digest_date  date NOT NULL,
  kind         text NOT NULL DEFAULT 'daily' CHECK (kind IN ('daily','reminder')),
  sent_at      timestamptz NOT NULL DEFAULT now(),
  issue_ids    bigint[] NOT NULL,
  provider_id  text,
  PRIMARY KEY (user_id, digest_date, kind)
);

-- Emails about the account itself, sent by the hourly job: "you're in" to a
-- newly approved person, and "someone's waiting" to the admin.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS welcome_sent_at timestamptz;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS admin_notified_at timestamptz;

-- The owner's single-user decisions move into their account once it exists.
INSERT INTO user_issue_status (user_id, issue_id, status, first_notified_at, resolved_at, note)
SELECT a.user_id, s.issue_id,
       CASE WHEN s.status = 'eligible' THEN 'notified' ELSE s.status END,
       s.first_notified_at, s.resolved_at, s.note
FROM issue_status s
CROSS JOIN (SELECT user_id FROM app_users WHERE is_admin ORDER BY created_at LIMIT 1) a
WHERE s.status <> 'eligible'
ON CONFLICT (user_id, issue_id) DO NOTHING;

-- Everything a rule can test, per live mainboard issue, in one place - used
-- by the Python digest and the website alike, so they can never disagree.
CREATE OR REPLACE VIEW issue_signals AS
SELECT i.id AS issue_id, i.slug, i.name, i.open_date, i.close_date, i.lot_size, i.issue_size_cr,
       g.gmp_pct, g.gmp_amount,
       pk.peak_pct_t1, pk.peak_pct_open, pk.peak_amt_t1, pk.peak_amt_open,
       s.total_x, s.rii_x, s.qib_x,
       NULLIF(d.anchor_summary->>'mf_pct', '')::numeric AS anchor_mf_pct
FROM issues i
LEFT JOIN LATERAL (
  SELECT h.gmp_pct, h.gmp_amount FROM gmp_history h
  WHERE h.issue_id = i.id AND h.gmp_pct IS NOT NULL
  ORDER BY (h.source = 'investorgain') DESC, h.observed_at DESC LIMIT 1) g ON true
LEFT JOIN LATERAL (
  SELECT max(h.gmp_pct)    FILTER (WHERE h.observed_at >= ((i.open_date - 1)::timestamp AT TIME ZONE 'Asia/Kolkata')) AS peak_pct_t1,
         max(h.gmp_pct)    FILTER (WHERE h.observed_at >= (i.open_date::timestamp AT TIME ZONE 'Asia/Kolkata'))      AS peak_pct_open,
         max(h.gmp_amount) FILTER (WHERE h.observed_at >= ((i.open_date - 1)::timestamp AT TIME ZONE 'Asia/Kolkata')) AS peak_amt_t1,
         max(h.gmp_amount) FILTER (WHERE h.observed_at >= (i.open_date::timestamp AT TIME ZONE 'Asia/Kolkata'))      AS peak_amt_open
  FROM gmp_history h WHERE h.issue_id = i.id) pk ON true
LEFT JOIN LATERAL (
  SELECT x.total_x, x.rii_x, x.qib_x FROM subscription x
  WHERE x.issue_id = i.id ORDER BY x.observed_at DESC LIMIT 1) s ON true
LEFT JOIN issue_detail d ON d.issue_id = i.id
WHERE i.board = 'mainboard' AND COALESCE(i.withdrawn, false) = false
  AND i.open_date IS NOT NULL AND i.close_date IS NOT NULL;

-- Who should hear about what, today. Entry: the person's rule matches (all
-- or any of the thresholds they set) inside their window. Sticky: once in a
-- digest it stays. Exit: they mark it applied/skipped, or it closes.
-- A threshold on data that doesn't exist yet (no subscription before
-- opening, no anchor book) counts as not met.
CREATE OR REPLACE FUNCTION user_matches(p_today date)
RETURNS TABLE (user_id uuid, issue_id bigint, reasons text[], sticky boolean)
LANGUAGE sql STABLE AS $$
  WITH c AS (
    SELECT r.user_id, s.issue_id, r.match_mode,
      GREATEST(s.gmp_pct, CASE WHEN r.start_at = 'open' THEN s.peak_pct_open ELSE s.peak_pct_t1 END) AS gmp_x,
      GREATEST(s.gmp_amount, CASE WHEN r.start_at = 'open' THEN s.peak_amt_open ELSE s.peak_amt_t1 END)
        * s.lot_size AS profit_x,
      s.total_x, s.rii_x, s.qib_x, s.anchor_mf_pct, s.issue_size_cr,
      r.gmp_pct_min, r.profit_per_lot_min, r.sub_total_min, r.sub_retail_min, r.sub_qib_min,
      r.anchor_mf_min, r.size_min_cr, r.size_max_cr
    FROM alert_rules r
    JOIN app_users u ON u.user_id = r.user_id AND u.status = 'approved'
    CROSS JOIN issue_signals s
    WHERE p_today BETWEEN (CASE WHEN r.start_at = 'open' THEN s.open_date ELSE s.open_date - 1 END) AND s.close_date
  ), t AS (
    SELECT c.*,
      CASE WHEN gmp_pct_min IS NULL THEN NULL ELSE COALESCE(gmp_x >= gmp_pct_min, false) END AS ok_gmp,
      CASE WHEN profit_per_lot_min IS NULL THEN NULL ELSE COALESCE(profit_x >= profit_per_lot_min, false) END AS ok_profit,
      CASE WHEN sub_total_min IS NULL THEN NULL ELSE COALESCE(total_x >= sub_total_min, false) END AS ok_total,
      CASE WHEN sub_retail_min IS NULL THEN NULL ELSE COALESCE(rii_x >= sub_retail_min, false) END AS ok_retail,
      CASE WHEN sub_qib_min IS NULL THEN NULL ELSE COALESCE(qib_x >= sub_qib_min, false) END AS ok_qib,
      CASE WHEN anchor_mf_min IS NULL THEN NULL ELSE COALESCE(anchor_mf_pct >= anchor_mf_min, false) END AS ok_anchor,
      CASE WHEN size_min_cr IS NULL AND size_max_cr IS NULL THEN NULL
           ELSE COALESCE(issue_size_cr >= COALESCE(size_min_cr, 0) AND issue_size_cr <= COALESCE(size_max_cr, 1e12), false) END AS ok_size
    FROM c
  ), m AS (
    SELECT t.*, array_remove(ARRAY[ok_gmp, ok_profit, ok_total, ok_retail, ok_qib, ok_anchor, ok_size], NULL) AS oks
    FROM t
  )
  SELECT m.user_id, m.issue_id,
    array_remove(ARRAY[
      CASE WHEN ok_gmp THEN 'GMP ' || round(gmp_x, 1) || '%' END,
      CASE WHEN ok_profit THEN 'profit/lot ₹' || to_char(profit_x, 'FM99,99,99,990') END,
      CASE WHEN ok_total THEN 'subscribed ' || round(total_x, 2) || 'x' END,
      CASE WHEN ok_retail THEN 'retail ' || round(rii_x, 2) || 'x' END,
      CASE WHEN ok_qib THEN 'QIB ' || round(qib_x, 2) || 'x' END,
      CASE WHEN ok_anchor THEN 'MF ' || round(anchor_mf_pct, 0) || '% of anchor' END,
      CASE WHEN ok_size THEN 'size ₹' || round(issue_size_cr, 0) || ' Cr' END
    ], NULL) AS reasons,
    COALESCE(st.status = 'notified', false) AS sticky
  FROM m
  LEFT JOIN user_issue_status st ON st.user_id = m.user_id AND st.issue_id = m.issue_id
  WHERE COALESCE(st.status, '') NOT IN ('applied', 'skipped')
    AND (st.status = 'notified'
         OR (m.match_mode = 'all' AND cardinality(m.oks) > 0 AND NOT (false = ANY(m.oks)))
         OR (m.match_mode = 'any' AND true = ANY(m.oks)));
$$;

-- What people are saying about an issue: raw comments per source (kept so a
-- summary can be redone without re-fetching), and one summary per issue.
CREATE TABLE IF NOT EXISTS issue_chatter (
  issue_id     bigint NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  source       text NOT NULL CHECK (source IN ('ipowatch', 'reddit')),
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  n_comments   int NOT NULL DEFAULT 0,
  threads      jsonb,          -- [{title, url, n}] for Reddit; the page for IPO Watch
  comments     jsonb,          -- [{id, text, at, score}] newest first, capped
  status       text NOT NULL DEFAULT 'ok',   -- ok | not_configured | blocked | error
  PRIMARY KEY (issue_id, source)
);

CREATE TABLE IF NOT EXISTS issue_chatter_summary (
  issue_id       bigint PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
  summarized_at  timestamptz NOT NULL DEFAULT now(),
  input_hash     text NOT NULL,
  n_comments     int NOT NULL,
  summary        jsonb,        -- {headline, mood, points[], concerns[]}; null = too little to go on
  model          text
);

-- After applying: allotment and listing.
-- issues: which registrar runs the allotment, and when the basis of allotment
-- is finalised (both from the issue page).
ALTER TABLE issues ADD COLUMN IF NOT EXISTS registrar text;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS allotment_date date;
-- each member's own result, and which reminder emails already went out
ALTER TABLE user_issue_status ADD COLUMN IF NOT EXISTS allotment text
  CHECK (allotment IN ('allotted', 'not_allotted'));
ALTER TABLE user_issue_status ADD COLUMN IF NOT EXISTS allotment_at timestamptz;
ALTER TABLE user_issue_status ADD COLUMN IF NOT EXISTS allotment_mailed_at timestamptz;
ALTER TABLE user_issue_status ADD COLUMN IF NOT EXISTS listing_mailed_at timestamptz;
ALTER TABLE user_digest_run DROP CONSTRAINT IF EXISTS user_digest_run_kind_check;
ALTER TABLE user_digest_run ADD CONSTRAINT user_digest_run_kind_check
  CHECK (kind IN ('daily', 'reminder', 'allotment', 'listing'));
-- first sign-in: null until the member picks a starting set of rules
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS onboarded_at timestamptz;

-- Lock the database away from Supabase's public API. Signing in with Google
-- means the project's anon key sits with the website, and that key can call
-- the auto-generated REST API for anything in the public schema that RLS
-- doesn't cover - every table, view and function here. Nothing needs that
-- API: the website and the scripts connect as the database owner, which
-- bypasses RLS. So: RLS on everywhere with no policies, and no grants to the
-- API roles. (The DO block skips this on a plain Postgres without them.)
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated, PUBLIC;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, PUBLIC;
  END IF;
END $$;

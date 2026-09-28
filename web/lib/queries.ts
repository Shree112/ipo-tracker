import { db } from "./db";
import { toISODate, todayIST } from "./format";

export type GmpPoint = {
  source: "investorgain" | "ipowatch";
  observed_at: Date;
  gmp_amount: number;
  gmp_pct: number;
  capture_mode: "live" | "backfill";
};

export type SubPoint = {
  observed_at: Date;
  qib_x: number | null;
  nii_x: number | null;
  shni_x: number | null;
  bhni_x: number | null;
  rii_x: number | null;
  employee_x: number | null;
  total_x: number | null;
};

export type AnchorInvestor = {
  name: string;
  shares: number | null;
  amount_cr: number | null;
  pct_of_anchor: number | null;
  pct_of_issue: number | null;
  category?: "mf" | "insurance" | "foreign" | "aif" | "other";
};

export type IssueDetail = {
  anchor: {
    bid_date?: string;
    price?: number;
    pct_of_qib?: number;
    locked_30d_shares?: number;
    locked_90d_shares?: number;
    total_shares?: number;
    total_amount_cr?: number;
    investors: AnchorInvestor[];
  } | null;
  anchor_summary: {
    total_cr: number;
    investors: number;
    top5_pct: number;
    mf_pct: number;
    by_category_pct: Record<string, number>;
  } | null;
  anchor_lockin_30: string | null;
  anchor_lockin_90: string | null;
  financials: { periods: string[]; rows: { metric: string; values: (number | null)[] }[]; unit: string } | null;
  peers: { as_of: string | null; columns: string[]; rows: string[][] } | null;
  objects: { object: string; amount_cr: number | null }[] | null;
  kpis: Partial<Record<
    | "roe" | "roce" | "debt_equity" | "ronw" | "pat_margin" | "nav" | "price_to_book"
    | "eps_pre" | "eps_post" | "pe_pre" | "pe_post" | "market_cap_cr"
    | "promoter_pre_pct" | "promoter_post_pct" | "ebitda_margin",
    number
  >> | null;
  updated_at: Date;
};

export type IssueRow = {
  id: number;
  slug: string;
  name: string;
  open_date: string | null;
  close_date: string | null;
  anchor_date: string | null;
  listing_date: string | null;
  price_band_low: number | null;
  price_band_high: number | null;
  lot_size: number | null;
  min_order_amount: number | null;
  issue_size_cr: number | null;
  fresh_issue_cr: number | null;
  ofs_cr: number | null;
  pe_ratio: number | null;
  exchanges: string | null;
  rhp_url: string | null;
  anchor_report_url: string | null;
  investorgain_url: string | null;
  ipowatch_url: string | null;
  status: string;
  note: string | null;
  gmp_latest: { source: string; gmp_pct: number; gmp_amount: number; observed_at: string }[] | null;
  sub_latest: (Omit<SubPoint, "observed_at"> & { observed_at: string }) | null;
  peak_since_t1: number | null;
  listing_open: number | null;
  listing_gain_pct: number | null;
  price_basis: string | null;
  spark: number[] | null;
};

const ISSUE_COLUMNS = `
  i.id, i.slug, i.name, i.open_date, i.close_date, i.anchor_date, i.listing_date,
  i.price_band_low, i.price_band_high, i.lot_size, i.min_order_amount,
  i.issue_size_cr, i.fresh_issue_cr, i.ofs_cr, i.pe_ratio, i.exchanges,
  i.rhp_url, i.anchor_report_url, i.investorgain_url, i.ipowatch_url,
  COALESCE(st.status, '-') AS status, st.note,
  (SELECT json_agg(x) FROM (
     SELECT DISTINCT ON (source) source, gmp_pct, gmp_amount, observed_at
     FROM gmp_history g WHERE g.issue_id = i.id AND g.gmp_pct IS NOT NULL
     ORDER BY source, observed_at DESC) x) AS gmp_latest,
  (SELECT row_to_json(s) FROM (
     SELECT qib_x, nii_x, shni_x, bhni_x, rii_x, employee_x, total_x, observed_at
     FROM subscription WHERE issue_id = i.id ORDER BY observed_at DESC LIMIT 1) s) AS sub_latest,
  (SELECT max(gmp_pct) FROM gmp_history g
     WHERE g.issue_id = i.id AND i.open_date IS NOT NULL
       AND g.observed_at >= ((i.open_date - 1)::timestamp AT TIME ZONE 'Asia/Kolkata')) AS peak_since_t1,
  lo.listing_open, lo.listing_gain_pct, lo.price_basis,
  (SELECT json_agg(v) FROM (
     SELECT g.gmp_pct AS v FROM gmp_history g
     WHERE g.issue_id = i.id AND g.gmp_pct IS NOT NULL
       AND g.source = CASE WHEN EXISTS (SELECT 1 FROM gmp_history x
                                        WHERE x.issue_id = i.id AND x.source = 'investorgain')
                           THEN 'investorgain' ELSE 'ipowatch' END
     ORDER BY g.observed_at DESC LIMIT 20) t) AS spark
`;

function normalise(r: Record<string, unknown>): IssueRow {
  return {
    ...(r as unknown as IssueRow),
    id: Number(r.id), // bigint arrives as a string
    open_date: toISODate(r.open_date as Date),
    close_date: toISODate(r.close_date as Date),
    anchor_date: toISODate(r.anchor_date as Date),
    listing_date: toISODate(r.listing_date as Date),
  };
}

/** Everything worth seeing now: upcoming, open, awaiting listing, listed in the last week. */
export async function listIssues(userId: string): Promise<IssueRow[]> {
  const today = todayIST();
  const rows = await db().unsafe(
    `SELECT ${ISSUE_COLUMNS}
     FROM issues i
     LEFT JOIN user_issue_status st ON st.issue_id = i.id AND st.user_id = $2::uuid
     LEFT JOIN listing_outcome lo ON lo.issue_id = i.id
     WHERE i.board = 'mainboard' AND COALESCE(i.withdrawn, false) = false
       AND i.open_date IS NOT NULL
       AND i.open_date <= $1::date + 30
       AND COALESCE(i.listing_date, i.close_date + 7) >= $1::date - 7
     ORDER BY i.open_date, i.name`,
    [today, userId],
  );
  return rows.map(normalise);
}

export async function getIssue(slug: string, userId: string) {
  const sql = db();
  // One round trip: every query keys on the slug, so none waits for another.
  // (Before, the page made three sequential trips - and with the database in
  // Singapore that latency was most of the load time.)
  const bySlug = () => sql`(SELECT id FROM issues WHERE slug = ${slug})`;
  const [rows, gmp, subs, snaps, details, bands] = await Promise.all([
    sql.unsafe(
      `SELECT ${ISSUE_COLUMNS}
       FROM issues i
       LEFT JOIN user_issue_status st ON st.issue_id = i.id AND st.user_id = $2::uuid
       LEFT JOIN listing_outcome lo ON lo.issue_id = i.id
       WHERE i.slug = $1`,
      [slug, userId],
    ),
    sql<GmpPoint[]>`
      SELECT source, observed_at, gmp_amount, gmp_pct, capture_mode
      FROM gmp_history
      WHERE issue_id = ${bySlug()} AND gmp_pct IS NOT NULL
      ORDER BY observed_at`,
    sql<SubPoint[]>`
      SELECT observed_at, qib_x, nii_x, shni_x, bhni_x, rii_x, employee_x, total_x
      FROM subscription WHERE issue_id = ${bySlug()}
      ORDER BY observed_at`,
    sql<{ phase: string; gmp_pct: number | null; sub_total_x: number | null; sub_rii_x: number | null; taken_at: Date; extras: Record<string, unknown> | null }[]>`
      SELECT phase, gmp_pct, sub_total_x, sub_rii_x, taken_at, extras
      FROM signal_snapshot WHERE issue_id = ${bySlug()} ORDER BY phase DESC`,
    // issue_detail arrives with a schema update; until the Python side has
    // applied it, render the page without the research sections instead of
    // failing the whole page.
    sql<IssueDetail[]>`
      SELECT anchor, anchor_summary, anchor_lockin_30, anchor_lockin_90,
             financials, peers, objects, kpis, updated_at
      FROM issue_detail WHERE issue_id = ${bySlug()}`.catch((e: { code?: string }) => {
      if (e?.code === "42P01" || e?.code === "42703") return [] as IssueDetail[];
      throw e;
    }),
    baseRates(),
  ]);
  if (!rows.length) return null;
  const issue = normalise(rows[0]);
  const detail = details[0]
    ? {
        ...details[0],
        anchor_lockin_30: toISODate(details[0].anchor_lockin_30 as unknown as Date),
        anchor_lockin_90: toISODate(details[0].anchor_lockin_90 as unknown as Date),
      }
    : null;

  // History for context: how issues with a similar day-before GMP opened.
  const refGmp =
    snaps.find((s) => s.phase === "t_minus_1")?.gmp_pct ??
    (issue.gmp_latest?.find((g) => g.source === "investorgain") ?? issue.gmp_latest?.[0])?.gmp_pct ??
    null;
  const history = refGmp === null ? null : pickBand(bands, refGmp);

  return { issue, gmp: [...gmp], subs: [...subs], snaps: [...snaps], history, refGmp, detail };
}

const BANDS: [number, number, string][] = [
  [-1000, 0, "below 0%"],
  [0, 5, "0–5%"],
  [5, 10, "5–10%"],
  [10, 20, "10–20%"],
  [20, 40, "20–40%"],
  [40, 10000, "40% or more"],
];

type BandStat = { label: string; lo: number; hi: number; n: number; median: number | null; positive: number | null };
let bandCache: { at: number; rows: BandStat[] } | null = null;

/** Base rates for every GMP band in one query, cached per server instance for
 *  an hour - they only move when a new issue lists. */
export async function baseRates(): Promise<BandStat[]> {
  if (bandCache && Date.now() - bandCache.at < 3_600_000) return bandCache.rows;
  const rows = await db()<{ b: number; n: number; med: number | null; pos: number | null }[]>`
    SELECT CASE WHEN predicted_gain_pct < 0 THEN 0 WHEN predicted_gain_pct < 5 THEN 1
                WHEN predicted_gain_pct < 10 THEN 2 WHEN predicted_gain_pct < 20 THEN 3
                WHEN predicted_gain_pct < 40 THEN 4 ELSE 5 END AS b,
           count(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY actual_gain_pct) AS med,
           100.0 * avg((actual_gain_pct > 0)::int) AS pos
    FROM calibration
    WHERE phase = 't_minus_1' AND price_basis = 'open' AND predicted_gain_pct IS NOT NULL
    GROUP BY 1`;
  const out = BANDS.map(([lo, hi, label], k) => {
    const r = rows.find((x) => x.b === k);
    return { label, lo, hi, n: r?.n ?? 0, median: r?.med ?? null, positive: r?.pos ?? null };
  });
  bandCache = { at: Date.now(), rows: out };
  return out;
}

function pickBand(bands: BandStat[], gmpPct: number) {
  const b = bands.find((x) => gmpPct >= x.lo && gmpPct < x.hi) ?? bands[bands.length - 1];
  return { label: b.label, n: b.n, median: b.median, positive: b.positive };
}

export type Decision = "applied" | "skipped" | "undo";

export async function setDecision(userId: string, slug: string, decision: Decision, note: string | null) {
  const sql = db();
  const [issue] = await sql<{ id: number }[]>`SELECT id FROM issues WHERE slug = ${slug}`;
  if (!issue) throw new Error("unknown issue");
  if (decision === "undo") {
    // back to how it was: on the radar if a digest already carried it,
    // otherwise no row at all
    await sql`DELETE FROM user_issue_status
              WHERE user_id = ${userId}::uuid AND issue_id = ${issue.id} AND first_notified_at IS NULL`;
    await sql`UPDATE user_issue_status SET status = 'notified', resolved_at = NULL, updated_at = now()
              WHERE user_id = ${userId}::uuid AND issue_id = ${issue.id}`;
    return;
  }
  await sql`
    INSERT INTO user_issue_status (user_id, issue_id, status, resolved_at, note)
    VALUES (${userId}::uuid, ${issue.id}, ${decision}, now(), ${note})
    ON CONFLICT (user_id, issue_id) DO UPDATE
      SET status = EXCLUDED.status, resolved_at = now(), updated_at = now(),
          note = COALESCE(EXCLUDED.note, user_issue_status.note)`;
}

export type Match = { reasons: string[]; sticky: boolean; slug?: string; name?: string };

/** The viewer's radar: which issues match their alert rules today. Comes from
 *  the same SQL function the digest uses, so the site and the email agree.
 *  Slug and name come along so the Alerts page needs no second query. */
export async function matchesFor(userId: string, today = todayIST()): Promise<Map<number, Match>> {
  const rows = await db()<{ issue_id: number; reasons: string[]; sticky: boolean; slug: string; name: string }[]>`
    SELECT m.issue_id, m.reasons, m.sticky, i.slug, i.name
    FROM user_matches(${today}::date) m JOIN issues i ON i.id = m.issue_id
    WHERE m.user_id = ${userId}::uuid`;
  return new Map(
    rows.map((r) => [Number(r.issue_id), { reasons: r.reasons ?? [], sticky: r.sticky, slug: r.slug, name: r.name }]),
  );
}

export type Rules = {
  gmp_pct_min: number | null;
  profit_per_lot_min: number | null;
  sub_total_min: number | null;
  sub_retail_min: number | null;
  sub_qib_min: number | null;
  anchor_mf_min: number | null;
  size_min_cr: number | null;
  size_max_cr: number | null;
  match_mode: "all" | "any";
  digest_hour: number;
  digest_days: "daily" | "weekdays";
  start_at: "t_minus_1" | "open";
  last_day_reminder: boolean;
  email_to: string | null;
  paused: boolean;
};

export const RULE_KEYS = [
  "gmp_pct_min",
  "profit_per_lot_min",
  "sub_total_min",
  "sub_retail_min",
  "sub_qib_min",
  "anchor_mf_min",
  "size_min_cr",
  "size_max_cr",
] as const;

export async function rulesFor(userId: string): Promise<Rules | null> {
  const [r] = await db()<Rules[]>`
    SELECT gmp_pct_min, profit_per_lot_min, sub_total_min, sub_retail_min, sub_qib_min, anchor_mf_min,
           size_min_cr, size_max_cr, match_mode, digest_hour, digest_days, start_at, last_day_reminder,
           email_to, paused
    FROM alert_rules WHERE user_id = ${userId}::uuid`;
  return r ?? null;
}

/** One line describing the rules, e.g. "GMP ≥ 10% or retail ≥ 2x". */
export function describeRules(r: Rules | null): string {
  if (!r) return "no alerts set";
  const n = (x: number) => x.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const parts = [
    r.gmp_pct_min !== null ? `GMP ≥ ${n(r.gmp_pct_min)}%` : null,
    r.profit_per_lot_min !== null ? `profit/lot ≥ ₹${n(r.profit_per_lot_min)}` : null,
    r.sub_total_min !== null ? `subscribed ≥ ${n(r.sub_total_min)}x` : null,
    r.sub_retail_min !== null ? `retail ≥ ${n(r.sub_retail_min)}x` : null,
    r.sub_qib_min !== null ? `QIB ≥ ${n(r.sub_qib_min)}x` : null,
    r.anchor_mf_min !== null ? `MFs ≥ ${n(r.anchor_mf_min)}% of anchor` : null,
    r.size_min_cr !== null || r.size_max_cr !== null
      ? `size ${r.size_min_cr !== null ? `₹${n(r.size_min_cr)}` : "any"}–${r.size_max_cr !== null ? `₹${n(r.size_max_cr)}` : "any"} Cr`
      : null,
  ].filter(Boolean);
  if (!parts.length) return "no alerts set";
  return parts.join(r.match_mode === "any" ? " or " : " and ");
}

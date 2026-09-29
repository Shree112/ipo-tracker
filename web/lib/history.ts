import { unstable_cache } from "next/cache";
import { db, within } from "./db";
import { toISODate } from "./format";
import type { Rules } from "./queries";

// Past mainboard IPOs with the GMP the day before bidding opened and where the
// stock actually opened on listing day. Drives the public track record page
// and the "how would this rule have done" numbers on the presets.

export type Past = {
  id: number;
  slug: string;
  name: string;
  listing_date: string;
  gmp: number; // % of the upper band, day before opening
  gain: number; // % listing gain at the open
  size: number | null; // ₹ crore
  profit: number | null; // ₹ per lot implied by the GMP
};

// Changes only when an issue lists, so an hour in Next's data cache is plenty.
export const pastIssues = unstable_cache(
  async (): Promise<Past[]> => {
    const rows = await within(
      db()<(Omit<Past, "listing_date"> & { listing_date: Date })[]>`
      SELECT i.id, i.slug, i.name, c.listing_date, c.predicted_gain_pct AS gmp, c.actual_gain_pct AS gain,
             i.issue_size_cr AS size,
             CASE WHEN i.price_band_high IS NOT NULL AND i.lot_size IS NOT NULL
                  THEN c.predicted_gain_pct / 100.0 * i.price_band_high * i.lot_size END AS profit
      FROM calibration c JOIN issues i ON i.id = c.issue_id
      WHERE c.phase = 't_minus_1' AND c.price_basis = 'open' AND i.board = 'mainboard'
        AND c.predicted_gain_pct IS NOT NULL AND c.actual_gain_pct IS NOT NULL
        AND c.listing_date >= DATE '2023-01-01'
      ORDER BY c.listing_date DESC`, 12000, "track record");
    return rows.map((r) => ({ ...r, id: Number(r.id), listing_date: toISODate(r.listing_date)! }));
  },
  ["past-issues-v1"],
  { revalidate: 3600, tags: ["history"] },
);

export type Stats = { n: number; up: number; median: number | null; mean: number | null };

export function stats(rows: Past[]): Stats {
  if (!rows.length) return { n: 0, up: 0, median: null, mean: null };
  const g = rows.map((r) => r.gain).sort((a, b) => a - b);
  const mid = g.length >> 1;
  const median = g.length % 2 ? g[mid] : (g[mid - 1] + g[mid]) / 2;
  return {
    n: rows.length,
    up: (100 * rows.filter((r) => r.gain > 0).length) / rows.length,
    median,
    mean: g.reduce((a, b) => a + b, 0) / g.length,
  };
}

/** Rules that can be tested on history: GMP, profit per lot and size. Subscription
 *  and anchor data only exist for recent issues, so rules using them return null. */
export function backtest(rows: Past[], r: Partial<Rules>): Stats | null {
  if (r.sub_total_min != null || r.sub_retail_min != null || r.sub_qib_min != null || r.anchor_mf_min != null) return null;
  const checks: ((p: Past) => boolean)[] = [];
  if (r.gmp_pct_min != null) checks.push((p) => p.gmp >= r.gmp_pct_min!);
  if (r.profit_per_lot_min != null) checks.push((p) => p.profit != null && p.profit >= r.profit_per_lot_min!);
  if (r.size_min_cr != null) checks.push((p) => p.size != null && p.size >= r.size_min_cr!);
  if (r.size_max_cr != null) checks.push((p) => p.size != null && p.size <= r.size_max_cr!);
  if (!checks.length) return null;
  const any = r.match_mode === "any";
  return stats(rows.filter((p) => (any ? checks.some((c) => c(p)) : checks.every((c) => c(p)))));
}

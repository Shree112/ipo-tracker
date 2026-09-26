"""Backfill day-wise GMP history from IPO Watch.

    python scripts\\backfill_gmp.py               # all ~325 issues IPO Watch lists
    python scripts\\backfill_gmp.py --limit 10    # a trial run first
    python scripts\\backfill_gmp.py --use-cache   # re-parse saved pages, no fetching

Run backfill_listings.py first - this attaches GMP to issues already in the
database and never creates new ones. REITs / InvITs and anything outside the
Chittorgarh backfill are skipped and listed.

Per issue it writes:
  issues           open/close dates and price band (only where blank), ipowatch_url
  gmp_history      every dated row, source='ipowatch', capture_mode='backfill',
                   observed_precision='day' (observed_at = noon IST)
  signal_snapshot  phase='t_minus_1' - the last quoted GMP dated before the
                   open date, and never a later one

About 330 requests at 2.5s apart: ~15 minutes the first time. Pages are
cached, so --use-cache reruns are instant.
"""
from __future__ import annotations

import argparse
import difflib
import json
import sys
from datetime import datetime, time, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402
from sources import base  # noqa: E402
from sources import ipowatch as iw  # noqa: E402

STALE_DAYS = 7  # a "T-1" reading older than this is not a T-1 reading


def load_issues(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT i.id, i.slug, i.name, i.listing_date, i.issue_price,
                      o.listing_open
               FROM issues i LEFT JOIN listing_outcome o ON o.issue_id = i.id
               WHERE i.issue_price IS NOT NULL"""
        )
        return cur.fetchall()


def match(perf: dict, info: dict, issues: list[dict]) -> dict | None:
    """Same issue price, listing date within 3 days; name breaks ties.

    Price + listing date is close to unique on its own, and unlike the name
    it survives brand-vs-legal-name differences (Groww vs Billionbrains
    Garage Ventures, FirstCry vs Brainbees Solutions).
    """
    price = perf["issue_price"]
    ld = info.get("listing_date")
    if not price:
        return None
    cands = [i for i in issues if abs(float(i["issue_price"]) - price) < 0.51]
    if ld:
        dated = [i for i in cands if i["listing_date"] and abs((i["listing_date"] - ld).days) <= 3]
        if dated:
            cands = dated
        else:
            return None
    if not cands:
        return None
    slug = base.slugify(perf["name"])
    scored = sorted(cands, key=lambda i: name_score(slug, i["slug"]), reverse=True)
    if ld:
        return scored[0]
    # No listing date means price alone would decide - and a price like 350
    # recurs across years (it once paired Aadhar Housing with Route Mobile).
    # Without a date, the name has to agree too.
    return scored[0] if name_score(slug, scored[0]["slug"]) >= 0.6 else None


def name_score(a: str, b: str) -> float:
    """Similarity, with short brand names that prefix the legal name
    ('ecos-mobility' vs 'ecos-india-mobility-hospitality') scored as matches."""
    ta, tb = a.split("-"), b.split("-")
    if ta and tb and ta[0] == tb[0] and set(ta) <= set(tb):
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def ist_midnight(d):
    return datetime.combine(d, time(0, 0), tzinfo=iw.IST)


def ist_noon(d):
    # Day-precision rows sit at noon IST so that ::date gives the right day
    # whether a query runs in UTC or IST. Midnight IST is 18:30 UTC the day
    # before, which silently shifts every date by one in a UTC session.
    return datetime.combine(d, time(12, 0), tzinfo=iw.IST)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--use-cache", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    perf = iw.fetch_live(use_cache=args.use_cache)
    if args.limit:
        perf = perf[: args.limit]
    print(f"IPO Watch lists {len(perf)} mainboard issues\n")

    unmatched, failed, stale, no_t1, listing_off = [], [], [], [], []
    written_rows = snapshots = matched = 0
    gmp_check = [0, 0]      # site's final GMP == last row of the day-wise table
    listing_check = [0, 0]  # IPO Watch listing price == our listing-day open

    with db.connect() as conn, db.RunLog(conn, "ipowatch-gmp-backfill") as log:
        issues = load_issues(conn)
        for n, p in enumerate(perf, 1):
            log.seen += 1
            try:
                url, info = iw.fetch_gmp(p["overview_url"], use_cache=args.use_cache)
            except (iw.ParseError, base.FetchError) as exc:
                failed.append((p["name"], str(exc)[:80]))
                continue

            issue = match(p, info, issues)
            if issue is None:
                unmatched.append(p["name"])
                continue
            matched += 1

            rows = info["rows"]
            quoted = [r for r in rows if r["gmp_amount"] is not None]
            if quoted and p["final_gmp"] is not None:
                gmp_check[0] += 1
                gmp_check[1] += quoted[-1]["gmp_amount"] == p["final_gmp"]
            if p["listing_price"] and issue["listing_open"]:
                # 3% tolerance: IPO Watch sometimes quotes the BSE open where
                # Chittorgarh has NSE's (350 vs 351). A wrong match misses by
                # far more than that.
                listing_check[0] += 1
                ours = float(issue["listing_open"])
                if abs(ours - p["listing_price"]) <= 0.03 * ours:
                    listing_check[1] += 1
                else:
                    listing_off.append(f"{p['name']} ({p['listing_price']:g} vs {ours:g})")

            db.upsert_issue(
                conn, slug=issue["slug"], name=issue["name"],
                open_date=info.get("open_date"), close_date=info.get("close_date"),
                price_band_low=info.get("price_band_low"),
                price_band_high=info.get("price_band_high"),
                ipowatch_url=url,
            )

            upper = info.get("price_band_high") or float(issue["issue_price"])
            with conn.cursor() as cur:
                for r in rows:
                    g = r["gmp_amount"]
                    cur.execute(
                        """INSERT INTO gmp_history
                             (issue_id, source, observed_at, gmp_amount, gmp_pct,
                              est_listing_price, raw, capture_mode, observed_precision)
                           VALUES (%s,'ipowatch',%s,%s,%s,%s,%s,'backfill','day')
                           ON CONFLICT (issue_id, source, observed_at) DO NOTHING""",
                        (
                            issue["id"], ist_noon(r["gmp_date"]), g,
                            round(g / upper * 100, 3) if g is not None else None,
                            upper + g if g is not None else None,
                            json.dumps({"row": r["raw"], "kostak": r["kostak"],
                                        "subject_to": r["subject_to"], "url": url}),
                        ),
                    )
                    written_rows += cur.rowcount

                t1 = iw.t_minus_1(info)
                if t1 is None:
                    no_t1.append(p["name"])
                elif (info["open_date"] - t1["gmp_date"]).days > STALE_DAYS:
                    stale.append(p["name"])
                else:
                    cur.execute(
                        """INSERT INTO signal_snapshot (issue_id, phase, taken_at, gmp_amount, gmp_pct, extras)
                           VALUES (%s,'t_minus_1',%s,%s,%s,%s)
                           ON CONFLICT (issue_id, phase) DO NOTHING""",
                        (
                            issue["id"], ist_midnight(t1["gmp_date"]) + timedelta(hours=23, minutes=59),
                            t1["gmp_amount"], round(t1["gmp_amount"] / upper * 100, 3),
                            json.dumps({"source": "ipowatch-backfill",
                                        "gmp_date": t1["gmp_date"].isoformat(),
                                        "days_before_open": (info["open_date"] - t1["gmp_date"]).days,
                                        "pct_base": "price_band_high"}),
                        ),
                    )
                    snapshots += cur.rowcount

            if n % 25 == 0:
                print(f"  {n}/{len(perf)}  matched {matched}")
        log.written = written_rows

    print(f"\nmatched {matched}/{len(perf)}  gmp rows written {written_rows}  "
          f"T-1 snapshots written {snapshots}")
    print(f"info:  IPO Watch's summary GMP = last row of its own day-wise table on "
          f"{gmp_check[1]}/{gmp_check[0]} (a later listing-morning update explains most gaps)")
    print(f"guard: IPO Watch listing price within 3% of our listing-day open on "
          f"{listing_check[1]}/{listing_check[0]}"
          + ("   <-- CHECK MATCHING" if listing_check[0] and listing_check[1] < 0.9 * listing_check[0] else ""))
    if listing_off:
        print(f"\nlisting price off by >3% ({len(listing_off)}) - check these are the right issue: "
              + "; ".join(listing_off[:20]))
    if failed:
        print(f"\nno GMP page ({len(failed)}): " + "; ".join(f"{a} [{b}]" for a, b in failed[:15]))
    if unmatched:
        print(f"\nnot in our issues ({len(unmatched)}, REIT/InvIT expected): " + ", ".join(unmatched[:40]))
    if no_t1:
        print(f"\nno GMP quoted before open ({len(no_t1)}): " + ", ".join(no_t1[:20]))
    if stale:
        print(f"\nlast pre-open GMP older than {STALE_DAYS} days, skipped ({len(stale)}): " + ", ".join(stale[:20]))

    report()


def report() -> None:
    """Read back through the calibration view - the same path the app will use."""
    base_sql = """FROM calibration
                  WHERE phase = 't_minus_1' AND price_basis = 'open'
                    AND predicted_gain_pct IS NOT NULL"""
    s = db.fetch_one(f"""SELECT count(*) n,
                            round(corr(predicted_gain_pct, actual_gain_pct)::numeric, 3) r,
                            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY error_pct)::numeric, 2) med_err,
                            round(avg(abs(error_pct))::numeric, 2) mae
                         {base_sql}""")
    print("\n--- T-1 GMP vs listing-day open (IPO Watch backfill) ---")
    print(f"issues {s['n']}   correlation {s['r']}   median (actual - GMP) {s['med_err']} pts"
          f"   mean abs error {s['mae']} pts")

    rows = db.fetch_all(f"""
        SELECT CASE WHEN predicted_gain_pct <  0 THEN '1  below 0%'
                    WHEN predicted_gain_pct <  5 THEN '2  0-5%'
                    WHEN predicted_gain_pct < 10 THEN '3  5-10%'
                    WHEN predicted_gain_pct < 20 THEN '4  10-20%'
                    WHEN predicted_gain_pct < 40 THEN '5  20-40%'
                    ELSE '6  40%+' END AS band,
               count(*) n,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY actual_gain_pct)::numeric, 2) med_gain,
               round(100.0 * avg((actual_gain_pct > 0)::int), 1) pct_pos,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY error_pct)::numeric, 2) med_err
        {base_sql} GROUP BY 1 ORDER BY 1""")
    print(f"\n{'T-1 GMP':<12}{'n':>5}{'median open gain':>19}{'opened +':>10}{'median error':>14}")
    for r in rows:
        print(f"{r['band'][3:]:<12}{r['n']:>5}{r['med_gain']:>18}%{r['pct_pos']:>9}%{r['med_err']:>13}")

    t = db.fetch_all(f"""
        SELECT (predicted_gain_pct > 10) AS alerted, count(*) n,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY actual_gain_pct)::numeric, 2) med_gain,
               round(100.0 * avg((actual_gain_pct > 0)::int), 1) pct_pos
        {base_sql} GROUP BY 1 ORDER BY 1 DESC""")
    print("\nyour 10% trigger, applied to history:")
    for r in t:
        label = "would have mailed" if r["alerted"] else "stayed quiet     "
        print(f"  {label}  {r['n']:>4} issues   median open {r['med_gain']}%   opened positive {r['pct_pos']}%")


if __name__ == "__main__":
    main()

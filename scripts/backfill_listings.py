"""Backfill listing outcomes and final subscription from Chittorgarh.

    python scripts\\backfill_listings.py              # BACKFILL_YEAR_FROM..TO from .env
    python scripts\\backfill_listings.py 2019 2026    # explicit range
    python scripts\\backfill_listings.py --use-cache  # re-parse saved HTML, no fetching

Writes three things per issue:
  issues            identity, listing date, issue price, the Chittorgarh link
  listing_outcome   open and close, with price_basis recording which is headline
  signal_snapshot   phase='close_day', carrying final QIB/NII/RII subscription

That last one matters: it means the signal side of the calibration set
backfills too, not just the outcome side. Subscription-vs-listing-gain can be
tested on years of history immediately, without waiting for live GMP to
accumulate.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import requests  # noqa: E402

import config  # noqa: E402
import db  # noqa: E402
from sources import chittorgarh as cg  # noqa: E402


def load_year(conn, year: int, *, session, use_cache: bool, log: db.RunLog) -> dict:
    records, counts = cg.fetch_year(year, session=session, use_cache=use_cache)
    log.seen += counts["seen"]

    # Guard rail. The site publishes its own close-basis listing gain; if our
    # arithmetic disagrees, we are pairing the wrong issue price with the
    # listing-day prices - which is exactly how the split-adjusted column
    # slipped in the first time. Loud, per year, every run.
    checked = mismatched = 0
    for r in records:
        if r["listing_close"] and r["site_listing_gain_close_pct"] is not None:
            checked += 1
            mine = (r["listing_close"] - r["issue_price"]) / r["issue_price"] * 100
            if abs(mine - r["site_listing_gain_close_pct"]) > 0.06:
                mismatched += 1
    counts["checked"] = checked
    counts["mismatched"] = mismatched

    written = 0
    for r in records:
        issue_id = db.upsert_issue(
            conn,
            slug=r["slug"],
            name=r["name"],
            board="mainboard",
            issue_type=r["issue_type"],
            exchanges=r["exchanges"],
            chittorgarh_id=r["chittorgarh_id"],
            chittorgarh_url=r["chittorgarh_url"],
            listing_date=r["listing_date"],
            issue_price=r["issue_price"],
            issue_size_cr=r["issue_size_cr"],
        )

        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO listing_outcome (
                    issue_id, listing_date, issue_price, listing_open, listing_close,
                    listing_low, listing_high, price_basis, headline_price, source
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'chittorgarh')
                ON CONFLICT (issue_id) DO UPDATE SET
                    issue_price    = EXCLUDED.issue_price,
                    source         = EXCLUDED.source,
                    listing_date   = EXCLUDED.listing_date,
                    listing_open   = EXCLUDED.listing_open,
                    listing_close  = EXCLUDED.listing_close,
                    listing_low    = EXCLUDED.listing_low,
                    listing_high   = EXCLUDED.listing_high,
                    price_basis    = EXCLUDED.price_basis,
                    headline_price = EXCLUDED.headline_price,
                    captured_at    = now()
                """,
                (
                    issue_id, r["listing_date"], r["issue_price"],
                    r["listing_open"], r["listing_close"],
                    r["listing_low"], r["listing_high"],
                    r["price_basis"], r["headline_price"],
                ),
            )

            # signal_snapshot is append-only, so re-runs must not try to update
            if r["sub_total_x"] is not None:
                cur.execute(
                    """
                    INSERT INTO signal_snapshot (
                        issue_id, phase, sub_qib_x, sub_nii_x, sub_rii_x, sub_total_x, extras
                    ) VALUES (%s,'close_day',%s,%s,%s,%s,%s)
                    ON CONFLICT (issue_id, phase) DO NOTHING
                    """,
                    (
                        issue_id, r["sub_qib_x"], r["sub_nii_x"],
                        r["sub_rii_x"], r["sub_total_x"],
                        '{"source":"chittorgarh-backfill","note":"final subscription, no GMP"}',
                    ),
                )
        written += 1

    log.written += written
    counts["written"] = written
    return counts


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    use_cache = "--use-cache" in sys.argv

    y_from = int(args[0]) if len(args) > 0 else config.BACKFILL_YEAR_FROM
    y_to = int(args[1]) if len(args) > 1 else config.BACKFILL_YEAR_TO

    print(f"backfilling {y_from}..{y_to}" + ("  (cached HTML only)" if use_cache else ""))
    session = requests.Session()

    with db.connect() as conn, db.RunLog(conn, "chittorgarh-perf") as log:
        for year in cg.iter_years(y_from, y_to):
            try:
                c = load_year(conn, year, session=session, use_cache=use_cache, log=log)
            except Exception as exc:
                print(f"  {year}  FAILED  {type(exc).__name__}: {exc}")
                continue
            flag = "  <-- CHECK" if c["mismatched"] else ""
            print(
                f"  {year}  seen={c['seen']:>4}  "
                f"skipped(non-IPO)={c['skipped_type']:>3}  "
                f"written={c['written']:>4}  "
                f"gain-check {c['checked']-c['mismatched']}/{c['checked']}{flag}"
            )

    # Read-back guard. The per-row check above validates what we parsed; this
    # validates what is actually stored. The first re-run passed 468/468 in
    # memory while the table still held stale issue prices, because the upsert
    # never updated that column - this is the check that would have caught it.
    drift = db.fetch_one(
        """
        SELECT count(*) AS n
        FROM listing_outcome o JOIN issues i ON i.id = o.issue_id
        WHERE o.issue_price IS DISTINCT FROM i.issue_price
        """
    )
    if drift and drift["n"]:
        print(f"\n  !! {drift['n']} rows where listing_outcome.issue_price != issues.issue_price")
    else:
        print("\n  read-back: listing_outcome and issues agree on every issue price")

    print("\n--- what landed ---")
    for row in db.fetch_all(
        """
        SELECT price_basis,
               count(*)                                                    AS issues,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY listing_gain_pct)::numeric, 2) AS median_gain,
               round(avg(listing_gain_pct), 2)                             AS avg_gain,
               round(100.0 * avg((listing_gain_pct > 0)::int), 1)          AS pct_positive
        FROM listing_outcome GROUP BY price_basis ORDER BY price_basis
        """
    ):
        print(
            f"  basis={row['price_basis']:<6} n={row['issues']:>4}  "
            f"median={row['median_gain']:>7}%  mean={row['avg_gain']:>7}%  "
            f"positive={row['pct_positive']}%"
        )

    both = db.fetch_one(
        """
        SELECT count(*) AS n,
               round(avg(((listing_close - issue_price) - (listing_open - issue_price))
                         / issue_price * 100), 2) AS mean_gap_pp,
               count(*) FILTER (
                   WHERE abs((listing_close - listing_open) / issue_price * 100) >= 5
               ) AS big_gap
        FROM listing_outcome
        WHERE listing_open IS NOT NULL AND listing_close IS NOT NULL
        """
    )
    if both and both["n"]:
        print(
            f"\n  open vs close: n={both['n']}, mean gap {both['mean_gap_pp']:+}pp, "
            f"{both['big_gap']} issues differ by 5pp or more"
        )
        print("  (this is why price_basis exists - the two are not interchangeable)")


if __name__ == "__main__":
    main()

"""The daily live job: calendar + GMP, then freeze any T-1 snapshots due.

    python scripts\\run_live.py            # fetch, write, print today's board
    python scripts\\run_live.py --dry-run  # fetch and print only, no database

Meant to run twice a day (early morning for the 8am digest, and evening so
the last GMP before an open date is captured). Safe to run more often:
InvestorGain readings are keyed on the site's own update time, so re-reading
an unchanged GMP writes nothing.

Three steps, each logged separately in scrape_run so one source failing is
visible and doesn't stop the others:

  1. InvestorGain  live report -> each issue's page -> issues (calendar
                   fields, mainboard only) + gmp_history (source investorgain)
  2. IPO Watch     live mainboard table -> gmp_history (source ipowatch),
                   matched onto issues by window + name/price
  3. T-1 freeze    for issues that have opened in the last 3 days and have no
                   t_minus_1 snapshot: the latest GMP observed BEFORE the open
                   date, InvestorGain first, IPO Watch as fallback. Same rule
                   as the backfill, so live and historical rows compare.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, time, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sources import base  # noqa: E402
from sources import investorgain as ig  # noqa: E402
from sources import ipowatch as iw  # noqa: E402

TRIGGER_PCT = 10.0


def today_ist() -> date:
    return datetime.now(iw.IST).date()


def ist_start(d: date) -> datetime:
    return datetime.combine(d, time(0, 0), tzinfo=iw.IST)


# ---------------------------------------------------------------- fetch

def fetch_investorgain(use_cache: bool) -> tuple[list[dict], list[str]]:
    """Mainboard issues from the live report, with their pages parsed."""
    issues, problems = [], []
    for item in ig.fetch_live(use_cache=use_cache):
        try:
            rec = ig.fetch_issue(item["url"], use_cache=use_cache)
        except (ig.ParseError, base.FetchError, ValueError) as exc:
            problems.append(f"{item['name']}: {str(exc)[:80]}")
            continue
        if rec["mainboard"] and not rec["withdrawn"]:
            issues.append(rec)
    return issues, problems


def match_ipowatch(row: dict, issues: list[dict]) -> dict | None:
    """Same subscription window (+/- 2 days) and the name or price agrees."""
    if not row["open_date"]:
        return None
    slug = base.slugify(row["name"])
    best, best_score = None, 0.0
    for i in issues:
        if not i.get("open_date") or abs((i["open_date"] - row["open_date"]).days) > 2:
            continue
        name = base.name_score(slug, base.slugify(i["name"]))
        price_ok = bool(row["price_band_high"] and i.get("price_band_high")
                        and abs(float(i["price_band_high"]) - row["price_band_high"]) < 0.51)
        if name < 0.6 and not price_ok:
            continue
        score = name + (0.5 if price_ok else 0.0)
        if score > best_score:
            best, best_score = i, score
    return best


# ---------------------------------------------------------------- write

def resolve_slug(conn, rec: dict) -> str:
    """Reuse the existing row for this issue if either site id already knows
    it - a new slug would create a duplicate of a backfilled issue."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT slug FROM issues WHERE (chittorgarh_id = %s AND %s IS NOT NULL) "
            "OR investorgain_id = %s LIMIT 1",
            (rec["cor_id"], rec["cor_id"], rec["ig_id"]),
        )
        row = cur.fetchone()
    return row["slug"] if row else base.slugify(rec["name"])


def write_investorgain(conn, issues: list[dict], log) -> dict[int, int]:
    """-> {investorgain_id: issue_id}"""
    import db

    fetched_at = datetime.now(iw.IST)
    ids = {}
    for rec in issues:
        log.seen += 1
        issue_id = db.upsert_issue(
            conn, slug=resolve_slug(conn, rec), name=rec["name"], board="mainboard",
            issue_type=rec["issue_type"] or None, exchanges=rec["exchanges"],
            chittorgarh_id=rec["cor_id"], investorgain_id=rec["ig_id"], investorgain_url=rec["url"],
            open_date=rec["open_date"], close_date=rec["close_date"], anchor_date=rec["anchor_date"],
            listing_date=rec["listing_date"], price_band_low=rec["price_band_low"],
            price_band_high=rec["price_band_high"], lot_size=rec["lot_size"],
            min_order_amount=rec["min_order_amount"], issue_size_cr=rec["issue_size_cr"],
            fresh_issue_cr=rec["fresh_issue_cr"], ofs_cr=rec["ofs_cr"],
            rhp_url=rec["rhp_url"], anchor_report_url=rec["anchor_report_url"],
            nse_symbol=rec["nse_symbol"], bse_code=rec["bse_code"],
            site_status=rec["site_status"], withdrawn=rec["withdrawn"],
        )
        ids[rec["ig_id"]] = issue_id
        log.written += 1  # the issue row itself; 'empty' should mean no issues found
        with conn.cursor() as cur:
            for g in rec["gmp"]:
                # A reading more than a day and a half old when we first see it
                # was read after the fact - label it honestly.
                mode = "live" if fetched_at - g["observed_at"] <= timedelta(hours=36) else "backfill"
                cur.execute(
                    """INSERT INTO gmp_history (issue_id, source, observed_at, gmp_amount, gmp_pct,
                                                est_listing_price, raw, capture_mode, observed_precision)
                       VALUES (%s,'investorgain',%s,%s,%s,%s,%s,%s,'minute')
                       ON CONFLICT (issue_id, source, observed_at) DO NOTHING""",
                    (issue_id, g["observed_at"], g["gmp_amount"], g["gmp_pct"], g["est_listing_price"],
                     json.dumps({**g["raw"], "fetched_at": fetched_at.isoformat()}), mode),
                )
                log.written += cur.rowcount
                log.gmp_new = getattr(log, "gmp_new", 0) + cur.rowcount
    return ids


def write_ipowatch(conn, rows: list[dict], issues: list[dict], log) -> list[str]:
    fetched_at = datetime.now(iw.IST).replace(second=0, microsecond=0)
    unmatched = []
    for r in rows:
        log.seen += 1
        issue = match_ipowatch(r, issues)
        if issue is None:
            unmatched.append(r["name"])
            continue
        upper = r["price_band_high"] or issue.get("price_band_high")
        g = r["gmp_amount"]
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO gmp_history (issue_id, source, observed_at, gmp_amount, gmp_pct,
                                            est_listing_price, raw, capture_mode, observed_precision)
                   VALUES (%s,'ipowatch',%s,%s,%s,%s,%s,'live','minute')
                   ON CONFLICT (issue_id, source, observed_at) DO NOTHING""",
                (issue["issue_id"], fetched_at, g,
                 round(g / float(upper) * 100, 3) if g is not None and upper else None,
                 float(upper) + g if g is not None and upper else None,
                 json.dumps({"row": r["raw"], "status": r["status"], "url": r["overview_url"]})),
            )
            log.written += cur.rowcount
            cur.execute("UPDATE issues SET ipowatch_url = COALESCE(ipowatch_url, %s) WHERE id = %s",
                        (r["gmp_url"], issue["issue_id"]))
    return unmatched


def freeze_t_minus_1(conn, today: date) -> list[str]:
    """Write the T-1 snapshot for issues that opened in the last three days."""
    frozen = []
    with conn.cursor() as cur:
        cur.execute(
            """SELECT i.id, i.name, i.open_date FROM issues i
               WHERE i.board = 'mainboard' AND i.open_date BETWEEN %s AND %s
                 AND NOT EXISTS (SELECT 1 FROM signal_snapshot s
                                 WHERE s.issue_id = i.id AND s.phase = 't_minus_1')""",
            (today - timedelta(days=3), today),
        )
        for issue in cur.fetchall():
            cur.execute(
                """SELECT DISTINCT ON (source) source, observed_at, gmp_amount, gmp_pct, capture_mode
                   FROM gmp_history
                   WHERE issue_id = %s AND observed_at < %s AND gmp_amount IS NOT NULL
                   ORDER BY source, observed_at DESC""",
                (issue["id"], ist_start(issue["open_date"])),
            )
            latest = {r["source"]: r for r in cur.fetchall()}
            pick = latest.get("investorgain") or latest.get("ipowatch")
            if not pick:
                frozen.append(f"{issue['name']}: NO GMP observed before open - snapshot skipped")
                continue
            cur.execute(
                """INSERT INTO signal_snapshot (issue_id, phase, taken_at, gmp_amount, gmp_pct, extras)
                   VALUES (%s,'t_minus_1', now(), %s, %s, %s)
                   ON CONFLICT (issue_id, phase) DO NOTHING""",
                (issue["id"], pick["gmp_amount"], pick["gmp_pct"], json.dumps({
                    "source": f"{pick['source']}-live",
                    "observed_at": pick["observed_at"].isoformat(),
                    "capture_mode": pick["capture_mode"],
                    "by_source": {s: {"gmp_amount": float(r["gmp_amount"]),
                                      "gmp_pct": float(r["gmp_pct"]) if r["gmp_pct"] is not None else None,
                                      "observed_at": r["observed_at"].isoformat()}
                                  for s, r in latest.items()},
                })),
            )
            if cur.rowcount:
                frozen.append(f"{issue['name']}: {pick['gmp_pct']}% ({pick['source']}, "
                              f"{pick['observed_at'].astimezone(iw.IST):%d %b %H:%M})")
    return frozen


# ---------------------------------------------------------------- report

def stage(i: dict, today: date) -> str:
    od, cd = i.get("open_date"), i.get("close_date")
    if not od:
        return "dates tba"
    if today < od - timedelta(days=1):
        return f"opens {od:%d %b}"
    if today == od - timedelta(days=1):
        return "opens tomorrow"
    if cd and today <= cd:
        return "closes today" if today == cd else "open"
    return "closed"


def board(issues: list[dict], iw_rows: list[dict], today: date) -> None:
    by_issue = {}
    for r in iw_rows:
        m = match_ipowatch(r, issues)
        if m is not None:
            by_issue[id(m)] = r
    live = [i for i in issues if i.get("close_date") is None or i["close_date"] >= today - timedelta(days=1)]
    live.sort(key=lambda i: (i.get("open_date") or date.max))
    print(f"\n--- mainboard board, {today:%a %d %b %Y} (IST) ---")
    print(f"{'issue':<30}{'window':<16}{'upper':>8}{'1 lot':>10}{'IG GMP':>9}{'IW GMP':>9}  stage / digest")
    for i in live:
        ig_g = i["gmp"][-1] if i.get("gmp") else None
        iw_r = by_issue.get(id(i))
        iw_pct = (round(iw_r["gmp_amount"] / i["price_band_high"] * 100, 1)
                  if iw_r and iw_r["gmp_amount"] is not None and i.get("price_band_high") else None)
        now_pcts = [p for p in ((ig_g or {}).get("gmp_pct"), iw_pct) if p is not None]
        st = stage(i, today)
        in_window = st in ("opens tomorrow", "open", "closes today")
        # Entry is evaluated from T-1 onwards and is sticky: an issue that
        # crossed 10% at any reading since T-1 stays in the digest even if
        # the GMP has since fallen - that fall is exactly what you want to see.
        since = ist_start(i["open_date"] - timedelta(days=1)) if i.get("open_date") else None
        crossed = [g["gmp_pct"] for g in i.get("gmp", [])
                   if since and g["observed_at"] >= since and g["gmp_pct"] is not None]
        peak = max(crossed + now_pcts, default=None)
        flag = ""
        if in_window and peak is not None and peak > TRIGGER_PCT:
            now = max(now_pcts, default=None)
            flag = ("  <- DIGEST" if now is not None and now > TRIGGER_PCT
                    else f"  <- DIGEST (sticky: peaked {peak:.1f}%, now below 10%)")
        win = f"{i['open_date']:%d %b}-{i['close_date']:%d %b}" if i.get("open_date") and i.get("close_date") else "-"
        fmt = lambda p: f"{p:.1f}%" if p is not None else "-"
        print(f"{i['name'][:29]:<30}{win:<16}{(i.get('price_band_high') or 0):>8.0f}"
              f"{(i.get('min_order_amount') or 0):>10.0f}{fmt((ig_g or {}).get('gmp_pct')):>9}{fmt(iw_pct):>9}  {st}{flag}")


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="fetch and print, no database")
    ap.add_argument("--use-cache", action="store_true", help="reuse saved pages (testing only)")
    args = ap.parse_args()
    today = today_ist()

    ig_issues, ig_problems = fetch_investorgain(args.use_cache)
    print(f"InvestorGain: {len(ig_issues)} live mainboard issues")
    for p in ig_problems:
        print(f"  could not read: {p}")
    try:
        iw_rows = iw.parse_live(base.get(iw.LIVE_URL, use_cache=args.use_cache), today)
        print(f"IPO Watch:    {len(iw_rows)} rows in the live mainboard table")
    except (iw.ParseError, base.FetchError) as exc:
        iw_rows = []
        print(f"IPO Watch:    FAILED - {exc}")

    if not args.dry_run:
        import db

        with db.connect() as conn:
            with db.RunLog(conn, "investorgain-live") as log:
                ids = write_investorgain(conn, ig_issues, log)
                for rec in ig_issues:
                    rec["issue_id"] = ids[rec["ig_id"]]
                print(f"\nupserted {len(ids)} issues, {getattr(log, 'gmp_new', 0)} new InvestorGain GMP readings")
            with db.RunLog(conn, "ipowatch-live") as log:
                unmatched = write_ipowatch(conn, iw_rows, ig_issues, log)
                print(f"wrote {log.written} IPO Watch GMP readings")
                if unmatched:
                    print(f"  IPO Watch rows not matched to an InvestorGain issue: {', '.join(unmatched)}")
            frozen = freeze_t_minus_1(conn, today)
            for f in frozen:
                print(f"T-1 frozen: {f}")

    board(ig_issues, iw_rows, today)


if __name__ == "__main__":
    main()

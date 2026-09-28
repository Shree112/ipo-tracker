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
  2b. Subscription InvestorGain's live subscription report (QIB / SHNI / BHNI /
                   NII / retail / total, times subscribed) -> subscription table,
                   written only when a number moved
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
from sources import anchor as anchor_mod  # noqa: E402

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
        write_detail(conn, issue_id, rec.get("detail"))
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


def write_detail(conn, issue_id: int, d: dict | None) -> None:
    """Upsert the research block. A section that comes back empty keeps the
    previous value rather than wiping it (a page hiccup shouldn't erase an
    anchor book we already have)."""
    if not d:
        return
    summary = anchor_mod.summarise(d.get("anchor"))  # also tags each investor's category
    J = lambda x: json.dumps(x) if x is not None else None
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO issue_detail (issue_id, anchor, anchor_summary, anchor_lockin_30, anchor_lockin_90,
                                         financials, peers, objects, kpis, updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
               ON CONFLICT (issue_id) DO UPDATE SET
                 anchor           = COALESCE(EXCLUDED.anchor, issue_detail.anchor),
                 anchor_summary   = COALESCE(EXCLUDED.anchor_summary, issue_detail.anchor_summary),
                 anchor_lockin_30 = COALESCE(EXCLUDED.anchor_lockin_30, issue_detail.anchor_lockin_30),
                 anchor_lockin_90 = COALESCE(EXCLUDED.anchor_lockin_90, issue_detail.anchor_lockin_90),
                 financials       = COALESCE(EXCLUDED.financials, issue_detail.financials),
                 peers            = COALESCE(EXCLUDED.peers, issue_detail.peers),
                 objects          = COALESCE(EXCLUDED.objects, issue_detail.objects),
                 kpis             = COALESCE(EXCLUDED.kpis, issue_detail.kpis),
                 updated_at       = now()""",
            (issue_id, J(d.get("anchor") if summary else None), J(summary), d.get("anchor_lockin_30"),
             d.get("anchor_lockin_90"), J(d.get("financials")), J(d.get("peers")), J(d.get("objects")),
             J(d.get("kpis"))),
        )


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
            cur.execute("SELECT anchor_summary FROM issue_detail WHERE issue_id = %s", (issue["id"],))
            det = cur.fetchone()
            anc = (det or {}).get("anchor_summary") or {}
            cur.execute(
                """INSERT INTO signal_snapshot (issue_id, phase, taken_at, gmp_amount, gmp_pct,
                                                anchor_total_cr, anchor_mf_pct, anchor_top5_pct, extras)
                   VALUES (%s,'t_minus_1', now(), %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (issue_id, phase) DO NOTHING""",
                (issue["id"], pick["gmp_amount"], pick["gmp_pct"],
                 anc.get("total_cr"), anc.get("mf_pct"), anc.get("top5_pct"), json.dumps({
                    "source": f"{pick['source']}-live",
                    "anchor_by_category_pct": anc.get("by_category_pct"),
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


def write_subscription(conn, subs: list[dict], log) -> int:
    """One row per issue per run - but only when a number actually moved,
    so the table is a clean series of changes rather than repeats."""
    fetched_at = datetime.now(iw.IST).replace(second=0, microsecond=0)
    ids = [s["ig_id"] for s in subs]
    with conn.cursor() as cur:
        cur.execute("SELECT id, investorgain_id FROM issues WHERE investorgain_id = ANY(%s)", (ids,))
        issue_of = {r["investorgain_id"]: r["id"] for r in cur.fetchall()}
        matched = 0
        for s in subs:
            log.seen += 1
            issue_id = issue_of.get(s["ig_id"])
            if issue_id is None:
                continue  # SME, or an issue the GMP report doesn't list
            matched += 1
            if s.get("pe_ratio") is not None:
                cur.execute("UPDATE issues SET pe_ratio = %s WHERE id = %s", (s["pe_ratio"], issue_id))
            cur.execute(
                """SELECT qib_x, nii_x, rii_x, total_x FROM subscription
                   WHERE issue_id = %s AND source = 'investorgain' ORDER BY observed_at DESC LIMIT 1""",
                (issue_id,),
            )
            last = cur.fetchone()
            now = tuple(s.get(k) for k in ("qib_x", "nii_x", "rii_x", "total_x"))
            if last and tuple(None if last[k] is None else float(last[k])
                              for k in ("qib_x", "nii_x", "rii_x", "total_x")) == now:
                continue
            cur.execute(
                """INSERT INTO subscription (issue_id, observed_at, source, qib_x, nii_x, rii_x,
                                             employee_x, total_x, shni_x, bhni_x, raw)
                   VALUES (%s,%s,'investorgain',%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (issue_id, source, observed_at) DO NOTHING""",
                (issue_id, s.get("observed_at") or fetched_at, s.get("qib_x"), s.get("nii_x"), s.get("rii_x"),
                 s.get("employee_x"), s.get("total_x"), s.get("shni_x"), s.get("bhni_x"),
                 json.dumps({**s["raw"], "site_updated": s["site_updated"]})),
            )
            log.written += cur.rowcount
    return matched


def freeze_close_day(conn, today: date) -> list[str]:
    """For issues that closed in the last 3 days: the last subscription and
    GMP readings taken on or before the close date, plus what you decided.
    This is the 'freeze the decision' half of the loop."""
    frozen = []
    with conn.cursor() as cur:
        cur.execute(
            """SELECT i.id, i.name, i.close_date,
                      COALESCE(ust.status, st.status, 'none') AS decision   -- the owner's decision
               FROM issues i LEFT JOIN issue_status st ON st.issue_id = i.id
               LEFT JOIN user_issue_status ust ON ust.issue_id = i.id
                 AND ust.user_id = (SELECT user_id FROM app_users WHERE is_admin ORDER BY created_at LIMIT 1)
               WHERE i.board = 'mainboard' AND i.close_date BETWEEN %s AND %s
                 AND NOT EXISTS (SELECT 1 FROM signal_snapshot s
                                 WHERE s.issue_id = i.id AND s.phase = 'close_day')""",
            (today - timedelta(days=3), today - timedelta(days=1)),
        )
        for issue in cur.fetchall():
            cutoff = ist_start(issue["close_date"] + timedelta(days=1))
            cur.execute(
                """SELECT observed_at, qib_x, nii_x, rii_x, total_x FROM subscription
                   WHERE issue_id = %s AND observed_at < %s ORDER BY observed_at DESC LIMIT 1""",
                (issue["id"], cutoff),
            )
            sub = cur.fetchone()
            # Only a reading taken ON the close date counts as the close-day
            # number; an older one would pass day-1 figures off as final.
            if not sub or sub["observed_at"] < ist_start(issue["close_date"]):
                frozen.append(f"{issue['name']}: no subscription reading on the close date - skipped")
                continue
            cur.execute(
                """SELECT source, observed_at, gmp_amount, gmp_pct FROM gmp_history
                   WHERE issue_id = %s AND observed_at < %s AND gmp_amount IS NOT NULL
                   ORDER BY (source = 'investorgain') DESC, observed_at DESC LIMIT 1""",
                (issue["id"], cutoff),
            )
            gmp = cur.fetchone()
            cur.execute(
                """INSERT INTO signal_snapshot (issue_id, phase, taken_at, gmp_amount, gmp_pct,
                                                sub_qib_x, sub_nii_x, sub_rii_x, sub_total_x, extras)
                   VALUES (%s,'close_day',now(),%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (issue_id, phase) DO NOTHING""",
                (issue["id"], gmp and gmp["gmp_amount"], gmp and gmp["gmp_pct"],
                 sub["qib_x"], sub["nii_x"], sub["rii_x"], sub["total_x"],
                 json.dumps({"source": "live",
                             "subscription_observed_at": sub["observed_at"].isoformat(),
                             "gmp_source": gmp and gmp["source"],
                             "gmp_observed_at": gmp and gmp["observed_at"].isoformat(),
                             "decision": issue["decision"]})),
            )
            if cur.rowcount:
                frozen.append(f"{issue['name']}: {float(sub['total_x'] or 0):.2f}x total, "
                              f"retail {float(sub['rii_x'] or 0):.2f}x, decision {issue['decision']}")
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
    print(f"{'issue':<30}{'window':<16}{'upper':>8}{'1 lot':>10}{'IG GMP':>9}{'IW GMP':>9}{'sub':>8}{'retail':>8}  stage / digest")
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
        fx = lambda x: f"{x:.2f}x" if x is not None else "-"
        print(f"{i['name'][:29]:<30}{win:<16}{(i.get('price_band_high') or 0):>8.0f}"
              f"{(i.get('min_order_amount') or 0):>10.0f}{fmt((ig_g or {}).get('gmp_pct')):>9}{fmt(iw_pct):>9}"
              f"{fx((i.get('sub') or {}).get('total_x')):>8}{fx((i.get('sub') or {}).get('rii_x')):>8}  {st}{flag}")


# ---------------------------------------------------------------- light mode

def live_issues_from_db(conn, today: date) -> list[dict]:
    """Mainboard issues whose window is near today, shaped like the IG records
    the writers expect (issue_id, ig_id, name, open_date, price_band_high)."""
    with conn.cursor() as cur:
        cur.execute(
            """SELECT id AS issue_id, investorgain_id AS ig_id, name, open_date, close_date,
                      price_band_high
               FROM issues
               WHERE board = 'mainboard' AND investorgain_id IS NOT NULL
                 AND open_date BETWEEN %s AND %s""",
            (today - timedelta(days=15), today + timedelta(days=10)),
        )
        rows = cur.fetchall()
    for r in rows:
        if r["price_band_high"] is not None:
            r["price_band_high"] = float(r["price_band_high"])
    return rows


def light_once(conn, today: date) -> str:
    """One cheap refresh: three pages (InvestorGain GMP report, InvestorGain
    subscription report, IPO Watch live table) instead of one page per issue.
    Calendar and research fields are left to the twice-daily full run."""
    import db

    known = live_issues_from_db(conn, today)
    by_ig = {k["ig_id"]: k for k in known}
    now = datetime.now(iw.IST)
    notes = []

    with db.RunLog(conn, "investorgain-light") as log:
        log.ok_if_seen = True
        try:
            rows = ig.fetch_live_gmp()
        except (ig.ParseError, base.FetchError) as exc:
            rows = []
            notes.append(f"GMP report failed: {exc}")
        with conn.cursor() as cur:
            for r in rows:
                k = by_ig.get(r["ig_id"])
                if not k or r["category"] not in ("IPO", "") or r["observed_at"] is None:
                    continue
                log.seen += 1
                mode = "live" if now - r["observed_at"] <= timedelta(hours=36) else "backfill"
                cur.execute(
                    """INSERT INTO gmp_history (issue_id, source, observed_at, gmp_amount, gmp_pct,
                                                est_listing_price, raw, capture_mode, observed_precision)
                       VALUES (%s,'investorgain',%s,%s,%s,%s,%s,%s,'minute')
                       ON CONFLICT (issue_id, source, observed_at) DO NOTHING""",
                    (k["issue_id"], r["observed_at"], r["gmp_amount"], r["gmp_pct"],
                     (r["price"] + r["gmp_amount"]) if r["price"] and r["gmp_amount"] is not None else None,
                     json.dumps({**r["raw"], "via": "live-report", "fetched_at": now.isoformat()}), mode),
                )
                log.written += cur.rowcount
        notes.append(f"GMP {log.written} new")

    with db.RunLog(conn, "investorgain-subscription") as log:
        log.ok_if_seen = True
        try:
            subs = ig.fetch_subscription()
        except (ig.ParseError, base.FetchError) as exc:
            subs = []
            notes.append(f"subscription failed: {exc}")
        write_subscription(conn, subs, log)
        notes.append(f"subscription {log.written} new")

    with db.RunLog(conn, "ipowatch-live") as log:
        log.ok_if_seen = True
        try:
            iw_rows = iw.parse_live(base.get(iw.LIVE_URL), today)
        except (iw.ParseError, base.FetchError) as exc:
            iw_rows = []
            notes.append(f"IPO Watch failed: {exc}")
        write_ipowatch(conn, iw_rows, known, log)
        notes.append(f"IPO Watch {log.written} new")

    frozen = [f for f in freeze_t_minus_1(conn, today) + freeze_close_day(conn, today) if "skipped" not in f]
    if frozen:
        notes.append(f"{len(frozen)} snapshot(s) frozen")
    return " · ".join(notes)


def closing_today(conn, today: date) -> list[str]:
    with conn.cursor() as cur:
        cur.execute("SELECT name FROM issues WHERE board = 'mainboard' AND close_date = %s", (today,))
        return [r["name"] for r in cur.fetchall()]


def run_light(loop_every: int | None, until: str | None, only_if_closing: bool) -> None:
    import time as _time
    import db

    today = today_ist()
    stop = None
    if until:
        hh, mm = (int(x) for x in until.split(":"))
        stop = datetime.combine(today, time(hh, mm), tzinfo=iw.IST)
    with db.connect() as conn:
        if only_if_closing:
            names = closing_today(conn, today)
            if not names:
                print("no mainboard issue closes today - nothing to do")
                return
            print(f"closing today: {', '.join(names)}")
    while True:
        with db.connect() as conn:  # fresh connection per pass: the pooler drops idle ones
            print(f"{datetime.now(iw.IST):%H:%M} {light_once(conn, today)}", flush=True)
        if not loop_every or (stop and datetime.now(iw.IST) + timedelta(minutes=loop_every) > stop):
            break
        _time.sleep(loop_every * 60)


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="fetch and print, no database")
    ap.add_argument("--use-cache", action="store_true", help="reuse saved pages (testing only)")
    ap.add_argument("--mode", choices=["full", "light"], default="full",
                    help="full: every issue page (calendar, research); light: 3 pages, GMP + subscription only")
    ap.add_argument("--loop-every", type=int, help="light mode: repeat every N minutes")
    ap.add_argument("--until", help="light mode: stop looping at HH:MM IST")
    ap.add_argument("--only-if-closing-today", action="store_true",
                    help="light mode: exit at once unless a mainboard issue closes today")
    args = ap.parse_args()
    if args.mode == "light":
        run_light(args.loop_every, args.until, args.only_if_closing_today)
        return
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

    try:
        subs = ig.fetch_subscription(use_cache=args.use_cache)
        print(f"Subscription: {len(subs)} rows in InvestorGain's live report")
    except (ig.ParseError, base.FetchError) as exc:
        subs = []
        print(f"Subscription: FAILED - {exc}")
    sub_by_ig = {s["ig_id"]: s for s in subs}
    for rec in ig_issues:
        rec["sub"] = sub_by_ig.get(rec["ig_id"])

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
            with db.RunLog(conn, "investorgain-subscription") as log:
                n = write_subscription(conn, subs, log)
                print(f"subscription: {n} mainboard issues matched, {log.written} changed readings written")
            frozen = ([f"T-1       {x}" for x in freeze_t_minus_1(conn, today)]
                      + [f"close day {x}" for x in freeze_close_day(conn, today)])
            for f in frozen:
                print(f"snapshot: {f}")

    board(ig_issues, iw_rows, today)


if __name__ == "__main__":
    main()

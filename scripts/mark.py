"""Mark an issue applied or skipped - it leaves tomorrow's digest.

    python scripts\\mark.py "moneyview" applied
    python scripts\\mark.py "runwal" skipped
    python scripts\\mark.py "runwal" undo       # back into the digest
    python scripts\\mark.py --list              # what's live and its status

The name is matched loosely against issues whose window is current or
recent, so a fragment is enough. If it matches more than one, nothing is
changed and the candidates are listed.

Your applied/skipped marks are also the first column of the calibration
log: applied-and-it-rose, skipped-and-it-rose, and so on.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402
from sources.base import slugify  # noqa: E402
from sources.ipowatch import IST  # noqa: E402


def live_issues(conn, today):
    with conn.cursor() as cur:
        cur.execute(
            """SELECT i.id, i.name, i.slug, i.open_date, i.close_date,
                      COALESCE(st.status, '-') AS status
               FROM issues i LEFT JOIN issue_status st ON st.issue_id = i.id
               WHERE i.board = 'mainboard' AND i.open_date IS NOT NULL
                 AND i.close_date >= %s AND i.open_date <= %s
               ORDER BY i.open_date""",
            (today - timedelta(days=7), today + timedelta(days=14)),
        )
        return cur.fetchall()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("name", nargs="?")
    ap.add_argument("action", nargs="?", choices=["applied", "skipped", "undo"])
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--note", help="optional note, e.g. 'applied on 2 PANs'")
    args = ap.parse_args()
    today = datetime.now(IST).date()

    with db.connect() as conn:
        rows = live_issues(conn, today)
        if args.list or not args.name:
            for r in rows:
                print(f"{r['slug']:<36}{r['open_date']:%d %b}-{r['close_date']:%d %b}   {r['status']}")
            return
        if not args.action:
            raise SystemExit("say what to mark it: applied, skipped or undo")

        q = slugify(args.name)
        hits = [r for r in rows if q == r["slug"]] or [r for r in rows if q in r["slug"]]
        if not hits:
            raise SystemExit(f"no live issue matches '{args.name}' - try: python scripts\\mark.py --list")
        if len(hits) > 1:
            print(f"'{args.name}' matches more than one issue - be more specific:")
            for r in hits:
                print(f"  {r['slug']}")
            raise SystemExit(1)

        issue = hits[0]
        with conn.cursor() as cur:
            if args.action == "undo":
                cur.execute("""UPDATE issue_status SET status = 'notified', resolved_at = NULL
                               WHERE issue_id = %s""", (issue["id"],))
            else:
                cur.execute(
                    """INSERT INTO issue_status (issue_id, status, resolved_at, note)
                       VALUES (%s, %s, now(), %s)
                       ON CONFLICT (issue_id) DO UPDATE SET status = EXCLUDED.status,
                         resolved_at = now(), note = COALESCE(EXCLUDED.note, issue_status.note)""",
                    (issue["id"], args.action, args.note),
                )
        print(f"{issue['name']}: {args.action}"
              + (" - it won't appear in tomorrow's digest" if args.action != "undo" else " - back in the digest"))


if __name__ == "__main__":
    main()

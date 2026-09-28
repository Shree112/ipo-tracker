"""Mark an issue applied or skipped - it leaves tomorrow's digest.

    python scripts\\mark.py "moneyview" applied
    python scripts\\mark.py "runwal" skipped
    python scripts\\mark.py "runwal" undo       # back into the digest
    python scripts\\mark.py --list              # what's live and its status

The name is matched loosely against issues whose window is current or
recent, so a fragment is enough. If it matches more than one, nothing is
changed and the candidates are listed.

Marks are recorded against your account (the admin) once accounts exist;
--user someone@gmail.com marks for another approved user. Before the first
sign-in on the website it falls back to the old single-user table.

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


def resolve_user(conn, email: str | None) -> str | None:
    """The account to mark for: --user, else the first admin; None = legacy mode."""
    with conn.cursor() as cur:
        if email:
            cur.execute("SELECT user_id::text AS uid FROM app_users WHERE lower(email) = lower(%s)", (email,))
            row = cur.fetchone()
            if not row:
                raise SystemExit(f"no account for {email}")
            return row["uid"]
        cur.execute("SELECT user_id::text AS uid FROM app_users WHERE is_admin ORDER BY created_at LIMIT 1")
        row = cur.fetchone()
        return row["uid"] if row else None


def live_issues(conn, today, uid):
    status_join = ("LEFT JOIN user_issue_status st ON st.issue_id = i.id AND st.user_id = %(uid)s::uuid"
                   if uid else "LEFT JOIN issue_status st ON st.issue_id = i.id")
    with conn.cursor() as cur:
        cur.execute(
            f"""SELECT i.id, i.name, i.slug, i.open_date, i.close_date,
                      COALESCE(st.status, '-') AS status
               FROM issues i {status_join}
               WHERE i.board = 'mainboard' AND i.open_date IS NOT NULL
                 AND i.close_date >= %(lo)s AND i.open_date <= %(hi)s
               ORDER BY i.open_date""",
            {"uid": uid, "lo": today - timedelta(days=7), "hi": today + timedelta(days=14)},
        )
        return cur.fetchall()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("name", nargs="?")
    ap.add_argument("action", nargs="?", choices=["applied", "skipped", "undo"])
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--note", help="optional note, e.g. 'applied on 2 PANs'")
    ap.add_argument("--user", help="mark for this account's email (default: you, the admin)")
    args = ap.parse_args()
    today = datetime.now(IST).date()

    with db.connect() as conn:
        uid = resolve_user(conn, args.user)
        rows = live_issues(conn, today, uid)
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
        table, key, keyval = (("user_issue_status", "user_id, issue_id", (uid, issue["id"])) if uid
                              else ("issue_status", "issue_id", (issue["id"],)))
        cols = "user_id, issue_id" if uid else "issue_id"
        ph = "%s::uuid, %s" if uid else "%s"
        with conn.cursor() as cur:
            if args.action == "undo":
                cur.execute(f"""UPDATE {table} SET status = 'notified', resolved_at = NULL
                                WHERE ({cols}) = ({ph})""" if uid else
                            f"UPDATE {table} SET status = 'notified', resolved_at = NULL WHERE issue_id = %s",
                            keyval)
            else:
                cur.execute(
                    f"""INSERT INTO {table} ({cols}, status, resolved_at, note)
                        VALUES ({ph}, %s, now(), %s)
                        ON CONFLICT ({key}) DO UPDATE SET status = EXCLUDED.status,
                          resolved_at = now(), note = COALESCE(EXCLUDED.note, {table}.note)""",
                    (*keyval, args.action, args.note),
                )
        print(f"{issue['name']}: {args.action}"
              + (" - it won't appear in tomorrow's digest" if args.action != "undo" else " - back in the digest"))


if __name__ == "__main__":
    main()

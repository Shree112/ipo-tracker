"""Per-user digests - the multi-user replacement for send_digest.py.

    python scripts\\send_digests.py              # send whatever is due this hour
    python scripts\\send_digests.py --dry-run    # show who would get what, send nothing
    python scripts\\send_digests.py --user you@gmail.com --force   # one person, now

Runs from the hourly workflow. For each approved, unpaused person whose
chosen digest hour is due (the run at ~HH:50 IST sends the HH+1 digests, so
GitHub's usual few-minute delay still lands them on time):

  * membership comes from the SQL function user_matches() - the same rule
    the website shows, so the email and the site can't disagree
  * one email, their issues only, with signed Applied / Skip buttons that
    record the decision against *their* account
  * nothing to report -> no email
  * a 1pm last-day reminder for people who asked for one, listing issues
    closing today that they haven't marked

Email goes out through Gmail SMTP (GMAIL_USER + GMAIL_APP_PASSWORD) - no
domain needed, up to ~500 recipients a day on a normal Gmail account.
Without those set, it falls back to Resend, which can only reach the address
the Resend account was created with.
"""
from __future__ import annotations

import argparse
import html
import os
import smtplib
import sys
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import db  # noqa: E402
import send_digest as sd  # noqa: E402
from sources.ipowatch import IST  # noqa: E402

REMINDER_HOUR = 13


def send_email(to: str, subj: str, html_body: str, text_body: str) -> str:
    user = os.getenv("GMAIL_USER", "").strip()
    pw = os.getenv("GMAIL_APP_PASSWORD", "").replace(" ", "").strip()
    if user and pw:
        msg = EmailMessage()
        msg["Subject"] = subj
        msg["From"] = f"IPO Copilot <{user}>"
        msg["To"] = to
        msg.set_content(text_body)
        msg.add_alternative(html_body, subtype="html")
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as smtp:
            smtp.login(user, pw)
            smtp.send_message(msg)
        return "gmail"
    os.environ["DIGEST_TO"] = to
    return sd.send_resend(subj, html_body, text_body)


def due_users(conn, target_hour: int, today: date, only_email: str | None) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT r.*, u.user_id::text AS user_id, u.email, u.name, u.is_admin
               FROM app_users u JOIN alert_rules r ON r.user_id = u.user_id
               WHERE u.status = 'approved' AND NOT r.paused""")
        rows = cur.fetchall()
    out = []
    for r in rows:
        if only_email:
            if r["email"].lower() == only_email.lower():
                out.append(r)
            continue
        if r["digest_days"] == "weekdays" and today.weekday() >= 5:
            continue
        if r["digest_hour"] == target_hour or (target_hour == REMINDER_HOUR and r["last_day_reminder"]):
            out.append(r)
    return out


def matches_for(conn, today: date, user_id: str) -> dict[int, dict]:
    with conn.cursor() as cur:
        cur.execute("SELECT issue_id, reasons, sticky FROM user_matches(%s) WHERE user_id = %s::uuid",
                    (today, user_id))
        return {r["issue_id"]: r for r in cur.fetchall()}


def pending_banner(conn) -> str:
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) AS n FROM app_users WHERE status = 'pending'")
        n = cur.fetchone()["n"]
    if not n:
        return ""
    link = f' <a href="{html.escape(sd.SITE_URL)}/admin" style="color:{sd.C["jade"]};">Review</a>' if sd.SITE_URL else ""
    return (f'<div style="font-size:13px;background:{sd.C["amber_soft"]};color:{sd.C["amber"]};'
            f'border-radius:8px;padding:8px 12px;margin:6px 0 4px;font-weight:600;">'
            f'{n} sign-up{"s" if n != 1 else ""} waiting for approval.{link}</div>')


def _note_html(title: str, body_html: str, cta: str, url: str) -> str:
    """A short account email in the digest's look."""
    c = sd.C
    button = (f'<a href="{html.escape(url)}" style="display:inline-block;background:{c["jade"]};color:#fff;'
              f'text-decoration:none;font-weight:600;border-radius:8px;padding:10px 16px;">{html.escape(cta)}</a>'
              if url else "")
    return (f'<div style="background:{c["page"]};padding:24px 12px;font-family:{sd.FONT};color:{c["ink"]};">'
            f'<div style="max-width:520px;margin:0 auto;background:{c["card"]};border:1px solid {c["rule"]};'
            f'border-radius:12px;padding:24px;">'
            f'<div style="font-size:13px;font-weight:700;color:{c["jade"]};margin-bottom:12px;">IPO Copilot</div>'
            f'<div style="font-size:20px;font-weight:700;margin-bottom:10px;">{html.escape(title)}</div>'
            f'<div style="font-size:15px;line-height:1.55;color:{c["muted"]};margin-bottom:18px;">{body_html}</div>'
            f'{button}</div></div>')


def account_emails(conn, dry_run: bool) -> None:
    """'You're in' for newly approved people; 'N waiting' for the admin."""
    site = sd.SITE_URL
    with conn.cursor() as cur:
        cur.execute("""SELECT u.user_id::text AS user_id, u.email, u.name, COALESCE(r.email_to, u.email) AS to_addr,
                              COALESCE(r.digest_hour, 8) AS digest_hour
                       FROM app_users u LEFT JOIN alert_rules r ON r.user_id = u.user_id
                       WHERE u.status = 'approved' AND NOT u.is_admin AND u.welcome_sent_at IS NULL""")
        welcome = cur.fetchall()
        cur.execute("""SELECT user_id::text AS user_id, email, name FROM app_users
                       WHERE status = 'pending' AND admin_notified_at IS NULL ORDER BY created_at""")
        waiting = cur.fetchall()
        cur.execute("SELECT email FROM app_users WHERE is_admin AND status = 'approved'")
        admins = [r["email"] for r in cur.fetchall()]

    for u in welcome:
        first = (u["name"] or "").split(" ")[0] or "there"
        h = int(u["digest_hour"])
        when = f"{(h - 1) % 12 + 1}{'am' if h < 12 else 'pm'}"
        body = (f"Hi {html.escape(first)}, your account is approved. Your digest arrives around {when} IST on days "
                f"when an IPO matches your alerts. It starts with GMP above 10%; you can change the rules, the time "
                f"and the address it goes to in your alert settings.")
        text = (f"Hi {first}, your account is approved. Your digest arrives around {when} IST on days when an IPO "
                f"matches your alerts.\n\nAlert settings: {site}/settings\n")
        if dry_run:
            print(f"  would send welcome to {u['to_addr']}")
            continue
        send_email(u["to_addr"], "You're in: IPO Copilot", _note_html("You're in", body, "Set your alerts",
                                                                    f"{site}/settings" if site else ""), text)
        with conn.cursor() as cur:
            cur.execute("UPDATE app_users SET welcome_sent_at = now() WHERE user_id = %s::uuid", (u["user_id"],))
        conn.commit()
        print(f"  welcome sent to {u['to_addr']}")

    if waiting and admins:
        names = "".join(f"<li>{html.escape(w['name'] or w['email'])} &middot; {html.escape(w['email'])}</li>"
                        for w in waiting)
        n = len(waiting)
        subj = f"{n} new sign-up{'s' if n != 1 else ''} waiting: IPO Copilot"
        body = f'<ul style="padding-left:18px;margin:0 0 6px;">{names}</ul>'
        text = "\n".join(f"- {w['name'] or ''} {w['email']}" for w in waiting) + f"\n\nReview: {site}/admin\n"
        if dry_run:
            print(f"  would tell {admins} about {n} sign-up(s)")
            return
        for a in admins:
            send_email(a, subj, _note_html(f"{n} waiting for approval", body, "Review sign-ups",
                                           f"{site}/admin" if site else ""), text)
        with conn.cursor() as cur:
            cur.execute("UPDATE app_users SET admin_notified_at = now() WHERE user_id = ANY(%s::uuid[])",
                        ([w["user_id"] for w in waiting],))
        conn.commit()
        print(f"  told the admin about {n} sign-up(s)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="send even if already sent today")
    ap.add_argument("--user", help="only this email (ignores the digest hour)")
    ap.add_argument("--date", help="pretend today is YYYY-MM-DD")
    ap.add_argument("--hour", type=int, help="pretend the target hour is H (IST)")
    args = ap.parse_args()

    now = datetime.now(IST)
    today = date.fromisoformat(args.date) if args.date else now.date()
    target_hour = args.hour if args.hour is not None else (now + timedelta(minutes=15)).hour

    with db.connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) AS n FROM app_users")
            has_accounts = cur.fetchone()["n"] > 0
        if not has_accounts:
            # Until the first sign-in on the website there are no accounts:
            # keep sending the original single-user digest at 8am.
            if target_hour == 8 or args.force:
                print("no accounts yet - sending the single-user digest")
                sys.argv = [sys.argv[0]] + (["--dry-run"] if args.dry_run else []) + (["--force"] if args.force else [])
                sd.main()
            return
        if not args.user:
            account_emails(conn, args.dry_run)
        users = due_users(conn, target_hour, today, args.user)
        if not users:
            print(f"{today} {target_hour:02d}h: no digests due")
            return
        for u in users:
            reminder = (target_hour == REMINDER_HOUR and u["last_day_reminder"]
                        and u["digest_hour"] != REMINDER_HOUR and not args.user)
            kind = "reminder" if reminder else "daily"
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM user_digest_run WHERE user_id = %s::uuid AND digest_date = %s AND kind = %s",
                            (u["user_id"], today, kind))
                if cur.fetchone() and not args.force:
                    print(f"  {u['email']}: {kind} already sent today")
                    continue

            m = matches_for(conn, today, u["user_id"])
            if reminder:
                m = {k: v for k, v in m.items() if v["sticky"]}  # only ones already in their digest
            issues = sd.enrich(conn, today, list(m))
            if reminder:
                issues = [i for i in issues if i["block"] == "closes"]
            if not issues:
                print(f"  {u['email']}: nothing matches - no email")
                continue
            for i in issues:
                i["_uid"] = str(u["user_id"])
                i["reasons"] = m[i["id"]]["reasons"]
                i["kept"] = not m[i["id"]]["reasons"] and m[i["id"]]["sticky"]

            banner = pending_banner(conn) if u["is_admin"] else ""
            scope = "closing today, not yet marked" if reminder else "matches your alerts"
            subj = ("Last day: " + ", ".join(i["name"].replace(" Ltd.", "") for i in issues)) if reminder \
                else sd.subject(issues, today)
            html_body = sd.render_html(issues, today, banner=banner, scope=scope)
            text_body = sd.render_text(issues, today)
            to = u["email_to"] or u["email"]
            if args.dry_run:
                print(f"  {to}: would send '{subj}' ({len(issues)} issues)")
                continue
            provider = send_email(to, subj, html_body, text_body)
            ids = [i["id"] for i in issues]
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO user_digest_run (user_id, digest_date, kind, issue_ids, provider_id)
                       VALUES (%s::uuid, %s, %s, %s, %s)
                       ON CONFLICT (user_id, digest_date, kind) DO UPDATE
                         SET sent_at = now(), issue_ids = EXCLUDED.issue_ids""",
                    (u["user_id"], today, kind, ids, provider))
                for iid in ids:
                    cur.execute(
                        """INSERT INTO user_issue_status (user_id, issue_id, status, first_notified_at)
                           VALUES (%s::uuid, %s, 'notified', now())
                           ON CONFLICT (user_id, issue_id) DO UPDATE
                             SET first_notified_at = COALESCE(user_issue_status.first_notified_at, now())
                           WHERE user_issue_status.status = 'notified'""",
                        (u["user_id"], iid))
            conn.commit()
            print(f"  {to}: sent {kind} ({len(ids)} issues) via {provider}")

        # close out decisions on issues that have ended
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE user_issue_status st SET status = 'closed', resolved_at = now()
                   FROM issues i WHERE i.id = st.issue_id AND st.status = 'notified' AND i.close_date < %s""",
                (today,))


if __name__ == "__main__":
    main()

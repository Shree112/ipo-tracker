"""Is the data still flowing? Runs at the end of every hourly digest pass.

Everything depends on scraping two sites, and the failure that hurts most is
the silent one: a site changes its layout, the scraper finds nothing, and the
digest simply goes quiet. So each check below has an expected rhythm, and the
admin gets one email when a check goes bad and one when it recovers - not an
email every hour. (GitHub separately emails you when a workflow crashes.)

    python scripts\\health.py        # print the current state, send nothing
"""
from __future__ import annotations

import html
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import db  # noqa: E402
import notify  # noqa: E402
from sources.ipowatch import IST  # noqa: E402

# source name -> (label, hours without a good run before it counts as down)
SOURCES = {
    "investorgain-light": ("Hourly GMP refresh (InvestorGain)", 4),
    "ipowatch-live": ("IPO Watch GMP table", 6),
    "investorgain-subscription": ("Live subscription", 6),
    "investorgain-live": ("Twice-daily full refresh (IPO calendar)", 16),
}


def evaluate(conn) -> list[dict]:
    """-> [{key, label, ok, detail}] for every check."""
    now = datetime.now(IST)
    out = []
    with conn.cursor() as cur:
        for src, (label, hours) in SOURCES.items():
            cur.execute("""SELECT max(started_at) FILTER (WHERE status = 'ok') AS last_ok,
                                  max(started_at) AS last_any,
                                  (array_agg(status ORDER BY started_at DESC))[1:3] AS recent,
                                  (array_agg(message ORDER BY started_at DESC))[1] AS last_msg
                           FROM scrape_run WHERE source = %s AND started_at > now() - interval '7 days'""", (src,))
            r = cur.fetchone()
            last_ok = r["last_ok"]
            recent = [x for x in (r["recent"] or []) if x]
            if not r["last_any"]:
                ok, detail = False, "no runs in the last 7 days"
            elif not last_ok or now - last_ok > timedelta(hours=hours):
                ago = f"{(now - last_ok).total_seconds() / 3600:.0f}h ago" if last_ok else "not in 7 days"
                ok, detail = False, f"last good run {ago}; latest: {recent[0] if recent else '?'} - {r['last_msg'] or ''}"
            elif len(recent) >= 3 and all(x in ("empty", "error") for x in recent):
                ok, detail = False, f"last 3 runs {', '.join(recent)}: {r['last_msg'] or ''}"
            else:
                ok, detail = True, f"last good run {last_ok.astimezone(IST):%d %b %H:%M}"
            out.append({"key": f"source:{src}", "label": label, "ok": ok, "detail": detail.strip()})

        # open issues should have a GMP reading from today (during market hours)
        if 10 <= now.hour <= 21:
            cur.execute("""SELECT i.name, max(g.observed_at) AS last
                           FROM issues i LEFT JOIN gmp_history g ON g.issue_id = i.id
                           WHERE i.board = 'mainboard' AND NOT COALESCE(i.withdrawn, false)
                             AND %s BETWEEN i.open_date AND i.close_date
                           GROUP BY i.name""", (now.date(),))
            stale = [r["name"] for r in cur.fetchall() if not r["last"] or now - r["last"] > timedelta(hours=8)]
            out.append({"key": "gmp-fresh", "label": "GMP for open IPOs", "ok": not stale,
                        "detail": ("no reading for 8h+: " + ", ".join(stale)) if stale else "all open IPOs have a recent GMP"})

        # deliveries
        cur.execute("""SELECT count(*) AS n, max(meta->>'error') AS err FROM app_event
                       WHERE kind = 'delivery_failed' AND at > now() - interval '24 hours'""")
        r = cur.fetchone()
        out.append({"key": "delivery", "label": "Email / Telegram delivery", "ok": r["n"] < 3,
                    "detail": f"{r['n']} failed in 24h" + (f" (latest: {r['err']})" if r["n"] else "")})

        # the clock itself: Supabase's pg_cron calls the site, which starts the
        # hourly GitHub job. A failing call (site down, expired GitHub token)
        # shows up here before the data goes stale everywhere.
        try:
            cur.execute("SAVEPOINT cron_check")
            cur.execute("""SELECT max(d.start_time) FILTER (WHERE d.status = 'succeeded') AS last_ok,
                                  count(*) FILTER (WHERE d.status = 'failed' AND d.start_time > now() - interval '3 hours') AS failed
                           FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
                           WHERE j.jobname = 'ipo-refresh' AND d.start_time > now() - interval '2 days'""")
            r = cur.fetchone()
            cur.execute("RELEASE SAVEPOINT cron_check")
            if r and (r["last_ok"] or r["failed"]):
                ok = bool(r["last_ok"]) and now - r["last_ok"] < timedelta(hours=2) and not r["failed"]
                out.append({"key": "scheduler", "label": "Supabase schedule (hourly job)", "ok": ok,
                            "detail": (f"last run {r['last_ok'].astimezone(IST):%d %b %H:%M}" if r["last_ok"] else "no successful run")
                                      + (f", {r['failed']} failed in 3h" if r["failed"] else "")})
        except Exception:  # noqa: BLE001 - no pg_cron here (local dev): skip the check
            cur.execute("ROLLBACK TO SAVEPOINT cron_check")

        # comment + company summaries (chatter job, twice a day)
        cur.execute("SELECT max(fetched_at) AS last FROM issue_chatter")
        last = cur.fetchone()["last"]
        if last is not None:
            ok = now - last < timedelta(hours=16)
            out.append({"key": "chatter", "label": "Comment summaries job", "ok": ok,
                        "detail": f"last run {last.astimezone(IST):%d %b %H:%M}"})
    return out


def check(conn, send_email) -> None:
    """Compare with the stored state; email the admin on changes."""
    results = evaluate(conn)
    newly_bad, recovered = [], []
    with conn.cursor() as cur:
        for c in results:
            cur.execute("SELECT ok FROM health_alert WHERE key = %s", (c["key"],))
            prev = cur.fetchone()
            if prev is None or prev["ok"] != c["ok"]:
                cur.execute("""INSERT INTO health_alert (key, ok, since, message) VALUES (%s, %s, now(), %s)
                               ON CONFLICT (key) DO UPDATE SET ok = EXCLUDED.ok, since = now(),
                                 message = EXCLUDED.message, notified_at = NULL""",
                            (c["key"], c["ok"], c["detail"]))
                if not c["ok"]:
                    newly_bad.append(c)
                elif prev is not None:
                    recovered.append(c)
            else:
                cur.execute("UPDATE health_alert SET message = %s WHERE key = %s", (c["detail"], c["key"]))
        cur.execute("""SELECT u.email, u.telegram_chat_id, COALESCE(r.channel, 'email') AS channel,
                              u.user_id::text AS user_id
                       FROM app_users u LEFT JOIN alert_rules r ON r.user_id = u.user_id
                       WHERE u.is_admin AND u.status = 'approved'""")
        admins = cur.fetchall()
    conn.commit()
    if not (newly_bad or recovered) or not admins:
        return
    lines = [f"<li><b>Down:</b> {html.escape(c['label'])} - {html.escape(c['detail'])}</li>" for c in newly_bad]
    lines += [f"<li><b>Back to normal:</b> {html.escape(c['label'])}</li>" for c in recovered]
    subj = ("Data problem: " + ", ".join(c["label"] for c in newly_bad)) if newly_bad else "Data back to normal"
    body = (f'<div style="font-family:sans-serif;font-size:14px;line-height:1.55;">'
            f'<p><b>IPO Copilot health check</b></p><ul>{"".join(lines)}</ul>'
            f'<p>Details are on the admin dashboard. GitHub also emails you if a workflow run fails.</p></div>')
    text = "\n".join(("DOWN: " + c["label"] + " - " + c["detail"]) for c in newly_bad) + \
        "\n".join(("OK again: " + c["label"]) for c in recovered)
    tg = "<b>" + notify.esc(subj) + "</b>\n" + notify.esc(text)
    for a in admins:
        notify.deliver(conn, {**a, "channel": "both" if a["telegram_chat_id"] else "email"}, send_email=send_email,
                       subject=subj, html_body=body, text_body=text, tg_text=tg, what="health")
    with conn.cursor() as cur:
        cur.execute("UPDATE health_alert SET notified_at = now() WHERE key = ANY(%s)",
                    ([c["key"] for c in newly_bad + recovered],))
    conn.commit()
    print(f"  health: {len(newly_bad)} down, {len(recovered)} recovered - admin told")


if __name__ == "__main__":
    # --notify: also email/Telegram the admin about changes. The watchdog
    # workflow runs this on GitHub's own clock, so a stopped Supabase schedule
    # (which also stops the hourly job that normally runs these checks) still
    # gets noticed.
    with db.connect() as c:
        for r in evaluate(c):
            print(f"{'OK  ' if r['ok'] else 'DOWN'}  {r['label']:<42} {r['detail']}")
        if "--notify" in sys.argv:
            from send_digests import send_email
            check(c, send_email)

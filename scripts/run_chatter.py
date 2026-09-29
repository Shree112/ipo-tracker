"""Collect comments on live issues and summarise them.

    python scripts\\run_chatter.py --fetch       # gather comments only
    python scripts\\run_chatter.py --summarise   # summarise what changed (needs the model running)
    python scripts\\run_chatter.py               # both
    python scripts\\run_chatter.py --only moneyview --force   # one issue, redo the summary

Issues covered: mainboard, from three days before opening until listing day
(or a week after closing if there's no listing date yet).

A summary is only (re)written when the set of comments has changed, so the
model runs once per issue per new batch of comments, not on every run. With
fewer than MIN_COMMENTS on-topic comments across both sources, the issue gets
no summary and the site says there isn't enough discussion yet.

In GitHub Actions, --fetch writes needs_llm=true|false to $GITHUB_OUTPUT, so
the workflow only starts the model when there's something to summarise.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402
from sources import chatter, rhp, summarize  # noqa: E402
from sources.base import FetchError  # noqa: E402
from sources.ipowatch import IST  # noqa: E402

MIN_COMMENTS = int(os.getenv("CHATTER_MIN_COMMENTS", "5"))


def live_issues(conn, only: str | None):
    with conn.cursor() as cur:
        cur.execute(
            """SELECT id, slug, name, ipowatch_url, rhp_url FROM issues
               WHERE board = 'mainboard' AND NOT COALESCE(withdrawn, false) AND open_date IS NOT NULL
                 AND %(today)s BETWEEN open_date - 3 AND COALESCE(listing_date, close_date + 7)
                 AND (%(only)s::text IS NULL OR slug ILIKE '%%' || %(only)s || '%%')
               ORDER BY open_date""",
            {"today": datetime.now(IST).date(), "only": only})
        return cur.fetchall()


def store(conn, issue_id: int, source: str, got: dict) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO issue_chatter (issue_id, source, fetched_at, n_comments, threads, comments, status)
               VALUES (%s, %s, now(), %s, %s, %s, %s)
               ON CONFLICT (issue_id, source) DO UPDATE SET fetched_at = now(),
                 n_comments = EXCLUDED.n_comments, threads = EXCLUDED.threads,
                 comments = EXCLUDED.comments, status = EXCLUDED.status""",
            (issue_id, source, len(got["comments"]), json.dumps(got["threads"]),
             json.dumps(got["comments"]), got["status"]))


def fetch(conn, issues) -> None:
    for i in issues:
        for source, fn in (("ipowatch", lambda: chatter.fetch_ipowatch(i["ipowatch_url"])),
                           ("reddit", lambda: chatter.fetch_reddit(i["name"]))):
            try:
                got = fn()
            except (FetchError, Exception) as exc:  # one bad source never stops the run
                print(f"  {i['slug']:<34} {source:<9} error: {exc}")
                with conn.cursor() as cur:
                    cur.execute("UPDATE issue_chatter SET status = 'error', fetched_at = now() "
                                "WHERE issue_id = %s AND source = %s", (i["id"], source))
                continue
            if got["status"] in ("no_page",):
                continue
            store(conn, i["id"], source, got)
            print(f"  {i['slug']:<34} {source:<9} {got['status']:<15} {len(got['comments'])} comments")
        conn.commit()


def ingest_rhp(conn, issues) -> None:
    """Prospectus text for the chat: once per issue (again only if the link changes)."""
    for i in issues:
        if not i["rhp_url"]:
            continue
        with conn.cursor() as cur:
            cur.execute("SELECT url, status FROM rhp_doc WHERE issue_id = %s", (i["id"],))
            row = cur.fetchone()
        if row and row["url"] == i["rhp_url"] and row["status"] in ("ok", "blocked", "too_big"):
            continue
        status, msg, pages, parts = "ok", None, None, []
        try:
            pages, parts = rhp.chunks(rhp.download(rhp.pdf_url(i["rhp_url"])))
            if not parts:
                status, msg = "error", "no text in the PDF (scanned images?)"
        except rhp.RhpError as exc:
            status, msg = ("blocked" if "robots" in str(exc) else "too_big" if "cap" in str(exc) else "error"), str(exc)
        except Exception as exc:  # noqa: BLE001
            status, msg = "error", f"{type(exc).__name__}: {exc}"[:300]
        with conn.cursor() as cur:
            cur.execute("DELETE FROM rhp_chunk WHERE issue_id = %s", (i["id"],))
            # One COPY instead of one INSERT per chunk: the runner is in the US and the
            # database in Singapore, so ~800 separate round trips per prospectus took minutes.
            with cur.copy("COPY rhp_chunk (issue_id, chunk_no, page, content) FROM STDIN") as cp:
                for n, c in enumerate(parts):
                    cp.write_row((i["id"], n, c["page"], c["content"].replace("\x00", "")))
            cur.execute("""INSERT INTO rhp_doc (issue_id, url, pages, chunks, status, message, fetched_at)
                           VALUES (%s, %s, %s, %s, %s, %s, now())
                           ON CONFLICT (issue_id) DO UPDATE SET url = EXCLUDED.url, pages = EXCLUDED.pages,
                             chunks = EXCLUDED.chunks, status = EXCLUDED.status, message = EXCLUDED.message,
                             fetched_at = now()""",
                        (i["id"], i["rhp_url"], pages, len(parts), status, msg))
        conn.commit()
        print(f"  {i['slug']:<34} prospectus {status:<8} {pages or 0} pages, {len(parts)} chunks {msg or ''}")


def purge_old(conn) -> None:
    """Comment text is only kept while an issue is live: a week after listing
    (or two after closing, if it never listed) it's deleted. The summary stays."""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE issue_chatter c SET comments = NULL
               FROM issues i WHERE i.id = c.issue_id AND c.comments IS NOT NULL
                 AND COALESCE(i.listing_date + 7, i.close_date + 14) < %s""",
            (datetime.now(IST).date(),))
        if cur.rowcount:
            print(f"  cleared stored comments for {cur.rowcount} finished issue(s)")
        # prospectus text is only needed while people are deciding
        cur.execute("""DELETE FROM rhp_chunk c USING issues i WHERE i.id = c.issue_id
                       AND COALESCE(i.listing_date + 30, i.close_date + 40) < %s""", (datetime.now(IST).date(),))
    conn.commit()


def pending(conn, issues, force: bool) -> list[tuple[dict, list, str]]:
    """Issues whose comments changed since their last summary."""
    out = []
    with conn.cursor() as cur:
        for i in issues:
            cur.execute("SELECT comments FROM issue_chatter WHERE issue_id = %s AND status = 'ok'", (i["id"],))
            comments = [c for r in cur.fetchall() for c in (r["comments"] or [])]
            h = hashlib.sha1(",".join(sorted(c["id"] for c in comments)).encode()).hexdigest()[:16]
            cur.execute("SELECT input_hash FROM issue_chatter_summary WHERE issue_id = %s", (i["id"],))
            row = cur.fetchone()
            if force or not row or row["input_hash"] != h:
                out.append((i, comments, h))
    return out


def pending_about(conn, issues, force: bool) -> list[tuple[dict, str]]:
    """Live issues with a company description but no profile summary yet."""
    out = []
    with conn.cursor() as cur:
        for i in issues:
            cur.execute("SELECT about, about_summary FROM issue_detail WHERE issue_id = %s", (i["id"],))
            row = cur.fetchone()
            if row and row["about"] and (force or not row["about_summary"]):
                out.append((i, row["about"]))
    return out


def save_summary(conn, issue_id: int, h: str, n: int, summary, model: str | None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO issue_chatter_summary (issue_id, summarized_at, input_hash, n_comments, summary, model)
               VALUES (%s, now(), %s, %s, %s, %s)
               ON CONFLICT (issue_id) DO UPDATE SET summarized_at = now(), input_hash = EXCLUDED.input_hash,
                 n_comments = EXCLUDED.n_comments, summary = EXCLUDED.summary, model = EXCLUDED.model""",
            (issue_id, h, n, json.dumps(summary) if summary else None, model))
    conn.commit()


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)  # show progress live in the Actions log
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true")
    ap.add_argument("--summarise", action="store_true")
    ap.add_argument("--only", help="slug fragment")
    ap.add_argument("--force", action="store_true", help="re-summarise even if nothing changed")
    args = ap.parse_args()
    both = not args.fetch and not args.summarise

    with db.connect() as conn:
        issues = live_issues(conn, args.only)
        print(f"{len(issues)} live issue(s); Reddit {'on' if chatter.reddit_configured() else 'not configured'}")
        if args.fetch or both:
            fetch(conn, issues)
            ingest_rhp(conn, issues)
            purge_old(conn)
        todo = pending(conn, issues, args.force)
        # too little to summarise: record that straight away, no model needed
        need_model = []
        for i, comments, h in todo:
            if len(comments) < MIN_COMMENTS:
                save_summary(conn, i["id"], h, len(comments), None, None)
                print(f"  {i['slug']:<34} {len(comments)} comments - not enough to summarise")
            else:
                need_model.append((i, comments, h))
        about_todo = pending_about(conn, issues, args.force)
        conn.commit()  # end the read transaction before the slow model calls
        if args.fetch and not args.summarise:
            flag = "true" if need_model or about_todo else "false"
            print(f"needs_llm={flag} ({len(need_model)} comment summaries, {len(about_todo)} company profiles)")
            if os.getenv("GITHUB_OUTPUT"):
                with open(os.environ["GITHUB_OUTPUT"], "a") as fh:
                    fh.write(f"needs_llm={flag}\n")
            return
        for i, about in about_todo:
            prof = summarize.summarise_company(i["name"], about)
            if prof is None:
                print(f"  {i['slug']:<34} company profile: no usable answer; will retry next run")
                continue
            with conn.cursor() as cur:
                cur.execute("UPDATE issue_detail SET about_summary = %s WHERE issue_id = %s",
                            (json.dumps({**prof, "model": summarize.model_label()}), i["id"]))
            conn.commit()
            print(f"  {i['slug']:<34} profile: {prof['one_liner']}")
        for i, comments, h in need_model:
            s = summarize.summarise(i["name"], comments)
            if s is None:
                print(f"  {i['slug']:<34} model gave no usable summary; will retry next run")
                continue
            save_summary(conn, i["id"], h, len(comments), s, summarize.model_label())
            print(f"  {i['slug']:<34} {s['mood']:<8} {s['headline']}")


if __name__ == "__main__":
    main()

"""The morning digest: one email, every live issue on your radar.

    python scripts\\send_digest.py --dry-run   # build it, save a preview, send nothing
    python scripts\\send_digest.py             # send (once per day - reruns are no-ops)
    python scripts\\send_digest.py --force     # send again today anyway

Membership, exactly as designed:
  Entry   GMP above 10% on any source, evaluated from T-1 (the day before
          the open date) onwards - on T-1 the current reading counts.
  Sticky  once an issue has been in a digest it stays, even if GMP falls
          back below 10% - the fall is flagged, not hidden.
  Exit    you mark it applied or skipped (scripts\\mark.py), or it closes.

Three blocks, hardest deadline first: Closes today / Open now / Opens
tomorrow. Nothing eligible -> no email at all.

No buttons yet: the email tells you the one-line command to mark an issue.
They arrive with the Vercel issue page.
"""
from __future__ import annotations

import argparse
import html
import os
import sys
from datetime import date, datetime, time, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config  # noqa: E402
import db  # noqa: E402
from sources.ipowatch import IST  # noqa: E402

TRIGGER_PCT = 10.0
STALE_HOURS = 36
SOURCE_LABEL = {"investorgain": "InvestorGain", "ipowatch": "IPO Watch"}


def ist_start(d: date) -> datetime:
    return datetime.combine(d, time(0, 0), tzinfo=IST)


# ---------------------------------------------------------------- data

def load(conn, today: date) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT i.id, i.name, i.slug, i.open_date, i.close_date, i.anchor_date,
                      i.listing_date, i.price_band_low, i.price_band_high, i.lot_size,
                      i.issue_size_cr, i.fresh_issue_cr, i.ofs_cr, i.pe_ratio,
                      i.min_order_amount, i.rhp_url, i.anchor_report_url,
                      i.investorgain_url, i.ipowatch_url, st.status
               FROM issues i LEFT JOIN issue_status st ON st.issue_id = i.id
               WHERE i.board = 'mainboard' AND COALESCE(i.withdrawn, false) = false
                 AND i.open_date IS NOT NULL AND i.close_date IS NOT NULL
                 AND %s BETWEEN i.open_date - 1 AND i.close_date
                 AND COALESCE(st.status, 'eligible') NOT IN ('applied', 'skipped')""",
            (today,),
        )
        issues = cur.fetchall()
        if not issues:
            return []
        cur.execute(
            """SELECT issue_id, source, observed_at, gmp_amount, gmp_pct
               FROM gmp_history
               WHERE issue_id = ANY(%s) AND gmp_amount IS NOT NULL AND gmp_pct IS NOT NULL
                 AND observed_at >= %s
               ORDER BY observed_at""",
            ([i["id"] for i in issues], ist_start(today - timedelta(days=14))),
        )
        readings = cur.fetchall()
        cur.execute(
            """SELECT DISTINCT ON (issue_id) issue_id, observed_at, qib_x, nii_x, rii_x, total_x
               FROM subscription WHERE issue_id = ANY(%s)
               ORDER BY issue_id, observed_at DESC""",
            ([i["id"] for i in issues],),
        )
        subs = {r["issue_id"]: r for r in cur.fetchall()}

    by_issue: dict[int, list] = {}
    for r in readings:
        by_issue.setdefault(r["issue_id"], []).append(r)

    now = datetime.now(IST)
    out = []
    for i in issues:
        rs = by_issue.get(i["id"], [])
        t1 = ist_start(i["open_date"] - timedelta(days=1))
        today0 = ist_start(today)
        per_source = {}
        for src in ("investorgain", "ipowatch"):
            mine = [r for r in rs if r["source"] == src]
            if not mine:
                continue
            latest = mine[-1]
            before_today = [r for r in mine if r["observed_at"] < today0]
            per_source[src] = {
                "latest": latest,
                "prev": before_today[-1] if before_today else None,
                "stale": now - latest["observed_at"] > timedelta(hours=STALE_HOURS),
            }
        current = [float(s["latest"]["gmp_pct"]) for s in per_source.values()]
        since_t1 = [float(r["gmp_pct"]) for r in rs if r["observed_at"] >= t1]
        peak = max(current + since_t1, default=None)

        already_notified = i["status"] == "notified"
        crossed = peak is not None and peak > TRIGGER_PCT
        if not (crossed or already_notified):
            continue

        if today == i["close_date"]:
            block = "closes"
        elif today >= i["open_date"]:
            block = "open"
        else:
            block = "tomorrow"
        i.update(per_source=per_source, peak=peak, sub=subs.get(i["id"]),
                 now_max=max(current, default=None), block=block,
                 sticky=(peak is not None and max(current, default=0) <= TRIGGER_PCT))
        out.append(i)
    # within a block: nearest close first, then the hottest GMP
    out.sort(key=lambda i: (i["close_date"], -(i["now_max"] or 0)))
    return out


# ---------------------------------------------------------------- render

BLOCKS = [("closes", "Closes today"), ("open", "Open now"), ("tomorrow", "Opens tomorrow")]

C = {"ink": "#131A18", "muted": "#5B6663", "rule": "#DCE0DA", "card": "#FFFFFF",
     "page": "#F3F5F2", "jade": "#0E6E5B", "jade_soft": "#E2EFEA", "amber": "#9A6410",
     "amber_soft": "#F6EEDD", "clay": "#9E3A2C"}
FONT = "-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif"


def _rs(x, dp: int | None = None) -> str:
    if x is None:
        return "-"
    x = float(x)
    if dp is None:
        dp = 0 if x == int(x) else 2
    return f"₹{x:,.{dp}f}"


def _cr(x) -> str:
    if x is None:
        return "-"
    x = float(x)
    return f"₹{x:,.0f} Cr" if x >= 100 else f"₹{x:,.1f} Cr"


def _band(i: dict) -> str:
    lo, hi = i["price_band_low"], i["price_band_high"]
    if lo and hi and float(lo) != float(hi):
        return f"{_rs(lo)}–{float(hi):,.0f}"
    return _rs(hi or lo)


def size_split(i: dict) -> str:
    """'fresh ₹750 · OFS ₹342' / 'all fresh' / 'all OFS' / ''."""
    f, o = i.get("fresh_issue_cr"), i.get("ofs_cr")
    if f is None and o is None:
        return ""
    f, o = float(f or 0), float(o or 0)
    if o == 0 and f > 0:
        return "all fresh issue"
    if f == 0 and o > 0:
        return "all offer for sale"
    return f"fresh {_cr(f)} · OFS {_cr(o)}"


def size_split_short(i: dict) -> str:
    """For the card's small line: 'fresh 69%' / 'all fresh' / 'all OFS'."""
    f, o = i.get("fresh_issue_cr"), i.get("ofs_cr")
    if f is None and o is None:
        return ""
    f, o = float(f or 0), float(o or 0)
    if o == 0 and f > 0:
        return "all fresh"
    if f == 0 and o > 0:
        return "all OFS"
    return f"fresh {f / (f + o) * 100:.0f}% · OFS {o / (f + o) * 100:.0f}%"


def _workdays(a: date, b: date) -> int:
    return sum(1 for k in range((b - a).days + 1) if (a + timedelta(days=k)).weekday() < 5)


def _when(dt: datetime, today: date) -> str:
    local = dt.astimezone(IST)
    return local.strftime("%H:%M") if local.date() == today else local.strftime("%d %b %H:%M")


def sub_summary(sub: dict) -> str:
    f = lambda x: f"{float(x):.2f}×" if x is not None else "-"
    return (f"{f(sub['total_x'])} · QIB {f(sub['qib_x'])} · NII {f(sub['nii_x'])}"
            f" · Retail {f(sub['rii_x'])}")


def primary_gmp(i: dict):
    """(source, stats) - InvestorGain first, IPO Watch as fallback."""
    for src in ("investorgain", "ipowatch"):
        if src in i["per_source"]:
            return src, i["per_source"][src]
    return None, None


def _delta(s: dict) -> float | None:
    if not s or s["prev"] is None:
        return None
    return float(s["latest"]["gmp_pct"]) - float(s["prev"]["gmp_pct"])


def stage_label(i: dict, today: date) -> str:
    if i["block"] == "tomorrow":
        return "Opens tomorrow"
    total = _workdays(i["open_date"], i["close_date"])
    if i["block"] == "closes":
        return f"Last day · {total} of {total}"
    # On a weekend, describe the next trading day rather than the one gone.
    d, suffix = today, ""
    while d.weekday() >= 5:
        d += timedelta(days=1)
    if d != today:
        suffix = f" · {d:%a}"
    n = _workdays(i["open_date"], d)
    return (f"Last day{suffix}" if n == total else f"Day {n} of {total}{suffix}")


# ---- plain text (fallback part of the email) ----

def text_row(i: dict, today: date) -> list[str]:
    src, s = primary_gmp(i)
    gmp = f"{float(s['latest']['gmp_pct']):.1f}%" if s else "-"
    d = _delta(s)
    if d is not None and abs(d) >= 0.05:
        gmp += f" ({'+' if d > 0 else '-'}{abs(d):.1f} pts)"
    last = ("opens " + i["open_date"].strftime("%d %b")) if i["block"] == "tomorrow" \
        else ("closes " + i["close_date"].strftime("%d %b"))
    split = size_split(i)
    lines = [f"* {i['name']}  [{stage_label(i, today)}]",
             f"  GMP {gmp} | Size {_cr(i['issue_size_cr'])}{' (' + split + ')' if split else ''}"
             f" | {last}",
             f"  Price {_band(i)}"
             + (f" · lists {i['listing_date']:%d %b}" if i["listing_date"] else "")]
    srcs = [f"{SOURCE_LABEL[k]} {float(v['latest']['gmp_pct']):.1f}%"
            f" ({v['latest']['observed_at'].astimezone(IST):%d %b %H:%M}{', STALE' if v['stale'] else ''})"
            for k, v in i["per_source"].items()]
    if srcs:
        lines.append("  " + " · ".join(srcs))
    if i["sticky"]:
        lines.append(f"  ! Peaked {i['peak']:.1f}% since T-1, now below 10% - kept until you mark it")
    links = []
    if i["anchor_date"] and i["anchor_date"] <= today and i["anchor_report_url"]:
        links.append(f"Anchor book: {i['anchor_report_url']}")
    if i["rhp_url"]:
        links.append(f"RHP: {i['rhp_url']}")
    lines += [f"  {l}" for l in links]
    lines.append(f'  Mark: python scripts\\mark.py "{i["slug"]}" applied')
    return lines


def render_text(issues: list[dict], today: date) -> str:
    out = [f"IPO digest - {today:%a %d %b %Y}", ""]
    for key, title in BLOCKS:
        rows = [i for i in issues if i["block"] == key]
        if rows:
            out.append(title.upper())
            for i in rows:
                out += text_row(i, today) + [""]
    out.append("GMP is unofficial and only the trigger for this mail - not a verdict.")
    return "\n".join(out)


# ---- HTML (tables + inline styles: what Gmail and Outlook actually render) ----

def _stat(label: str, value: str, sub: str = "", colour: str | None = None) -> str:
    e = html.escape
    return (f'<td valign="top" width="33%" style="padding:10px 8px 10px 0;">'
            f'<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:{C["muted"]};'
            f'font-weight:600;">{e(label)}</div>'
            f'<div style="font-size:19px;font-weight:700;color:{colour or C["ink"]};line-height:1.25;'
            f'margin-top:3px;white-space:nowrap;">{e(value)}</div>'
            + (f'<div style="font-size:11px;color:{C["muted"]};margin-top:2px;">{sub}</div>' if sub else "")
            + "</td>")


def card(i: dict, today: date) -> str:
    e = html.escape
    src, s = primary_gmp(i)
    d = _delta(s)
    if s is None:
        gmp_val, gmp_sub, gmp_col = "-", "no reading", C["muted"]
    else:
        gmp_val = f"{float(s['latest']['gmp_pct']):.1f}%"
        gmp_col = C["amber"] if i["sticky"] else C["jade"]
        if d is None:
            gmp_sub = e(_rs(s["latest"]["gmp_amount"]))
        elif abs(d) < 0.05:
            gmp_sub = f"{e(_rs(s['latest']['gmp_amount']))} · flat"
        else:
            arrow, col = ("▲", C["jade"]) if d > 0 else ("▼", C["clay"])
            gmp_sub = f'<span style="color:{col};">{arrow}{abs(d):.1f} pts</span>'
    if i["block"] == "tomorrow":
        last = _stat("Opens", f"{i['open_date']:%d %b}", f"closes {i['close_date']:%d %b}")
    else:
        last = _stat("Closes", "Today" if i["block"] == "closes" else f"{i['close_date']:%d %b}",
                     i["close_date"].strftime("%a"), C["clay"] if i["block"] == "closes" else None)
    stats = (_stat("GMP", gmp_val, gmp_sub, gmp_col)
             + _stat("Size", _cr(i["issue_size_cr"]), e(size_split_short(i)))
             + last)

    name = e(i["name"])
    if i["investorgain_url"]:
        name = f'<a href="{e(i["investorgain_url"])}" style="color:{C["ink"]};text-decoration:none;">{name}</a>'
    badge_bg, badge_fg = ((C["amber_soft"], C["amber"]) if i["block"] == "closes"
                          else (C["jade_soft"], C["jade"]))
    badge = (f'<span style="display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;'
             f'border-radius:10px;background:{badge_bg};color:{badge_fg};white-space:nowrap;">'
             f'{e(stage_label(i, today))}</span>')

    facts = [f"Price {e(_band(i))}"]
    if i["listing_date"]:
        facts.append(f"lists {i['listing_date']:%d %b}")
    srcs = " · ".join(
        f"{SOURCE_LABEL[k]} <b>{float(v['latest']['gmp_pct']):.1f}%</b>"
        f" <span style='color:{C['muted']};'>{_when(v['latest']['observed_at'], today)}"
        f"{' · stale' if v['stale'] else ''}</span>"
        for k, v in i["per_source"].items())
    sticky = (f'<div style="font-size:13px;color:{C["amber"]};font-weight:600;margin-top:8px;">'
              f'Peaked {i["peak"]:.1f}% since T&minus;1, now below 10% &mdash; kept until you mark it.</div>'
              if i["sticky"] else "")
    links = []
    if i["anchor_date"] and i["anchor_date"] <= today and i["anchor_report_url"]:
        links.append(("Anchor book", i["anchor_report_url"]))
    if i["rhp_url"]:
        links.append(("RHP", i["rhp_url"]))
    if i["ipowatch_url"]:
        links.append(("GMP history", i["ipowatch_url"]))
    link_html = " &nbsp;·&nbsp; ".join(
        f'<a href="{e(u)}" style="color:{C["jade"]};font-weight:600;text-decoration:none;">{e(t)}</a>'
        for t, u in links)

    return f"""
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{C['card']};
  border:1px solid {C['rule']};border-radius:8px;margin:10px 0;">
 <tr><td style="padding:14px 16px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="font-size:17px;font-weight:700;color:{C['ink']};">{name}</td>
    <td align="right" valign="top">{badge}</td></tr></table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
    style="border-top:1px solid {C['rule']};border-bottom:1px solid {C['rule']};margin:10px 0;">
    <tr>{stats}</tr></table>
  <div style="font-size:13px;color:{C['muted']};">{' · '.join(facts)}</div>
  <div style="font-size:13px;color:{C['ink']};margin-top:4px;">{srcs}</div>
  {sticky}
  <div style="font-size:13px;margin-top:10px;">{link_html}</div>
  <div style="font-size:11px;color:{C['muted']};margin-top:10px;font-family:Consolas,Menlo,monospace;">
    python scripts\\mark.py "{e(i['slug'])}" applied</div>
 </td></tr></table>"""


def render_html(issues: list[dict], today: date) -> str:
    counts = " · ".join(f"{sum(1 for i in issues if i['block'] == k)} {t.lower()}"
                        for k, t in BLOCKS if any(i["block"] == k for i in issues))
    parts = [f"""<div style="background:{C['page']};padding:16px 8px;font-family:{FONT};color:{C['ink']};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;">
<tr><td style="padding:0 4px;">
  <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:{C['jade']};font-weight:700;">IPO digest</div>
  <div style="font-size:22px;font-weight:700;margin:2px 0 2px;">{today:%A, %d %B}</div>
  <div style="font-size:13px;color:{C['muted']};margin-bottom:8px;">{html.escape(counts)} · mainboard, GMP &gt;10% from T&minus;1</div>"""]
    for key, title in BLOCKS:
        rows = [i for i in issues if i["block"] == key]
        if not rows:
            continue
        parts.append(f"""<div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;
  color:{C['muted']};font-weight:700;margin:20px 0 2px;">{html.escape(title)} · {len(rows)}</div>""")
        parts += [card(i, today) for i in rows]
    parts.append(f"""<div style="font-size:12px;color:{C['muted']};margin:18px 0 0;line-height:1.5;">
  GMP is unofficial and only the trigger for this mail, not a verdict. The big GMP figure is
  InvestorGain's (IPO Watch if it has none); the change is since yesterday's last reading.
  Issues leave the digest when marked applied or skipped, or when they close.</div>
</td></tr></table></div>""")
    return "".join(parts)


def subject(issues: list[dict], today: date) -> str:
    bits = []
    for key, title in BLOCKS:
        names = [i["name"].replace(" Ltd.", "").replace(" Limited", "") for i in issues if i["block"] == key]
        if names:
            bits.append(f"{title}: {', '.join(names[:3])}" + (f" +{len(names) - 3}" if len(names) > 3 else ""))
    return f"IPO digest {today:%d %b} · " + " | ".join(bits)


# ---------------------------------------------------------------- send

def send_resend(subj: str, html_body: str, text_body: str) -> str:
    import requests

    key = os.getenv("RESEND_API_KEY", "").strip()
    to = os.getenv("DIGEST_TO", "").strip()
    sender = os.getenv("DIGEST_FROM", "IPO Copilot <onboarding@resend.dev>").strip()
    if not key or not to:
        raise SystemExit("RESEND_API_KEY and DIGEST_TO must be set (in .env locally, or as Actions secrets)")
    resp = requests.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={"from": sender, "to": [to], "subject": subj, "html": html_body, "text": text_body},
        timeout=30,
    )
    if resp.status_code >= 300:
        raise SystemExit(f"Resend refused the email: HTTP {resp.status_code} {resp.text[:300]}")
    return resp.json().get("id", "")


def close_out(conn, today: date) -> int:
    """Issues that were notified and have now closed move to 'closed'."""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE issue_status st SET status = 'closed', resolved_at = now()
               FROM issues i WHERE i.id = st.issue_id AND st.status IN ('eligible','notified')
                 AND i.close_date < %s""",
            (today,),
        )
        return cur.rowcount


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="send even if today's digest already went")
    ap.add_argument("--date", help="pretend today is YYYY-MM-DD (testing)")
    args = ap.parse_args()
    today = date.fromisoformat(args.date) if args.date else datetime.now(IST).date()

    with db.connect() as conn:
        closed = close_out(conn, today) if not args.dry_run else 0
        issues = load(conn, today)
        if not issues:
            print(f"{today}: nothing eligible - no email." + (f" ({closed} closed out)" if closed else ""))
            return
        subj = subject(issues, today)
        text_body, html_body = render_text(issues, today), render_html(issues, today)

        preview = config.DATA / "digest-preview.html"
        preview.write_text(f"<!doctype html><meta charset='utf-8'><title>{html.escape(subj)}</title>"
                           f"<body style='background:#F6F7F5'>{html_body}</body>", encoding="utf-8")
        print(subj, "\n")
        print(text_body)
        print(f"\npreview saved: {preview}")
        if args.dry_run:
            return

        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM digest_run WHERE digest_date = %s", (today,))
            if cur.fetchone() and not args.force:
                print(f"\ndigest for {today} already sent - use --force to send again")
                return

        provider_id = send_resend(subj, html_body, text_body)
        ids = [i["id"] for i in issues]
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO digest_run (digest_date, issue_ids, subject, provider_id)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (digest_date) DO UPDATE SET sent_at = now(), issue_ids = EXCLUDED.issue_ids,
                     subject = EXCLUDED.subject, provider_id = EXCLUDED.provider_id""",
                (today, ids, subj, provider_id),
            )
            for iid in ids:
                cur.execute(
                    """INSERT INTO issue_status (issue_id, status, first_notified_at)
                       VALUES (%s, 'notified', now())
                       ON CONFLICT (issue_id) DO UPDATE SET status = 'notified',
                         first_notified_at = COALESCE(issue_status.first_notified_at, now())
                       WHERE issue_status.status = 'eligible' OR issue_status.status = 'notified'""",
                    (iid,),
                )
        print(f"\nsent to {os.getenv('DIGEST_TO')} ({len(ids)} issues){' - ' + closed.__str__() + ' closed out' if closed else ''}")


if __name__ == "__main__":
    main()

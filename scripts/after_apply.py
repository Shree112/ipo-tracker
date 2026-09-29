"""The email after someone marks an IPO Applied and then Got shares.

Listing     Listing-day morning, in the run that goes out just before 8am, only
            for issues the member marked "Got shares" on the issue page: last
            GMP, what it implies for the opening price, and the day's timings.

Allotment itself is checked by the member on the registrar's site (linked from
the issue page): all three big registrars need a PAN and a CAPTCHA, and IPO
Copilot neither stores PANs nor gets around CAPTCHAs. allotment_emails() below
is kept but not scheduled - registrars publish at unpredictable hours, so a
fixed-time reminder was more noise than help.

Skips paused accounts, and each issue gets the email once per person.
"""
from __future__ import annotations

import html
from datetime import date, datetime, time, timedelta

import notify
import send_digest as sd

ALLOTMENT_HOURS = (20, 8)   # evening of the allotment date; morning catch-up
LISTING_HOUR = 8

# name fragment -> (display name, status page). Everything else falls back to BSE's checker.
REGISTRARS = [
    (("kfin", "karvy"), "KFin Technologies", "https://ipostatus.kfintech.com/"),
    (("bigshare",), "Bigshare Services", "https://ipo.bigshareonline.com/IPO_Status.html"),
    (("intime", "mufg", "mpms"), "MUFG Intime", "https://in.mpms.mufg.com/Initial_Offer/public-issues.html"),
]
BSE_STATUS = "https://www.bseindia.com/investors/appli_check.aspx"


def registrar_link(name: str | None) -> tuple[str, str]:
    n = (name or "").lower()
    for keys, label, url in REGISTRARS:
        if any(k in n for k in keys):
            return label, url
    return "BSE", BSE_STATUS


def _link_expiry(i: dict) -> date:
    return (i.get("listing_date") or i["close_date"]) + timedelta(days=10)


def _button(url: str | None, label: str, primary: bool = False) -> str:
    if not url:
        return ""
    c = sd.C
    style = (f"background:{c['jade']};color:#fff;border:1px solid {c['jade']};" if primary
             else f"background:#fff;color:{c['ink']};border:1px solid {c['rule']};")
    return (f'<a href="{html.escape(url)}" style="{style}display:inline-block;text-decoration:none;'
            f'font-weight:600;font-size:14px;border-radius:8px;padding:9px 14px;margin:0 6px 6px 0;">{html.escape(label)}</a>')


def _shell(title: str, intro: str, cards: str) -> str:
    c = sd.C
    return (f'<div style="background:{c["page"]};padding:24px 12px;font-family:{sd.FONT};color:{c["ink"]};">'
            f'<div style="max-width:560px;margin:0 auto;">'
            f'<div style="font-size:13px;font-weight:700;color:{c["jade"]};margin:0 4px 10px;">IPO Copilot</div>'
            f'<div style="font-size:22px;font-weight:700;margin:0 4px 6px;">{html.escape(title)}</div>'
            f'<div style="font-size:14px;color:{c["muted"]};margin:0 4px 16px;line-height:1.5;">{intro}</div>'
            f'{cards}</div></div>')


def _card(inner: str) -> str:
    c = sd.C
    return (f'<div style="background:{c["card"]};border:1px solid {c["rule"]};border-radius:12px;'
            f'padding:16px 18px;margin-bottom:12px;">{inner}</div>')


def _applied(conn, where: str, params: tuple) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            f"""SELECT st.user_id::text AS uid, u.email, COALESCE(r.email_to, u.email) AS to_addr,
                       r.channel, u.telegram_chat_id,
                       i.id, i.slug, i.name, i.close_date, i.listing_date, i.allotment_date, i.registrar,
                       i.price_band_high, i.lot_size, st.allotment, st.note
                FROM user_issue_status st
                JOIN app_users u ON u.user_id = st.user_id AND u.status = 'approved'
                JOIN alert_rules r ON r.user_id = st.user_id AND NOT r.paused
                JOIN issues i ON i.id = st.issue_id
                WHERE st.status = 'applied' AND {where}
                ORDER BY st.user_id, i.listing_date, i.name""",
            params)
        return cur.fetchall()


def _group(rows: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(r["uid"], []).append(r)
    return out


def _latest_gmp(conn, issue_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute("""SELECT gmp_amount, gmp_pct, observed_at FROM gmp_history
                       WHERE issue_id = %s AND gmp_amount IS NOT NULL
                       ORDER BY (source = 'investorgain') DESC, observed_at DESC LIMIT 1""", (issue_id,))
        return cur.fetchone()


def allotment_emails(conn, today: date, target_hour: int, send, dry_run: bool) -> None:
    if target_hour not in ALLOTMENT_HOURS:
        return
    rows = _applied(conn, """st.allotment IS NULL AND st.allotment_mailed_at IS NULL
                             AND i.allotment_date IS NOT NULL AND i.allotment_date <= %s
                             AND %s < COALESCE(i.listing_date, i.allotment_date + 3)
                             AND (%s = 20 OR i.allotment_date < %s)""",
                    (today, today, target_hour, today))
    for uid, items in _group(rows).items():
        cards, text = [], []
        for i in items:
            i["_uid"] = uid
            label, url = registrar_link(i["registrar"])
            got = sd.action_url({**i, "close_date": _link_expiry(i) - timedelta(days=2)}, "allotted")
            not_got = sd.action_url({**i, "close_date": _link_expiry(i) - timedelta(days=2)}, "not_allotted")
            name = html.escape(i["name"].replace(" Ltd.", ""))
            steps = (f"On the {html.escape(label)} page, pick <b>{name}</b>, choose PAN, enter yours and the CAPTCHA."
                     if url != BSE_STATUS else
                     f"On BSE's page, choose Equity, pick <b>{name}</b>, and enter your PAN.")
            cards.append(_card(
                f'<div style="font-size:17px;font-weight:700;">{name}</div>'
                f'<div style="font-size:13px;color:{sd.C["muted"]};margin:4px 0 12px;line-height:1.5;">'
                f'Registrar: {html.escape((i["registrar"] or "not listed").rstrip("."))}. {steps}'
                + (f' Lists {i["listing_date"]:%a, %d %b}.' if i["listing_date"] else "") + '</div>'
                + _button(url, f"Check on {label}", primary=True)
                + (_button(BSE_STATUS, "Check on BSE") if url != BSE_STATUS else "")
                + '<div style="height:6px;"></div>'
                + f'<div style="font-size:13px;color:{sd.C["muted"]};margin-bottom:6px;">Then tell us how it went:</div>'
                + _button(got, "Got shares") + _button(not_got, "Not allotted")))
            text.append(f"{i['name']}: check on {label} - {url}")
        subj = ("Allotment is out: " + ", ".join(i["name"].replace(" Ltd.", "") for i in items))
        body = _shell("Allotment is out", "For the IPOs you marked Applied. Takes about 30 seconds each.", "".join(cards))
        to = items[0]["to_addr"]
        if dry_run:
            print(f"  {to}: would send '{subj}'")
            continue
        send(to, subj, body, "\n".join(text) + "\n")
        with conn.cursor() as cur:
            cur.execute("""UPDATE user_issue_status SET allotment_mailed_at = now()
                           WHERE user_id = %s::uuid AND issue_id = ANY(%s)""", (uid, [i["id"] for i in items]))
            cur.execute("""INSERT INTO user_digest_run (user_id, digest_date, kind, issue_ids, provider_id)
                           VALUES (%s::uuid, %s, 'allotment', %s, 'mail')
                           ON CONFLICT (user_id, digest_date, kind) DO UPDATE
                             SET issue_ids = user_digest_run.issue_ids || EXCLUDED.issue_ids, sent_at = now()""",
                        (uid, today, [i["id"] for i in items]))
        conn.commit()
        print(f"  {to}: allotment reminder ({len(items)})")


def listing_emails(conn, today: date, target_hour: int, send, dry_run: bool) -> None:
    if target_hour != LISTING_HOUR:
        return
    rows = _applied(conn, """COALESCE(st.allotment, '') <> 'not_allotted' AND st.listing_mailed_at IS NULL
                             AND i.listing_date = %s""", (today,))
    for uid, items in _group(rows).items():
        cards, text = [], []
        for i in items:
            name = html.escape(i["name"].replace(" Ltd.", ""))
            g = _latest_gmp(conn, i["id"])
            price = float(i["price_band_high"]) if i["price_band_high"] else None
            if g and price:
                implied = price + float(g["gmp_amount"])
                per_lot = float(g["gmp_amount"]) * (i["lot_size"] or 0)
                gmp_line = (f'Last GMP <b>{sd._rs(g["gmp_amount"])}</b> ({float(g["gmp_pct"]):.1f}%), '
                            f'which points to an open near <b>{sd._rs(implied)}</b> against the issue price of '
                            f'{sd._rs(price)}' + (f', about {sd._rs(per_lot, 0)} a lot.' if per_lot else '.'))
            else:
                gmp_line = "No recent GMP quote."
            status = ("You marked this allotted." if i["allotment"] == "allotted"
                      else "If you got shares, they should be in your demat already.")
            label, url = registrar_link(i["registrar"])
            cards.append(_card(
                f'<div style="font-size:17px;font-weight:700;">{name} lists today</div>'
                f'<div style="font-size:14px;margin:8px 0;line-height:1.55;">{gmp_line}</div>'
                f'<div style="font-size:13px;color:{sd.C["muted"]};line-height:1.55;margin-bottom:12px;">'
                f'Pre-open 9:00 to 9:45, trading from 10:00. {status} GMP is an unofficial quote; the '
                f'opening price can be quite different.</div>'
                + _button(sd.page_url(i), "Open the issue page", primary=True)
                + ("" if i["allotment"] else _button(url, f"Check allotment on {label}"))))
            text.append(f"{i['name']} lists today. {sd.page_url(i) or ''}")
        subj = "Listing today: " + ", ".join(i["name"].replace(" Ltd.", "") for i in items)
        body = _shell("Listing today", "For the IPOs you applied to. The market opens at 9:15; IPOs start trading at 10:00.",
                      "".join(cards))
        to = items[0]["to_addr"]
        if dry_run:
            print(f"  {to}: would send '{subj}'")
            continue
        tg = "<b>Listing today</b>\n\n" + "\n".join(
            f"<b>{notify.esc(i['name'].replace(' Ltd.', ''))}</b>: your shares list today. Pre-open 9:00-9:45, trading from 10:00."
            for i in items)
        u = {**items[0], "user_id": uid}
        if not notify.deliver(conn, u, send_email=send, subject=subj, html_body=body, text_body="\n".join(text) + "\n",
                              tg_text=tg, tg_buttons=[[("Open " + i["name"].replace(" Ltd.", "")[:20], sd.page_url(i, "tg"))] for i in items],
                              what="listing"):
            continue
        with conn.cursor() as cur:
            cur.execute("""UPDATE user_issue_status SET listing_mailed_at = now()
                           WHERE user_id = %s::uuid AND issue_id = ANY(%s)""", (uid, [i["id"] for i in items]))
            cur.execute("""INSERT INTO user_digest_run (user_id, digest_date, kind, issue_ids, provider_id)
                           VALUES (%s::uuid, %s, 'listing', %s, 'mail')
                           ON CONFLICT (user_id, digest_date, kind) DO NOTHING""",
                        (uid, today, [i["id"] for i in items]))
        conn.commit()
        print(f"  {to}: listing reminder ({len(items)})")

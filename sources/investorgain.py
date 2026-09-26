"""InvestorGain adapter - the live calendar and primary live GMP source.

InvestorGain is a Chittorgarh product (Chittorgarh's own GMP tab shows this
data), and its per-issue page carries the issue's full record in the Next.js
payload, so one fetch per issue gives both the calendar and the GMP:

  ipoData[0]   cor_id (== Chittorgarh's ipo id - our join key), company_name,
               issue_category ('Mainline' / SME), issue_open_date,
               issue_close_date, issue_extend_close_date, issue_price_lower /
               _upper / _final, market_lot_size, min_order_amount (the amount
               blocked at one lot), timetable_anchor_bid_dt,
               timetable_listing_dt, prospectus_rhp, anchor_investor_url,
               nse_symbol, bse_scripcode, issue_withdraw
  gmpData[]    the latest three GMP readings: gmp, gmp_percent_raw,
               subject_to_sauda, max_ipo_price, last_updated ('21-Oct-2024 18:29', IST)

Only the latest three readings are public; the full history is paywalled
(IPOMatrix) and we don't try to get it. We don't need it: we read every day
and keep our own history.

Which issues exist right now comes from the live GMP report, which is the
same reportTableData shape as the GMP performance tracker.
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime
from typing import Any

from . import base
from .chittorgarh import flight_payload

HOST = "https://www.investorgain.com"
LIVE_URL = f"{HOST}/report/ipo-gmp-live/331/"
# Next.js redirects are served as HTTP 200 with the target inside the payload
# (NEXT_REDIRECT;replace;/path;308) - requests can't see them, so we follow
# them ourselves. That's how the old live-ipo-gmp/331/ipo/ URL failed.
_NEXT_REDIRECT = re.compile(r"NEXT_REDIRECT;[a-z]+;(/[^;\"]+);30[1278]")
_ISSUE_PATH = re.compile(r"/gmp/([a-z0-9-]+)/(\d+)/")


class ParseError(RuntimeError):
    pass


def _array(flight: str, key: str) -> list | None:
    i = flight.find(f'"{key}":')
    if i < 0:
        return None
    start = flight.index("[", i)
    val, _ = json.JSONDecoder().raw_decode(flight[start:])
    return val if isinstance(val, list) else None


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        return None


def _iso_date(v: Any) -> date | None:
    if not v:
        return None
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _loose_date(v: Any) -> date | None:
    """'22nd Oct 2024' / 'Oct 22nd 2024' -> date. Their timetable text field."""
    if not v:
        return None
    s = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", str(v)).replace(",", " ")
    for fmt in ("%d %b %Y", "%b %d %Y", "%d %B %Y", "%B %d %Y"):
        try:
            return datetime.strptime(" ".join(s.split()), fmt).date()
        except ValueError:
            continue
    return _iso_date(v)


def _ist(v: Any) -> datetime | None:
    """'21-Oct-2024 18:29' (IST) -> aware datetime."""
    from .ipowatch import IST
    try:
        return datetime.strptime(str(v).strip(), "%d-%b-%Y %H:%M").replace(tzinfo=IST)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- live list

def live_issue_urls(html: str) -> list[dict[str, Any]]:
    """Every issue the live report links to: [{ig_id, url, name}].

    Reads link paths wherever they appear in the report rows rather than
    trusting one column name, so a renamed column doesn't silently empty the
    list. Mainboard filtering happens later, on the issue page itself.
    """
    flight = flight_payload(html)
    rows = _array(flight, "reportTableData")
    if rows is None:
        raise ParseError("reportTableData missing from the live GMP report")
    out, seen = [], set()
    for row in rows:
        # Skip SME rows early when the report labels them - saves a page
        # fetch each. Unlabelled rows are kept and filtered on the issue page.
        cat = str(row.get("~IPO_Category") or "").strip().upper()
        if cat and cat != "IPO":
            continue
        blob = json.dumps(row, ensure_ascii=False)
        m = _ISSUE_PATH.search(blob)
        if not m:
            continue
        ig_id = int(m.group(2))
        if ig_id in seen:
            continue
        seen.add(ig_id)
        name = re.sub(r"<[^>]+>", " ", str(row.get("IPO") or row.get("Name") or m.group(1)))
        out.append({"ig_id": ig_id, "url": f"{HOST}{m.group(0)}", "name": " ".join(name.split())})
    return out


# ---------------------------------------------------------------- issue page

def parse_issue(html: str) -> dict[str, Any]:
    flight = flight_payload(html)
    ipo = (_array(flight, "ipoData") or [None])[0]
    if not ipo:
        raise ParseError("ipoData missing from the issue page")
    gmp_rows = _array(flight, "gmpData") or []

    upper = _num(ipo.get("issue_price_upper"))
    close = _iso_date(ipo.get("issue_extend_close_date")) or _iso_date(ipo.get("issue_close_date"))
    rec = {
        "ig_id": int(ipo.get("ig_ipo_id") or ipo.get("id")),
        "cor_id": int(ipo["cor_id"]) if ipo.get("cor_id") else None,
        "name": (ipo.get("company_name") or ipo.get("company_short_name") or "").strip(),
        "mainboard": (ipo.get("issue_category") or "").strip().lower() == "mainline",
        "issue_type": (ipo.get("issue_type") or "").strip(),
        "withdrawn": bool(ipo.get("issue_withdraw")),
        "open_date": _iso_date(ipo.get("issue_open_date")),
        "close_date": close,
        "anchor_date": _iso_date(ipo.get("timetable_anchor_bid_dt")),
        "listing_date": _loose_date(ipo.get("timetable_listing_dt")),
        "price_band_low": _num(ipo.get("issue_price_lower")),
        "price_band_high": upper,
        "issue_price_final": _num(ipo.get("issue_price_final")),
        "lot_size": int(_num(ipo.get("market_lot_size")) or 0) or None,
        "min_order_amount": _num(ipo.get("min_order_amount")),
        "issue_size_cr": (_num(ipo.get("issue_size_in_amt")) or 0) / 1e7 or None,
        # fresh = new money to the company; OFS = existing holders selling.
        # 0 is a real value (all-fresh issue), so only a missing field is None.
        "fresh_issue_cr": (_num(ipo.get("issue_size_fresh_in_amt")) / 1e7
                           if _num(ipo.get("issue_size_fresh_in_amt")) is not None else None),
        "ofs_cr": (_num(ipo.get("issue_size_ofs_in_amt")) / 1e7
                   if _num(ipo.get("issue_size_ofs_in_amt")) is not None else None),
        "rhp_url": ipo.get("prospectus_rhp") or None,
        "anchor_report_url": ipo.get("anchor_investor_url") or None,
        "nse_symbol": ipo.get("nse_cd") or ipo.get("nse_symbol") or None,
        # bse_cd is the exchange scrip code (544274); bse_scripcode is an
        # internal number (6804) despite the name.
        "bse_code": str(ipo.get("bse_cd") or ipo.get("bse_script_code") or "") or None,
        "exchanges": ipo.get("ipo_listing_at") or None,
        "site_status": ipo.get("ipo_status") or None,
        "url_folder": ipo.get("urlrewrite_folder_name"),
    }

    gmps = []
    for g in gmp_rows:
        amount = _num(g.get("gmp"))
        when = _ist(g.get("last_updated"))
        if when is None:
            continue
        base_px = _num(g.get("max_ipo_price")) or upper
        gmps.append({
            "observed_at": when,
            "gmp_amount": amount,
            "gmp_pct": _num(g.get("gmp_percent_raw"))
            if g.get("gmp_percent_raw") not in (None, "")
            else (round(amount / base_px * 100, 3) if amount is not None and base_px else None),
            "est_listing_price": _num(g.get("estimated_listing_price")),
            "raw": {k: g.get(k) for k in ("gmp_date", "gmp", "gmp_percent_raw", "subject_to_sauda",
                                          "max_ipo_price", "last_updated", "trend_dir", "sub2")},
        })
    rec["gmp"] = sorted(gmps, key=lambda r: r["observed_at"])
    return rec


def get_page(url: str, *, use_cache: bool = False) -> str:
    """base.get, plus following one Next.js in-payload redirect."""
    html = base.get(url, use_cache=use_cache)
    m = _NEXT_REDIRECT.search(html)
    if m and "__next_f" in html:
        target = f"{HOST}{m.group(1)}"
        if target.rstrip("/") != url.rstrip("/"):
            html = base.get(target, use_cache=use_cache)
    return html


def fetch_live(*, use_cache: bool = False) -> list[dict[str, Any]]:
    return live_issue_urls(get_page(LIVE_URL, use_cache=use_cache))


def fetch_issue(url: str, *, use_cache: bool = False) -> dict[str, Any]:
    rec = parse_issue(get_page(url, use_cache=use_cache))
    rec["url"] = url
    return rec


# ---------------------------------------------------------------- subscription

SUBSCRIPTION_URL = f"{HOST}/report/ipo-subscription-live/333/"
_SUB_PATH = re.compile(r"/subscription/([a-z0-9-]+)/(\d+)/")
_SUB_COLS = {"qib": "qib_x", "shni": "shni_x", "bhni": "bhni_x", "nii": "nii_x",
             "rii": "rii_x", "total": "total_x", "emp": "employee_x", "employee": "employee_x",
             "pe": "pe_ratio"}


def _norm_key(k: str) -> str:
    return re.sub(r"[^a-z]", "", re.sub(r"<[^>]+>", "", str(k)).lower())


def _cell_num(v: Any) -> float | None:
    if v is None:
        return None
    txt = re.sub(r"<[^>]+>", " ", str(v)).replace(",", "")
    m = re.search(r"-?\d+(?:\.\d+)?", txt)
    return float(m.group(0)) if m else None


def parse_subscription(html: str) -> list[dict[str, Any]]:
    """Live subscription report: one row per open/just-closed issue, times
    subscribed by category. The issue link carries the same InvestorGain id
    as the GMP page, which is how rows join onto issues.investorgain_id.
    Includes SME rows - they simply won't match a mainboard issue."""
    rows = _array(flight_payload(html), "reportTableData")
    if rows is None:
        raise ParseError("reportTableData missing from the subscription report")
    out = []
    for row in rows:
        m = _SUB_PATH.search(json.dumps(row, ensure_ascii=False))
        if not m:
            continue
        rec: dict[str, Any] = {"ig_id": int(m.group(2)), "site_updated": None, "raw": {}}
        for k, v in row.items():
            nk = _norm_key(k)
            if nk in _SUB_COLS:
                rec[_SUB_COLS[nk]] = _cell_num(v)
                rec["raw"][k] = re.sub(r"<[^>]+>", "", str(v))
            elif "lastupdated" in nk or "updatedon" in nk:
                rec["site_updated"] = str(v)
        if rec.get("total_x") is None and rec.get("rii_x") is None:
            continue
        out.append(rec)
    return out


def fetch_subscription(*, use_cache: bool = False) -> list[dict[str, Any]]:
    return parse_subscription(get_page(SUBSCRIPTION_URL, use_cache=use_cache))

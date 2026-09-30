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
from datetime import date, datetime, timedelta
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

def live_issue_urls(html: str, include_sme: bool = False) -> list[dict[str, Any]]:
    """Every issue the live report links to: [{ig_id, url, name, sme}].

    Reads link paths wherever they appear in the report rows rather than
    trusting one column name, so a renamed column doesn't silently empty the
    list. Mainboard vs SME is settled later, on the issue page itself.
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
        if cat and cat != "IPO" and not (include_sme and cat == "SME"):
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
        out.append({"ig_id": ig_id, "url": f"{HOST}{m.group(0)}", "name": " ".join(name.split()), "sme": cat == "SME"})
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
        "allotment_date": _iso_date(ipo.get("timetable_boa_dt")),
        "registrar": ((ipo.get("registrar_name")
                       or ((_array(flight, "registrarInfo") or [{}])[0] or {}).get("registrar_name") or "").strip() or None),
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


def fetch_live(*, use_cache: bool = False, include_sme: bool = False) -> list[dict[str, Any]]:
    return live_issue_urls(get_page(LIVE_URL, use_cache=use_cache), include_sme=include_sme)


def fetch_issue(url: str, *, use_cache: bool = False) -> dict[str, Any]:
    html = get_page(url, use_cache=use_cache)
    rec = parse_issue(html)
    rec["url"] = url
    try:
        rec["detail"] = parse_detail(html)
    except Exception as exc:  # noqa: BLE001 - detail is a bonus; never lose the calendar/GMP over it
        rec["detail"] = None
        rec["detail_error"] = str(exc)[:120]
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
            if nk == "total":
                rec["observed_at"] = _site_time(v)  # "<b>0.51</b><br><small>25th Sep 18:55</small>"
        if rec.get("total_x") is None and rec.get("rii_x") is None:
            continue
        out.append(rec)
    return out


def fetch_subscription(*, use_cache: bool = False) -> list[dict[str, Any]]:
    return parse_subscription(get_page(SUBSCRIPTION_URL, use_cache=use_cache))


# ---------------------------------------------------------------- issue detail
# The issue page also carries, as HTML blocks referenced from ipoData
# ("$33" -> a "33:T<hexlen>,<html>" text row in the flight stream):
#   anchor_investor_detail  the anchor book: bid date, price, lock-ins, and
#                           one row per anchor investor
#   financial               restated financials by period (Rs crore)
#   peer_analysis           the RHP's listed-peer table (EPS, NAV, P/E, RoNW)
#   issue_objects           objects of the issue with amounts
# plus KPI fields directly on ipoData. None of it needs the RHP PDF.

from bs4 import BeautifulSoup  # noqa: E402

_KPI_FIELDS = {
    "roe": "kpi_roe", "roce": "kpi_roce", "debt_equity": "kpi_debt_equity", "ronw": "kpi_ronw",
    "pat_margin": "kpi_pat_margin", "nav": "nav", "price_to_book": "price_to_book_value",
    "eps_pre": "kpi_eps", "eps_post": "kpi_eps_post", "pe_pre": "pe_ratio", "pe_post": "post_pe_ratio",
    "market_cap_cr": "market_cap", "promoter_pre_pct": "promoter_shareholding_pre_issue",
    "promoter_post_pct": "promoter_shareholding_post_issue", "ebitda_margin": "kpi_ebitda",
}


def _resolve(flight: str, v: Any) -> str | None:
    """'$33' -> the HTML text row it points at; plain strings pass through."""
    if not isinstance(v, str) or not v:
        return None
    if not re.fullmatch(r"\$[0-9a-f]+", v):
        return v
    m = re.search(re.escape(v[1:]) + r":T([0-9a-f]+),", flight)
    if not m:
        return None
    n = int(m.group(1), 16)
    return flight[m.end():].encode("utf-8")[:n].decode("utf-8", "replace")


def _cells(tr) -> list[str]:
    return [c.get_text(" ", strip=True) for c in tr.find_all(["td", "th"])]


def _f(s: str | None) -> float | None:
    if s is None:
        return None
    m = re.search(r"-?\d[\d,]*(?:\.\d+)?", s)
    return float(m.group(0).replace(",", "")) if m else None


def _anchor(html: str | None) -> dict | None:
    if not html:
        return None
    soup = BeautifulSoup(html, "lxml")
    tables = soup.find_all("table")
    out: dict[str, Any] = {"investors": []}
    for t in tables:
        rows = [_cells(tr) for tr in t.find_all("tr")]
        if not rows:
            continue
        head = [h.lower() for h in rows[0]]
        if any("anchor" in h for h in head) and any("amt" in h or "amount" in h for h in head):
            idx = {h: k for k, h in enumerate(head)}
            col = lambda *names: next((k for h, k in idx.items() if any(n in h for n in names)), None)
            c_name, c_sh, c_amt = col("anchor"), col("shares"), col("amt", "amount")
            c_pa, c_pi = col("% allocated"), col("of issue")
            for r in rows[1:]:
                # the closing total row is one cell short and has no name
                if len(r) != len(head) or c_name is None or not re.search(r"[A-Za-z]", r[c_name]):
                    if len(r) >= 3 and not any(re.search(r"[A-Za-z]{3}", x) for x in r):
                        nums = [_f(x) for x in r if x]
                        if len(nums) >= 2:
                            out["total_shares"], out["total_amount_cr"] = nums[0], nums[1]
                    continue
                out["investors"].append({
                    "name": r[c_name],
                    "shares": _f(r[c_sh]) if c_sh is not None and c_sh < len(r) else None,
                    "amount_cr": _f(r[c_amt]) if c_amt is not None and c_amt < len(r) else None,
                    "pct_of_anchor": _f(r[c_pa]) if c_pa is not None and c_pa < len(r) else None,
                    "pct_of_issue": _f(r[c_pi]) if c_pi is not None and c_pi < len(r) else None,
                })
        else:
            for r in rows:
                if len(r) == 2:
                    k = r[0].lower()
                    if "bid date" in k:
                        out["bid_date"] = r[1]
                    elif k == "price":
                        out["price"] = _f(r[1])
                    elif "% of qib" in k:
                        out["pct_of_qib"] = _f(r[1])
                    elif "30 days" in k:
                        out["locked_30d_shares"] = _f(r[1])
                    elif "90 days" in k:
                        out["locked_90d_shares"] = _f(r[1])
    return out if out["investors"] or len(out) > 1 else None


def _financials(html: str | None) -> dict | None:
    if not html:
        return None
    t = BeautifulSoup(html, "lxml").find("table")
    if not t:
        return None
    rows = [_cells(tr) for tr in t.find_all("tr")]
    if not rows or len(rows[0]) < 2:
        return None
    periods = rows[0][1:]
    lines = [{"metric": r[0], "values": [_f(v) for v in r[1:1 + len(periods)]]}
             for r in rows[1:] if len(r) == len(periods) + 1]
    unit = next((r[0] for r in rows if len(r) == 1 and "crore" in r[0].lower()), "Amount in ₹ Crore")
    return {"periods": periods, "rows": lines, "unit": unit} if lines else None


def _peers(html: str | None, as_of: Any) -> dict | None:
    if not html:
        return None
    t = BeautifulSoup(html, "lxml").find("table")
    if not t:
        return None
    rows = [_cells(tr) for tr in t.find_all("tr")]
    if len(rows) < 2:
        return None
    return {"as_of": str(as_of)[:10] if as_of else None, "columns": rows[0],
            "rows": [r for r in rows[1:] if len(r) == len(rows[0])]}


def _objects(html: str | None) -> list | None:
    if not html:
        return None
    t = BeautifulSoup(html, "lxml").find("table")
    if not t:
        return None
    out = []
    for r in [_cells(tr) for tr in t.find_all("tr")][1:]:
        if len(r) >= 2 and r[1] and not re.match(r"(?i)total\b", r[1].strip()):
            out.append({"object": r[1], "amount_cr": _f(r[2]) if len(r) > 2 else None})
    return out or None


def parse_detail(html: str) -> dict[str, Any]:
    flight = flight_payload(html)
    ipo = (_array(flight, "ipoData") or [None])[0] or {}
    kpis = {k: _num(ipo.get(src)) for k, src in _KPI_FIELDS.items()}
    return {
        "anchor": _anchor(_resolve(flight, ipo.get("anchor_investor_detail"))),
        "anchor_lockin_30": _iso_date(ipo.get("timetable_anchor_lockin_end_dt_1")),
        "anchor_lockin_90": _iso_date(ipo.get("timetable_anchor_lockin_end_dt_2")),
        "financials": _financials(_resolve(flight, ipo.get("financial"))),
        "peers": _peers(_resolve(flight, ipo.get("peer_analysis")), ipo.get("peer_group_date")),
        "objects": _objects(_resolve(flight, ipo.get("issue_objects"))),
        "kpis": {k: v for k, v in kpis.items() if v is not None} or None,
        "about": _about(_resolve(flight, ipo.get("about_company")) or _resolve(flight, ipo.get("company_desc"))),
    }


def _about(html_text: str | None) -> str | None:
    """The company description as plain paragraphs (blank-line separated)."""
    if not html_text:
        return None
    soup = BeautifulSoup(html_text, "lxml")
    parts = []
    for el in soup.find_all(["p", "li"]):
        t = re.sub(r"\s+", " ", el.get_text(" ")).strip()
        if t:
            parts.append(("• " if el.name == "li" else "") + t)
    text = "\n\n".join(parts) or re.sub(r"\s+", " ", soup.get_text(" ")).strip()
    return text[:6000] or None


# ---------------------------------------------------------------- light refresh
# The live GMP report carries every issue's current GMP and its "Updated-On"
# time in one page, so the intraday refresh needs one request instead of one
# per issue. Same observed_at convention as the issue page (the site's own
# update time), so a reading seen by both paths is stored once.

_RS = re.compile(r"&#8377;\s*<b>\s*(-?[\d.,]+|--)\s*</b>|₹\s*<b>\s*(-?[\d.,]+|--)\s*</b>")


def _site_time(text: Any, now: datetime | None = None) -> datetime | None:
    """'27-Sep 8:33' or '25th Sep 18:55' (IST, no year) -> aware datetime."""
    from .ipowatch import IST, month_no
    if not text:
        return None
    t = re.sub(r"<[^>]+>", " ", str(text))
    m = re.search(r"(\d{1,2})(?:st|nd|rd|th)?[-\s]+([A-Za-z]{3,9})\s+(\d{1,2}):(\d{2})", t)
    if not m:
        return None
    mon = month_no(m.group(2))
    if not mon:
        return None
    now = now or datetime.now(IST)
    for year in (now.year, now.year - 1):
        try:
            dt = datetime(year, mon, int(m.group(1)), int(m.group(3)), int(m.group(4)), tzinfo=IST)
        except ValueError:
            continue
        if dt <= now + timedelta(days=2):
            return dt
    return None


def parse_live_gmp(html: str) -> list[dict[str, Any]]:
    rows = _array(flight_payload(html), "reportTableData")
    if rows is None:
        raise ParseError("reportTableData missing from the live GMP report")
    out = []
    for r in rows:
        ig_id = r.get("~id")
        if not ig_id:
            m = _ISSUE_PATH.search(json.dumps(r, ensure_ascii=False))
            ig_id = int(m.group(2)) if m else None
        if not ig_id:
            continue
        g = _RS.search(str(r.get("GMP") or ""))
        raw_amt = (g.group(1) or g.group(2)) if g else None
        amount = None if raw_amt in (None, "--") else _num(raw_amt)
        out.append({
            "ig_id": int(ig_id),
            "category": str(r.get("~IPO_Category") or "").strip().upper(),
            "gmp_amount": amount,
            "gmp_pct": _num(r.get("~gmp_percent_calc")) if amount is not None else None,
            "observed_at": _site_time(r.get("Updated-On")),
            "price": _num(r.get("Price (₹)") or r.get("Price")),
            "close_date": _iso_date(r.get("~Srt_Close")),
            "raw": {"GMP": re.sub(r"<[^>]+>", " ", str(r.get("GMP") or "")).strip(),
                    "Updated-On": re.sub(r"<[^>]+>", "", str(r.get("Updated-On") or ""))},
        })
    return out


def fetch_live_gmp(*, use_cache: bool = False) -> list[dict[str, Any]]:
    return parse_live_gmp(get_page(LIVE_URL, use_cache=use_cache))

"""Chittorgarh adapter.

The performance tracker renders its table client-side, so the visible HTML is
empty. But the page is Next.js, and the server component payload is embedded
in the document as a sequence of  self.__next_f.push([1,"...chunk..."])
script calls. Concatenating those chunks reconstructs a flight stream that
contains a `performancesDetails` array - one JSON object per issue, with
considerably more than the rendered table shows:

    ipo_id, ipo_company_name, ipo_issue_type, ipo_urlrewrite_folder_name
    ipo_issue_price_final / _normalised, il_ipo_listing_date
    ildt_open_price, ildt_close_price, ildt_low_price, ildt_high_price
    change_in_percentage_listing_day, ipo_profit_loss
    qib, nii, rii, emp, total            <- final subscription by category
    il_bse_script_code, il_nse_script_symbol, ipo_issue_size_in_amt

Two consequences worth knowing:

  * listing-day OPEN is in there (ildt_open_price), so the backfill does not
    need an exchange OHLC source and does not have to settle for close.
  * final subscription is in there too, so the signal side of the calibration
    set backfills as well - not just the outcome side.

Parsing the flight payload rather than the HTML is also the more stable
choice: it is the data the page itself renders from, so it survives
restyling.
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime
from typing import Any, Iterator

from . import base

TRACKER_URL = "https://www.chittorgarh.com/ipo/ipo_perf_tracker.asp"
ISSUE_URL = "https://www.chittorgarh.com/ipo/{slug}/{cg_id}/"

# self.__next_f.push([1,"<json string literal>"])
_CHUNK_RE = re.compile(r'self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\s*\]\)')


class ParseError(RuntimeError):
    pass


def flight_payload(html: str) -> str:
    """Reconstruct the Next.js server payload from its script chunks."""
    chunks = _CHUNK_RE.findall(html)
    if not chunks:
        raise ParseError(
            "no __next_f chunks found - the page is no longer Next.js, "
            "or it returned an error/challenge page"
        )
    out = []
    for raw in chunks:
        try:
            out.append(json.loads(raw))
        except json.JSONDecodeError:
            continue  # a chunk we can't decode is not worth failing over
    return "".join(out)


def extract_performances(html: str) -> list[dict[str, Any]]:
    """Pull the performancesDetails array out of the payload."""
    payload = flight_payload(html)
    marker = '"performancesDetails":'
    idx = payload.find(marker)
    if idx == -1:
        raise ParseError(
            "performancesDetails not present - check the year has data, "
            "or that the payload shape has not changed"
        )
    start = payload.index("[", idx)
    rows, _ = json.JSONDecoder().raw_decode(payload[start:])
    if not isinstance(rows, list):
        raise ParseError(f"expected a list, got {type(rows).__name__}")
    return rows


# ---------------------------------------------------------------- normalise

def _num(value: Any) -> float | None:
    """Their empty cells are '' rather than null."""
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _int(value: Any) -> int | None:
    n = _num(value)
    return int(n) if n is not None else None


def _date(value: Any) -> date | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
    except ValueError:
        return None


def normalise(row: dict[str, Any]) -> dict[str, Any] | None:
    """One tracker row -> one flat record, or None if unusable.

    price_basis is decided here: the listing-day open where the site has it,
    the close otherwise. The two are genuinely different numbers - Hero Motors
    opened at 82 against a 84 issue price and closed at 98.40, so the same
    issue is -2.4% on an open basis and +17.1% on a close basis. Recording
    which one a row used is what stops those being averaged together later.
    """
    name = (row.get("ipo_company_name") or "").strip()
    # ipo_issue_price_final is the price as it was on listing day.
    # ipo_issue_price_normalised is retro-adjusted for later stock splits, so
    # it pairs with the CURRENT price, never with the listing-day prices.
    # Mixing them is silent and enormous: Rolex Rings has final=900,
    # normalised=90, and listing close 1167 - a genuine +29.7% reads as
    # +1196% if you divide by the adjusted figure.
    issue_price = _num(row.get("ipo_issue_price_final")) or _num(
        row.get("ipo_issue_price_normalised")
    )
    if not name or not issue_price or issue_price <= 0:
        return None

    open_px = _num(row.get("ildt_open_price"))
    close_px = _num(row.get("ildt_close_price"))
    if open_px:
        basis, headline = "open", open_px
    elif close_px:
        basis, headline = "close", close_px
    else:
        return None

    cg_id = _int(row.get("ipo_id"))
    folder = (row.get("ipo_urlrewrite_folder_name") or "").strip()

    return {
        "slug": base.slugify(name),
        "name": name,
        "issue_type": (row.get("ipo_issue_type") or "").strip() or None,
        "chittorgarh_id": cg_id,
        "chittorgarh_url": (
            ISSUE_URL.format(slug=folder, cg_id=cg_id) if folder and cg_id else None
        ),
        "exchanges": ",".join(
            filter(
                None,
                [
                    "BSE" if row.get("il_bse_script_code") else None,
                    "NSE" if row.get("il_nse_script_symbol") else None,
                ],
            )
        )
        or None,
        "listing_date": _date(row.get("il_ipo_listing_date")),
        "issue_price": issue_price,
        "issue_size_cr": (
            round(_num(row.get("ipo_issue_size_in_amt")) / 1_00_00_000, 2)
            if _num(row.get("ipo_issue_size_in_amt"))
            else None
        ),
        "listing_open": open_px,
        "listing_close": close_px,
        "listing_low": _num(row.get("ildt_low_price")),
        "listing_high": _num(row.get("ildt_high_price")),
        "price_basis": basis,
        "headline_price": headline,
        # their own close-basis figure, kept only to check our arithmetic
        "site_listing_gain_close_pct": _num(row.get("change_in_percentage_listing_day")),
        "issue_price_split_adjusted": _num(row.get("ipo_issue_price_normalised")),
        "sub_qib_x": _num(row.get("qib")),
        "sub_nii_x": _num(row.get("nii")),
        "sub_rii_x": _num(row.get("rii")),
        "sub_emp_x": _num(row.get("emp")),
        "sub_total_x": _num(row.get("total")),
    }


def fetch_year(
    year: int,
    *,
    session=None,
    use_cache: bool = False,
    ipo_only: bool = True,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Fetch and normalise one year of the mainboard performance tracker.

    Returns (records, counts). ipo_only drops REITs, InvITs and SM REITs,
    which sit in the same table but are not IPOs and would muddy any
    calibration built on it.
    """
    url = f"{TRACKER_URL}?year={year}"
    html = base.get(url, session=session, use_cache=use_cache)
    raw = extract_performances(html)

    counts = {"seen": len(raw), "skipped_type": 0, "skipped_bad": 0, "kept": 0}
    records = []
    for row in raw:
        if ipo_only and (row.get("ipo_issue_type") or "").strip().upper() != "IPO":
            counts["skipped_type"] += 1
            continue
        rec = normalise(row)
        if rec is None:
            counts["skipped_bad"] += 1
            continue
        rec["year"] = year
        records.append(rec)
    counts["kept"] = len(records)
    return records, counts


def iter_years(start: int, end: int) -> Iterator[int]:
    step = 1 if end >= start else -1
    yield from range(start, end + step, step)

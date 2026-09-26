"""IPO Watch adapter - the GMP backfill source.

Why IPO Watch and not InvestorGain for history: InvestorGain (a Chittorgarh
product, and what Chittorgarh's own GMP tab shows) publishes only the last
three GMP readings per issue; the full day-wise history is behind the
IPOMatrix paywall. We don't scrape around that. IPO Watch is run by a
different operator and publishes the whole day-wise table on each issue's
GMP page, so it is both the history source and an independent cross-check.

Pages are plain WordPress HTML - no payload trick needed.

Two pages matter:

  LIVE_URL       live tables, plus a "Mainboard IPO GMP Performance" table of
                 every mainboard issue since ~Dec 2022: name, IPO price, final
                 GMP, listing price, and a link to the issue's overview page.
  <slug>-ipo-gmp-grey-market-premium/
                 day-wise GMP table (Date | IPO GMP | Trend | Kostak |
                 Subject to) plus the issue's open / close / listing dates.

Quirks the parser handles, all seen in real pages:
  * dates carry no year ("21 October") - inferred from the issue's dates
  * the newest row is labelled "Today" - anchored to the page's
    article:modified_time (else published_time), in IST
  * "₹-" means no quote that day; "+-₹15" is ambiguous and kept as NULL
    with the raw text preserved
  * an unknown slug returns HTTP 200 with a "Page not found" page
  * sidebar widgets carry unrelated tables (another company's financials),
    so the GMP table is found by its header, never by position
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

from bs4 import BeautifulSoup

from . import base

HOST = "https://ipowatch.in"
LIVE_URL = f"{HOST}/ipo-grey-market-premium-latest-ipo-gmp/"
IST = timezone(timedelta(hours=5, minutes=30))

MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"], start=1)}


def month_no(word: str) -> int | None:
    """'October', 'Oct', 'Sept', 'sep' -> 10 / 9. Older pages abbreviate."""
    w = word.lower().strip(".")
    if len(w) < 3:
        return None
    for name, n in MONTHS.items():
        if name.startswith(w) or (len(w) >= 3 and w[:3] == name[:3] and name.startswith(w[:3])):
            return n
    return None


class ParseError(RuntimeError):
    pass


# ---------------------------------------------------------------- helpers

def _text(el) -> str:
    return el.get_text(" ", strip=True).replace("\xa0", " ") if el else ""


def money(s: str | None) -> float | None:
    """'₹1,960' -> 1960.0 ; '-₹30' -> -30.0 ; '₹-' / '' / '+-₹15' -> None."""
    if not s:
        return None
    s = s.strip().replace(",", "")
    if "+-" in s or "-+" in s or "±" in s:
        return None
    m = re.search(r"(-)?\s*₹?\s*(-)?\s*(\d+(?:\.\d+)?)", s)
    if not m:
        return None
    val = float(m.group(3))
    return -val if (m.group(1) or m.group(2)) else val


def long_date(s: str | None) -> date | None:
    """'15 October, 2024' or 'November 6, 2024' -> date."""
    if not s:
        return None
    s = s.replace(",", " ").lower()
    day = re.search(r"\b(\d{1,2})\b", s)
    year = re.search(r"\b(20\d\d)\b", s)
    mon = next((m for m in (month_no(w) for w in re.findall(r"[a-z]+", s)) if m), None)
    if not (day and year and mon):
        return None
    try:
        return date(int(year.group(1)), mon, int(day.group(1)))
    except ValueError:
        return None


def is_not_found(html: str) -> bool:
    title = re.search(r"<title>(.*?)</title>", html, flags=re.I | re.S)
    return bool(title and "page not found" in title.group(1).lower())


def gmp_url_from_overview(overview_url: str) -> str | None:
    """Overview link -> GMP page URL, by the site's own naming convention.

    .../hyundai-motor-india-ipo-date-review-price-allotment-details/
      -> .../hyundai-motor-india-ipo-gmp-grey-market-premium/
    """
    path = urlparse(overview_url).path.strip("/")
    m = re.match(r"(.+?-(?:ipo|fpo))(?:-|$)", path)
    if not m:
        return None
    return f"{HOST}/{m.group(1)}-gmp-grey-market-premium/"


def find_gmp_link(overview_html: str) -> str | None:
    """Fallback when the convention fails: the overview page links its GMP page."""
    for href in re.findall(r'href="([^"]+gmp-grey-market-premium/?)"', overview_html):
        if href.startswith(HOST):
            return href
    return None


# ---------------------------------------------------------------- live page

def parse_performance(html: str) -> list[dict[str, Any]]:
    """The 'Mainboard IPO GMP Performance' table on the live page."""
    soup = BeautifulSoup(html, "lxml")
    for table in soup.find_all("table"):
        head = [_text(c).lower() for c in table.find("tr").find_all(["th", "td"])]
        if head[:4] == ["ipo name", "ipo price", "ipo gmp", "listing price"]:
            break
    else:
        raise ParseError("performance table not found on the live GMP page")

    out = []
    for tr in table.find_all("tr")[1:]:
        cells = [_text(c) for c in tr.find_all("td")]
        a = tr.find("a", href=True)
        if len(cells) < 4 or not a:
            continue
        href = a["href"].replace("ipowatch.in//", "ipowatch.in/")
        out.append({
            "name": cells[0],
            "issue_price": money(cells[1]),
            "final_gmp": money(cells[2]),
            "listing_price": money(cells[3]),
            "overview_url": href,
            "gmp_url": gmp_url_from_overview(href),
        })
    return out


# ---------------------------------------------------------------- GMP page

def _page_date(soup) -> date | None:
    for prop in ("article:modified_time", "article:published_time"):
        tag = soup.find("meta", attrs={"property": prop})
        if tag and tag.get("content"):
            try:
                return datetime.fromisoformat(tag["content"]).astimezone(IST).date()
            except ValueError:
                continue
    return None


def _key_dates(soup) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for tr in soup.find_all("tr"):
        cells = [_text(c) for c in tr.find_all(["td", "th"])]
        if len(cells) != 2:
            continue
        k, v = cells[0].lower().rstrip(":").strip(), cells[1]
        if k == "ipo open date":
            out.setdefault("open_date", long_date(v))
        elif k == "ipo close date":
            out.setdefault("close_date", long_date(v))
        elif k == "ipo listing date":
            out.setdefault("listing_date", long_date(v))
        elif k in ("ipo price band", "price band"):
            nums = [money(x) for x in re.findall(r"₹\s*[\d,]+(?:\.\d+)?", v)]
            nums = [n for n in nums if n]
            if nums:
                out.setdefault("price_band_low", min(nums))
                out.setdefault("price_band_high", max(nums))
    return out


def _gmp_table(soup):
    for table in soup.find_all("table"):
        first = table.find("tr")
        head = [_text(c).lower() for c in first.find_all(["th", "td"])] if first else []
        if len(head) >= 2 and head[0] == "date" and "gmp" in head[1]:
            return table
    return None


def _infer_year(day: int, month: int, anchor: date) -> date | None:
    """Pick the year that puts (day, month) nearest the issue's own dates."""
    best = None
    for y in (anchor.year - 1, anchor.year, anchor.year + 1):
        try:
            d = date(y, month, day)
        except ValueError:
            continue
        if best is None or abs((d - anchor).days) < abs((best - anchor).days):
            best = d
    return best


def parse_gmp_page(html: str) -> dict[str, Any]:
    """-> {open_date, close_date, listing_date, price_band_*, page_date, rows[]}

    rows: [{gmp_date, gmp_amount, kostak, subject_to, raw}] oldest first.
    A row is kept even when its GMP is NULL - 'no quote' is information.
    """
    if is_not_found(html):
        raise ParseError("page not found")
    soup = BeautifulSoup(html, "lxml")
    info = _key_dates(soup)
    info["page_date"] = _page_date(soup)

    table = _gmp_table(soup)
    if table is None:
        raise ParseError("no day-wise GMP table on the page")

    anchor = info.get("open_date") or info.get("listing_date") or info["page_date"]
    if anchor is None:
        raise ParseError("no dates to anchor the year on")

    # Column layout changed over the years: Date | IPO GMP | Trend | Kostak |
    # Subject to (2024), Date | IPO GMP | Kostak | Subject to (older), and
    # Date | IPO GMP | GMP Trend | Gain (2026). Map by header, never position.
    head = [_text(c).lower() for c in table.find("tr").find_all(["th", "td"])]
    col = {name: next((i for i, h in enumerate(head) if name in h), None)
           for name in ("kostak", "subject")}

    def cell(cells, i):
        return cells[i] if i is not None and i < len(cells) else None

    rows = []
    for tr in table.find_all("tr")[1:]:
        cells = [_text(c) for c in tr.find_all(["td", "th"])]
        if not cells or not cells[0]:
            continue
        label = cells[0].strip().lower()
        if label == "today":
            d = info["page_date"]
        else:
            m = re.match(r"(\d{1,2})\s*([a-z]+)", label)
            mon = month_no(m.group(2)) if m else None
            d = _infer_year(int(m.group(1)), mon, anchor) if (m and mon) else None
        if d is None:
            continue
        rows.append({
            "gmp_date": d,
            "gmp_amount": money(cells[1]) if len(cells) > 1 else None,
            "kostak": money(cell(cells, col["kostak"])),
            "subject_to": money(cell(cells, col["subject"])),
            "raw": " | ".join(cells),
        })
    # one row per date; the table is newest-first, so the first seen wins
    seen, deduped = set(), []
    for r in rows:
        if r["gmp_date"] not in seen:
            seen.add(r["gmp_date"])
            deduped.append(r)
    info["rows"] = sorted(deduped, key=lambda r: r["gmp_date"])
    return info


def t_minus_1(info: dict[str, Any]) -> dict[str, Any] | None:
    """The last quoted GMP dated strictly before the open date.

    Never a later reading - the whole point is what you could have known
    the evening before the issue opened.
    """
    od = info.get("open_date")
    if not od:
        return None
    before = [r for r in info["rows"] if r["gmp_date"] < od and r["gmp_amount"] is not None]
    return before[-1] if before else None


def fetch_live(*, use_cache: bool = False) -> list[dict[str, Any]]:
    return parse_performance(base.get(LIVE_URL, use_cache=use_cache))


def fetch_gmp(overview_url: str, *, use_cache: bool = False) -> tuple[str, dict[str, Any]]:
    """Resolve and parse one issue's GMP page, filling any missing issue
    dates from the overview page (older GMP pages don't repeat them)."""
    url, info = _fetch_gmp(overview_url, use_cache=use_cache)
    if not info.get("open_date") or not info.get("listing_date"):
        try:
            extra = _key_dates(BeautifulSoup(base.get(overview_url, use_cache=use_cache), "lxml"))
        except base.FetchError:
            extra = {}
        for k, v in extra.items():
            if v is not None and not info.get(k):
                info[k] = v
        if info.get("open_date") and info["rows"]:
            # re-anchor years now that the real open date is known
            info = {**info, **_reanchor(info)}
    return url, info


def _reanchor(info: dict[str, Any]) -> dict[str, Any]:
    anchor = info["open_date"]
    fixed = []
    for r in info["rows"]:
        d = _infer_year(r["gmp_date"].day, r["gmp_date"].month, anchor)
        fixed.append({**r, "gmp_date": d})
    return {"rows": sorted(fixed, key=lambda r: r["gmp_date"])}


def _fetch_gmp(overview_url: str, *, use_cache: bool = False) -> tuple[str, dict[str, Any]]:
    url = gmp_url_from_overview(overview_url)
    if url:
        try:
            html = base.get(url, use_cache=use_cache, retries=1)
        except base.FetchError:
            html = None  # a hard 404 on the guessed slug - fall through
        if html and not is_not_found(html):
            return url, parse_gmp_page(html)
    overview = base.get(overview_url, use_cache=use_cache)
    link = find_gmp_link(overview)
    if not link:
        raise ParseError(f"no GMP page found for {overview_url}")
    return link, parse_gmp_page(base.get(link, use_cache=use_cache))


# ---------------------------------------------------------------- live table

def _window(text: str, today: date) -> tuple[date | None, date | None]:
    """'28-30 Sep' -> (28 Sep, 30 Sep); '30-5 Oct' -> (30 Sep, 5 Oct).
    The month belongs to the close day; an open day larger than the close
    day means the window crosses a month end."""
    m = re.match(r"\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\s*([A-Za-z]+)", text or "")
    if not m:
        return None, None
    od, cd, mon = int(m.group(1)), int(m.group(2)), month_no(m.group(3))
    if not mon:
        return None, None
    close = _infer_year(cd, mon, today)
    if close is None:
        return None, None
    om, oy = (mon, close.year) if od <= cd else ((mon - 2) % 12 + 1, close.year - (mon == 1))
    try:
        return date(oy, om, od), close
    except ValueError:
        return None, close


def parse_live(html: str, today: date) -> list[dict[str, Any]]:
    """The live MAINBOARD table (the first table with this header; the second
    is SME). Rows: name, current GMP, upper price, window, status, links."""
    soup = BeautifulSoup(html, "lxml")
    for table in soup.find_all("table"):
        first = table.find("tr")
        head = [_text(c).lower() for c in first.find_all(["th", "td"])] if first else []
        if head and head[0] == "ipo name" and any("gmp" in h for h in head) and "status" in head:
            break
    else:
        raise ParseError("live mainboard GMP table not found")
    idx = {h: i for i, h in enumerate(head)}

    def col(cells, *names):
        for n in names:
            for h, i in idx.items():
                if h.startswith(n) and i < len(cells):
                    return cells[i]
        return None

    out = []
    for tr in table.find_all("tr")[1:]:
        cells = [_text(c) for c in tr.find_all("td")]
        a = tr.find("a", href=True)
        if len(cells) < 4 or not a:
            continue
        href = a["href"].replace("ipowatch.in//", "ipowatch.in/")
        open_d, close_d = _window(col(cells, "date") or "", today)
        out.append({
            "name": cells[0],
            "gmp_amount": money(col(cells, "ipo gmp")),
            "price_band_high": money(col(cells, "price band")),
            "open_date": open_d,
            "close_date": close_d,
            "status": (col(cells, "status") or "").strip(),
            "overview_url": href,
            "gmp_url": gmp_url_from_overview(href),
            "raw": " | ".join(cells),
        })
    return out

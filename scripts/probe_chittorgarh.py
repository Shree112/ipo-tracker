"""Reconnaissance, not a scraper.

Neither the cloud sandbox nor the sandboxed shell on this machine can
reach chittorgarh.com - both are behind an egress proxy that refuses it.
So rather than guess at markup and ship a parser that breaks on first
contact, this goes and looks. Run it from a normal Windows PowerShell
window, where your own internet connection applies.

It tries several candidate URLs for the performance tracker, reports
which respond, dumps every HTML table it finds with shape and column
names, and hunts for the year-selector links and the per-issue page ids
that everything downstream depends on.

Run it, paste me the output, and I'll write the real parser against
what's actually there.

    python scripts\\probe_chittorgarh.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd  # noqa: E402
import requests  # noqa: E402

import config  # noqa: E402
from sources import base  # noqa: E402

CANDIDATES = [
    "https://www.chittorgarh.com/ipo/ipo_perf_tracker.asp",
    "https://www.chittorgarh.com/ipo/ipo_perf_tracker.asp?year=2025",
    "https://www.chittorgarh.com/report/mainboard-ipo-performance/103/all/?year=2025",
    "https://www.chittorgarh.com/ipo/ipo_dashboard.asp",
]

RULE = "=" * 72


def describe_tables(html: str) -> None:
    try:
        tables = pd.read_html(html)
    except ValueError:
        print("  no parseable tables found")
        return
    except Exception as exc:
        print(f"  table parse failed: {type(exc).__name__}: {exc}")
        return

    print(f"  {len(tables)} table(s) found")
    for i, t in enumerate(tables):
        if t.shape[0] < 3:
            continue
        print(f"\n  --- table[{i}]  shape={t.shape}")
        print(f"      columns: {list(t.columns)[:12]}")
        with pd.option_context("display.width", 200, "display.max_columns", 14):
            print("      " + t.head(3).to_string().replace("\n", "\n      "))


def find_year_links(html: str) -> None:
    years = sorted(set(re.findall(r'href="([^"]*(?:year=|/)(?:19|20)\d{2}[^"]*)"', html)))
    if years:
        print(f"\n  year-ish links ({len(years)} found, first 12):")
        for u in years[:12]:
            print(f"      {u}")
    else:
        print("\n  no year links matched - the selector is probably a form POST or JS")


def find_issue_ids(html: str) -> None:
    ids = sorted(set(re.findall(r'href="(/ipo/[a-z0-9\-]+/(\d+)/?)"', html)))
    if ids:
        print(f"\n  per-issue page links ({len(ids)} found, first 8):")
        for href, num in ids[:8]:
            print(f"      id={num:>6}  {href}")
    else:
        print("\n  no /ipo/<slug>/<id>/ links on this page")


def main() -> None:
    print(f"user-agent: {config.USER_AGENT}")
    print(f"raw HTML saved under: {config.RAW}\n")

    session = requests.Session()
    reachable = 0

    for url in CANDIDATES:
        print(RULE)
        print(url)
        print(RULE)
        try:
            html = base.get(url, session=session)
        except base.FetchError as exc:
            print(f"  UNREACHABLE: {exc}\n")
            continue

        reachable += 1
        print(f"  OK, {len(html):,} bytes -> {base.cache_path(url).name}")
        describe_tables(html)
        find_year_links(html)
        find_issue_ids(html)
        print()

    print(RULE)
    if reachable == 0:
        print("Nothing was reachable. Check you are running this from a normal")
        print("PowerShell window and not inside a restricted shell, and try one")
        print("of those URLs in a browser to confirm the site itself is up.")
    else:
        print(f"{reachable}/{len(CANDIDATES)} candidate URLs reachable.")
        print("Paste this output back and I'll write the parser against it.")


if __name__ == "__main__":
    main()

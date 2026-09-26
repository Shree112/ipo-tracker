"""Reconnaissance for the GMP backfill - InvestorGain and IPO Watch.

Not a scraper. Fetches a handful of representative pages once, saves them to
data/raw/, and prints what each one looks like, so the real adapters get
written against what the sites actually serve.

    python scripts/probe_gmp.py

About 12 requests, 2.5s apart per host. Paste the output back into the chat.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config  # noqa: E402
from sources import base  # noqa: E402

IG = "https://www.investorgain.com"
IW = "https://ipowatch.in"

URLS = [
    # InvestorGain (a Chittorgarh product - its GMP tab is this data)
    ("ig-tracker-2024", f"{IG}/report/ipo-gmp-performance-tracker/377/ipo/?year=2024"),
    ("ig-tracker-2019", f"{IG}/report/ipo-gmp-performance-tracker/377/ipo/?year=2019"),
    ("ig-issue-hyundai", f"{IG}/gmp/hyundai-motor-ipo/1024/"),
    ("ig-issue-swiggy", f"{IG}/gmp/swiggy-ipo/1108/"),
    ("ig-issue-bharti-hexacom", f"{IG}/gmp/bharti-hexacom-ipo/0/"),  # id unknown on purpose
    # IPO Watch - independent operator, WordPress
    ("iw-live", f"{IW}/ipo-grey-market-premium-latest-ipo-gmp/"),
    ("iw-issue-hyundai", f"{IW}/hyundai-motor-india-ipo-gmp-grey-market-premium/"),
    ("iw-issue-swiggy", f"{IW}/swiggy-ipo-gmp-grey-market-premium/"),
    ("iw-issue-irctc-2019", f"{IW}/irctc-ipo-gmp-grey-market-premium/"),
]

_ARRAY_KEY = re.compile(r'"([A-Za-z_][A-Za-z0-9_]{2,})":\[\{')


def describe(html: str) -> list[str]:
    out = [f"bytes={len(html):,}  tables={html.lower().count('<table')}"]
    if "self.__next_f" in html:
        try:
            from sources.chittorgarh import flight_payload
            flight = flight_payload(html)
            keys = sorted(set(_ARRAY_KEY.findall(flight)))
            out.append(f"next.js payload: {len(flight):,} chars; arrays of objects: {', '.join(keys[:25]) or '-'}")
            for k in ("gmp", "GMP"):
                i = flight.find(f'"{k}')
                if i >= 0:
                    out.append(f"first '{k}' key context: {flight[max(0, i-80):i+160]!r}")
                    break
        except Exception as exc:  # noqa: BLE001
            out.append(f"next.js payload present but did not decode: {exc}")
    else:
        out.append("no next.js payload (plain HTML)")
    for pat in (r"cloudflare|cf-chl|captcha|access denied", r"GMP Trend|Day-wise|day wise"):
        hits = re.findall(pat, html, flags=re.I)
        if hits:
            out.append(f"contains: {sorted(set(h.lower() for h in hits))[:5]}")
    return out


def main() -> None:
    manifest = {}
    for label, url in URLS:
        print(f"\n== {label}\n   {url}")
        try:
            html = base.get(url)
        except base.FetchError as exc:
            print(f"   FAILED: {exc}")
            manifest[label] = {"url": url, "error": str(exc)}
            continue
        path = base.cache_path(url)
        manifest[label] = {"url": url, "file": path.name}
        for line in describe(html):
            print(f"   {line}")
    (config.RAW / "probe_gmp_manifest.json").write_text(json.dumps(manifest, indent=2))
    print("\nsaved pages + data/raw/probe_gmp_manifest.json")


if __name__ == "__main__":
    main()

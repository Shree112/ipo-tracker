"""Shared scraping plumbing.

Every source implements the same contract: fetch() -> list of normalised
dicts. When one site restructures we swap a single adapter and the rest
of the pipeline doesn't notice.
"""
from __future__ import annotations

import hashlib
import time
from pathlib import Path

import requests

import config

_LAST_CALL: dict[str, float] = {}


class FetchError(RuntimeError):
    pass


def _polite_wait(host: str) -> None:
    last = _LAST_CALL.get(host)
    if last is not None:
        gap = time.monotonic() - last
        if gap < config.REQUEST_DELAY:
            time.sleep(config.REQUEST_DELAY - gap)
    _LAST_CALL[host] = time.monotonic()


def cache_path(url: str, suffix: str = ".html") -> Path:
    digest = hashlib.sha1(url.encode()).hexdigest()[:16]
    return config.RAW / f"{digest}{suffix}"


def get(
    url: str,
    *,
    session: requests.Session | None = None,
    use_cache: bool = False,
    save_raw: bool = True,
    retries: int = 3,
) -> str:
    """GET a page politely.

    use_cache=True reads a previously saved copy if one exists - useful
    while iterating on a parser so you aren't re-hitting the site on
    every run. Always False in scheduled jobs.
    """
    path = cache_path(url)
    if use_cache and path.exists():
        return path.read_text(encoding="utf-8", errors="replace")

    sess = session or requests.Session()
    host = requests.utils.urlparse(url).netloc
    headers = {
        "User-Agent": config.USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
    }

    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        _polite_wait(host)
        try:
            resp = sess.get(url, headers=headers, timeout=config.REQUEST_TIMEOUT)
            if resp.status_code == 200:
                if save_raw:
                    path.write_text(resp.text, encoding="utf-8")
                return resp.text
            last_err = FetchError(f"HTTP {resp.status_code} for {url}")
        except requests.RequestException as exc:
            last_err = exc
        if attempt < retries:
            time.sleep(2 ** attempt)

    raise FetchError(f"failed after {retries} attempts: {url} ({last_err})")


def slugify(name: str) -> str:
    """Stable key for an issue across sources.

    Strips the trailing 'IPO' and the board marker so the same company
    resolves to one row whether it arrived from the tracker, the
    calendar or a GMP table.
    """
    s = name.strip().lower()
    for noise in (" ipo", " - sme", "(sme)", "(ipo)", " limited", " ltd.", " ltd"):
        s = s.replace(noise, " ")
    keep = [c if (c.isalnum() or c == " ") else " " for c in s]
    return "-".join("".join(keep).split())


def name_score(a: str, b: str) -> float:
    """Similarity of two slugs, treating a short brand name that prefixes the
    legal name ('ecos-mobility' vs 'ecos-india-mobility-hospitality') as a match."""
    import difflib

    ta, tb = a.split("-"), b.split("-")
    if ta and tb and ta[0] == tb[0] and (set(ta) <= set(tb) or set(tb) <= set(ta)):
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()

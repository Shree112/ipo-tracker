"""What retail investors are saying about an issue - comments from IPO Watch
and Reddit, gathered for the summariser.

IPO Watch
  Plain WordPress comments at the bottom of each issue's GMP page (the page we
  already read for GMP). robots.txt allows the pages and disallows /wp-json/,
  so the comments are read from the page HTML and the REST API is not used.
  Robots rules are checked at run time, so if the site ever disallows the
  pages, collection stops by itself.

Reddit
  Only through the official Data API with an approved app (Reddit requires
  pre-approval for API access). Needs REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET
  and REDDIT_USERNAME (for the User-Agent Reddit asks for). Without them the
  source reports "not_configured" and everything else carries on.
  Read-only: one search per live IPO, comments from at most 5 threads in the
  listed subreddits, twice a day. No posting, voting or messaging.

Each fetch returns {status, threads, comments}, comments newest first as
{id, text, at, score}. Text is trimmed; author names are not kept.
"""
from __future__ import annotations

import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib import robotparser
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

import config
from . import base

MAX_COMMENTS = 150
MAX_CHARS = 600

_robots: dict[str, robotparser.RobotFileParser] = {}


def robots_allowed(url: str) -> bool:
    """True when the site's robots.txt lets a generic crawler fetch url."""
    host = urlparse(url).scheme + "://" + urlparse(url).netloc
    rp = _robots.get(host)
    if rp is None:
        rp = robotparser.RobotFileParser()
        try:
            txt = requests.get(host + "/robots.txt", timeout=config.REQUEST_TIMEOUT,
                               headers={"User-Agent": config.USER_AGENT}).text
            rp.parse(txt.splitlines())
        except requests.RequestException:
            rp.parse([])  # unreachable robots.txt -> treated as allow, like most crawlers
        _robots[host] = rp
    return rp.can_fetch("*", url)


def _clean(text: str) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text[:MAX_CHARS]


# ------------------------------------------------------------------ IPO Watch

def parse_ipowatch_comments(html: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "lxml")
    area = soup.find(id="comments")
    if not area:
        return []
    out = []
    for body in area.select("article.comment-body"):
        cid = (body.get("id") or "").replace("div-comment-", "")
        # skip the site's own replies ("bypostauthor") - they're answers, not sentiment
        li = body.find_parent("li")
        if li and "bypostauthor" in (li.get("class") or []):
            continue
        content = body.select_one(".comment-content")
        t = body.select_one("time[datetime]")
        text = _clean(content.get_text(" ") if content else "")
        if not text:
            continue
        out.append({"id": f"iw-{cid}", "text": text, "at": t["datetime"] if t else None, "score": None})
    out.sort(key=lambda c: c["at"] or "", reverse=True)
    return out[:MAX_COMMENTS]


def fetch_ipowatch(url: str | None) -> dict[str, Any]:
    if not url:
        return {"status": "no_page", "threads": [], "comments": []}
    if not robots_allowed(url):
        return {"status": "blocked", "threads": [], "comments": []}
    html = base.get(url, save_raw=False)
    comments = parse_ipowatch_comments(html)
    return {"status": "ok", "threads": [{"title": "Comments on the GMP page", "url": url + "#comments", "n": len(comments)}],
            "comments": comments}


# --------------------------------------------------------------------- Reddit

REDDIT_AUTH = "https://www.reddit.com/api/v1/access_token"
# Only threads in these communities are read (the list given in the API access request).
SUBREDDITS = [x.strip().lower() for x in os.getenv(
    "REDDIT_SUBREDDITS", "IndianStockMarket,IndiaInvestments,IndianStreetBets,StockMarketIndia").split(",") if x.strip()]
REDDIT_API = "https://oauth.reddit.com"
_token: dict[str, Any] = {}


def reddit_configured() -> bool:
    return all(os.getenv(k, "").strip() for k in ("REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USERNAME"))


def _reddit_ua() -> str:
    return f"script:ipo-copilot:0.1 (by /u/{os.getenv('REDDIT_USERNAME', '').strip()})"


def _reddit_token() -> str:
    if _token.get("exp", 0) > time.time() + 60:
        return _token["value"]
    r = requests.post(REDDIT_AUTH, data={"grant_type": "client_credentials"},
                      auth=(os.environ["REDDIT_CLIENT_ID"], os.environ["REDDIT_CLIENT_SECRET"]),
                      headers={"User-Agent": _reddit_ua()}, timeout=config.REQUEST_TIMEOUT)
    r.raise_for_status()
    body = r.json()
    _token.update(value=body["access_token"], exp=time.time() + int(body.get("expires_in", 3600)))
    return _token["value"]


def _reddit_get(path: str, params: dict[str, Any]) -> Any:
    base._polite_wait("oauth.reddit.com")
    r = requests.get(REDDIT_API + path, params={**params, "raw_json": 1},
                     headers={"User-Agent": _reddit_ua(), "Authorization": f"bearer {_reddit_token()}"},
                     timeout=config.REQUEST_TIMEOUT)
    r.raise_for_status()
    return r.json()


def short_name(name: str) -> str:
    """'Orient Cables (India) Ltd.' -> 'Orient Cables'; used to match thread titles."""
    n = re.sub(r"\((?:india|i)\)|\b(ltd|limited|pvt|private|india)\b\.?", " ", name, flags=re.I)
    n = re.sub(r"[^\w&' -]", " ", n)
    words = [w for w in n.split() if w]
    return " ".join(words[:2]) if len(words) > 2 else " ".join(words)


def _walk(children: list[dict], out: list[dict], depth: int = 0) -> None:
    for c in children:
        if c.get("kind") != "t1":
            continue
        d = c["data"]
        body = _clean(d.get("body", ""))
        if body and body not in ("[deleted]", "[removed]") and d.get("author") != "AutoModerator":
            out.append({"id": f"rd-{d['id']}", "text": body,
                        "at": datetime.fromtimestamp(d["created_utc"], timezone.utc).isoformat(),
                        "score": d.get("score")})
        replies = d.get("replies")
        if depth < 2 and isinstance(replies, dict):
            _walk(replies["data"]["children"], out, depth + 1)


def fetch_reddit(name: str, since_days: int = 45) -> dict[str, Any]:
    if not reddit_configured():
        return {"status": "not_configured", "threads": [], "comments": []}
    key = short_name(name).lower()
    found = _reddit_get("/search", {"q": f'"{short_name(name)}" IPO', "sort": "new", "t": "month",
                                    "limit": 25, "type": "link"})
    cutoff = time.time() - since_days * 86400
    posts = []
    for p in found.get("data", {}).get("children", []):
        d = p["data"]
        title = d.get("title", "")
        if d.get("created_utc", 0) < cutoff or key not in title.lower():
            continue
        if str(d.get("subreddit", "")).lower() not in SUBREDDITS:
            continue
        posts.append(d)
    posts.sort(key=lambda d: d.get("num_comments", 0), reverse=True)
    threads, comments = [], []
    for d in posts[:5]:
        listing = _reddit_get(f"/comments/{d['id']}", {"limit": 200, "depth": 3, "sort": "top"})
        got: list[dict] = []
        if isinstance(listing, list) and len(listing) > 1:
            _walk(listing[1]["data"]["children"], got)
        threads.append({"title": d.get("title"), "url": "https://www.reddit.com" + d.get("permalink", ""),
                        "sub": d.get("subreddit"), "n": len(got)})
        comments.extend(got)
    comments.sort(key=lambda c: c["at"] or "", reverse=True)
    return {"status": "ok", "threads": threads, "comments": comments[:MAX_COMMENTS]}

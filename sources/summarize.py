"""Turn a pile of IPO comments into a short, neutral summary with a free,
open-weights model.

Default: Qwen3 4B (Apache-2.0) running under Ollama on the GitHub Actions
runner itself - no API key, no bill. About a minute per issue on the runner's
CPU. Any OpenAI-compatible endpoint works instead (for example a free Groq
key running an open Llama model) by setting:

    LLM_PROVIDER=openai  LLM_BASE_URL=https://api.groq.com/openai/v1
    LLM_API_KEY=...      LLM_MODEL=llama-3.3-70b-versatile

The model only ever sees comment text, never names or accounts, and is asked
for a fixed JSON shape, which is validated before anything is stored.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

import requests

PROVIDER = os.getenv("LLM_PROVIDER", "ollama").strip().lower()
BASE_URL = os.getenv("LLM_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.getenv("LLM_MODEL", "qwen3:4b").strip()
API_KEY = os.getenv("LLM_API_KEY", "").strip()
TIMEOUT = float(os.getenv("LLM_TIMEOUT_SECONDS", "420"))
INPUT_CHARS = int(os.getenv("LLM_INPUT_CHARS", "9000"))  # ~2.5k tokens; keeps CPU runs quick

MOODS = ("positive", "mixed", "negative", "unclear")

SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "mood": {"type": "string", "enum": list(MOODS)},
        "points": {"type": "array", "items": {"type": "string"}},
        "concerns": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["headline", "mood", "points", "concerns"],
}

SYSTEM = """You summarise what retail investors are saying about one Indian IPO.
The comments come from IPO Watch and Reddit; many are short, in English or Hinglish, and some are off-topic.

Return JSON only, with exactly these keys:
- "headline": one plain sentence (max 20 words) on the overall tone of the discussion.
- "mood": "positive", "mixed", "negative" or "unclear" (unclear if there is too little on-topic discussion).
- "points": 2 to 4 short bullets (max 18 words each) on the main things people say: listing expectations, GMP, subscription, valuation, the business, allotment chances.
- "concerns": 0 to 3 short bullets on worries raised (valuation, debt, OFS size, weak GMP, and so on).

Rules: report what commenters say, never your own opinion or advice. Do not invent numbers; only repeat figures that appear in the comments. Ignore spam, greetings and questions with no view. Write in simple English."""


def build_input(name: str, comments: list[dict[str, Any]]) -> str:
    """Highest-scored Reddit comments and the newest IPO Watch ones, up to the budget."""
    ranked = sorted(comments, key=lambda c: (c.get("score") or 0, c.get("at") or ""), reverse=True)
    lines, used = [], 0
    for c in ranked:
        src = "Reddit" if str(c.get("id", "")).startswith("rd-") else "IPO Watch"
        line = f"- [{src}] {c['text']}"
        if used + len(line) > INPUT_CHARS:
            break
        lines.append(line)
        used += len(line)
    return f"IPO: {name}\nComments ({len(lines)} of {len(comments)}):\n" + "\n".join(lines)


def _call(user: str) -> str:
    if PROVIDER == "ollama":
        r = requests.post(f"{BASE_URL}/api/chat", timeout=TIMEOUT, json={
            "model": MODEL,
            "stream": False,
            "think": False,
            "format": SCHEMA,
            "options": {"temperature": 0.2, "num_ctx": 8192},
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}],
        })
        r.raise_for_status()
        return r.json()["message"]["content"]
    r = requests.post(f"{BASE_URL}/chat/completions", timeout=TIMEOUT,
                      headers={"Authorization": f"Bearer {API_KEY}"} if API_KEY else {},
                      json={"model": MODEL, "temperature": 0.2,
                            "response_format": {"type": "json_object"},
                            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]})
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def _short(s: Any, words: int) -> str:
    s = re.sub(r"\s+", " ", str(s or "")).strip().strip("-•* ").strip()
    parts = s.split(" ")
    return " ".join(parts[:words]) + ("…" if len(parts) > words else "")


def validate(raw: str) -> dict[str, Any] | None:
    """Parse and tidy the model's answer; None if it isn't usable."""
    raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.S).strip()
    m = re.search(r"\{.*\}", raw, flags=re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    headline = _short(d.get("headline"), 24)
    mood = str(d.get("mood", "")).lower().strip()
    points = [_short(p, 22) for p in (d.get("points") or []) if str(p).strip()][:4]
    concerns = [_short(p, 22) for p in (d.get("concerns") or []) if str(p).strip()][:3]
    if not headline or mood not in MOODS or not points:
        return None
    return {"headline": headline, "mood": mood, "points": points, "concerns": concerns}


def summarise(name: str, comments: list[dict[str, Any]]) -> dict[str, Any] | None:
    user = build_input(name, comments)
    for _ in range(2):  # one retry: small models occasionally drift off the format
        try:
            out = validate(_call(user))
        except (requests.RequestException, KeyError, ValueError):
            out = None
        if out:
            return out
    return None


def model_label() -> str:
    return f"{PROVIDER}:{MODEL}"


# ------------------------------------------------------------ company profile

COMPANY_SCHEMA = {
    "type": "object",
    "properties": {
        "one_liner": {"type": "string"},
        "points": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["one_liner", "points"],
}

COMPANY_SYSTEM = """You explain what a company does to a retail investor, in plain English.
You get the company description from an IPO page. Return JSON only, with exactly these keys:
- "one_liner": one sentence (max 22 words) saying what the company does and for whom.
- "points": 3 or 4 short bullets (max 16 words each) covering: main products or services, key customers or markets, scale (plants, users, locations) and anything distinctive.
Rules: use only facts in the text; keep numbers exactly as given; no praise words like "leading" or "renowned"; no investment opinion; write in your own words, don't copy sentences."""


def summarise_company(name: str, about: str) -> dict[str, Any] | None:
    user = f"Company: {name}\n\nDescription:\n{about[:INPUT_CHARS]}"
    for _ in range(2):
        try:
            if PROVIDER == "ollama":
                r = requests.post(f"{BASE_URL}/api/chat", timeout=TIMEOUT, json={
                    "model": MODEL, "stream": False, "think": False, "format": COMPANY_SCHEMA,
                    "options": {"temperature": 0.2, "num_ctx": 8192},
                    "messages": [{"role": "system", "content": COMPANY_SYSTEM}, {"role": "user", "content": user}],
                })
                r.raise_for_status()
                raw = r.json()["message"]["content"]
            else:
                r = requests.post(f"{BASE_URL}/chat/completions", timeout=TIMEOUT,
                                  headers={"Authorization": f"Bearer {API_KEY}"} if API_KEY else {},
                                  json={"model": MODEL, "temperature": 0.2, "response_format": {"type": "json_object"},
                                        "messages": [{"role": "system", "content": COMPANY_SYSTEM},
                                                     {"role": "user", "content": user}]})
                r.raise_for_status()
                raw = r.json()["choices"][0]["message"]["content"]
        except (requests.RequestException, KeyError, ValueError):
            continue
        raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.S)
        m = re.search(r"\{.*\}", raw, flags=re.S)
        if not m:
            continue
        try:
            d = json.loads(m.group(0))
        except json.JSONDecodeError:
            continue
        one = _short(d.get("one_liner"), 26)
        pts = [_short(p, 20) for p in (d.get("points") or []) if str(p).strip()][:4]
        if one and len(pts) >= 2:
            return {"one_liner": one, "points": pts}
    return None

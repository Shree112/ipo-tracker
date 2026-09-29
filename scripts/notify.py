"""Delivery: email and/or Telegram, per member, plus a record of failures.

Each member picks a channel on the Alerts page: email (default), telegram or
both. Telegram only counts once they've linked the bot (telegram_chat_id is
set); until then, "telegram" falls back to email so nobody silently loses
their digest.

A failed delivery never stops the run: it's logged to app_event as
'delivery_failed' (the admin dashboard and health check read it) and the next
person's message goes out.
"""
from __future__ import annotations

import html as _html
import json
import os
from typing import Callable

import requests

TG_API = "https://api.telegram.org/bot{token}/{method}"


def telegram_configured() -> bool:
    return bool(os.getenv("TELEGRAM_BOT_TOKEN", "").strip())


def send_telegram(chat_id: int, text: str, buttons: list[list[tuple[str, str]]] | None = None) -> None:
    """text uses Telegram's HTML subset (<b>, <i>, <a href>). buttons: rows of (label, url)."""
    token = os.environ["TELEGRAM_BOT_TOKEN"].strip()
    payload: dict = {"chat_id": chat_id, "text": text[:4000], "parse_mode": "HTML", "disable_web_page_preview": True}
    if buttons:
        payload["reply_markup"] = {"inline_keyboard": [[{"text": t, "url": u} for t, u in row if u] for row in buttons]}
    r = requests.post(TG_API.format(token=token, method="sendMessage"), json=payload, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"telegram {r.status_code}: {r.text[:200]}")


def esc(s: object) -> str:
    return _html.escape(str(s), quote=False)


def log_event(conn, kind: str, user_id: str | None = None, issue_id: int | None = None, meta: dict | None = None) -> None:
    try:
        with conn.cursor() as cur:
            cur.execute("INSERT INTO app_event (kind, user_id, issue_id, meta) VALUES (%s, %s::uuid, %s, %s)",
                        (kind, user_id, issue_id, json.dumps(meta) if meta else None))
        conn.commit()
    except Exception:  # the log is best-effort; never block a send on it
        conn.rollback()


def deliver(conn, u: dict, *, send_email: Callable[[str, str, str, str], str], subject: str, html_body: str,
            text_body: str, tg_text: str | None = None, tg_buttons=None, what: str = "digest") -> str | None:
    """Send to the member's chosen channel(s). Returns a provider label, or None if everything failed."""
    channel = (u.get("channel") or "email").lower()
    chat = u.get("telegram_chat_id")
    use_tg = bool(chat) and telegram_configured() and channel in ("telegram", "both") and tg_text
    use_email = channel in ("email", "both") or not use_tg
    sent = []
    if use_email:
        to = u.get("email_to") or u.get("to_addr") or u["email"]
        try:
            sent.append(send_email(to, subject, html_body, text_body))
        except Exception as exc:  # noqa: BLE001
            log_event(conn, "delivery_failed", u.get("user_id") or u.get("uid"),
                      meta={"channel": "email", "what": what, "error": str(exc)[:300]})
    if use_tg:
        try:
            send_telegram(int(chat), tg_text, tg_buttons)
            sent.append("telegram")
        except Exception as exc:  # noqa: BLE001
            log_event(conn, "delivery_failed", u.get("user_id") or u.get("uid"),
                      meta={"channel": "telegram", "what": what, "error": str(exc)[:300]})
    return "+".join(sent) or None

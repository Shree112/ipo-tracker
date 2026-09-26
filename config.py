"""Central config. Everything secret lives in .env, never in code."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
RAW = DATA / "raw"
RAW.mkdir(parents=True, exist_ok=True)

load_dotenv(ROOT / ".env")


def _req(name: str) -> str:
    val = os.getenv(name, "").strip()
    if not val:
        raise SystemExit(
            f"\n{name} is not set in .env\n"
            f"Open {ROOT / '.env'} and fill it in, then run this again.\n"
        )
    return val


def database_url() -> str:
    """Read lazily so scripts that don't touch the DB still run."""
    return _req("DATABASE_URL")


SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()

REQUEST_DELAY = float(os.getenv("REQUEST_DELAY_SECONDS", "2.5"))
REQUEST_TIMEOUT = float(os.getenv("REQUEST_TIMEOUT_SECONDS", "30"))
USER_AGENT = os.getenv("USER_AGENT", "ipo-tracker/0.1")

BACKFILL_YEAR_FROM = int(os.getenv("BACKFILL_YEAR_FROM", "2019"))
BACKFILL_YEAR_TO = int(os.getenv("BACKFILL_YEAR_TO", "2026"))

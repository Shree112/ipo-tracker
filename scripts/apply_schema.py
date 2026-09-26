"""Apply schema.sql to the Supabase Postgres database.

Idempotent - safe to re-run after editing the schema.

    python scripts/apply_schema.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import psycopg  # noqa: E402

import config  # noqa: E402
import db  # noqa: E402

EXPECTED = [
    "issues",
    "gmp_history",
    "subscription",
    "signal_snapshot",
    "listing_outcome",
    "issue_status",
    "scrape_run",
]


def main() -> None:
    sql = (config.ROOT / "schema.sql").read_text(encoding="utf-8")

    try:
        with db.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(sql)
            print("schema applied\n")

            with conn.cursor() as cur:
                cur.execute(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema = 'public' ORDER BY table_name"
                )
                present = {r["table_name"] for r in cur.fetchall()}

    except psycopg.OperationalError as exc:
        print(f"could not connect: {exc}\n")
        print("Most likely causes, in order:")
        print("  1. DATABASE_URL is still blank in .env")
        print("  2. The direct connection needs IPv6 - switch to the Session")
        print("     pooler string from Dashboard -> Connect (port 5432,")
        print("     username postgres.wvxahfuyxrqpdaokyxub)")
        print("  3. A special character in the password needs percent-encoding")
        raise SystemExit(1)

    for name in EXPECTED:
        print(f"  {'ok  ' if name in present else 'MISS'}  {name}")

    missing = [n for n in EXPECTED if n not in present]
    if missing:
        raise SystemExit(f"\nmissing tables: {', '.join(missing)}")
    print("\nall tables present")


if __name__ == "__main__":
    main()

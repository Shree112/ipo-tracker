"""Apply schema.sql to the Supabase Postgres database.

Idempotent - safe to re-run after editing the schema. The GitHub jobs run
this before they start; when schema.sql hasn't changed since the last apply it
does nothing, because applying takes brief exclusive locks on the tables and
every page of the site would queue behind them.

    python scripts/apply_schema.py            # apply if schema.sql changed
    python scripts/apply_schema.py --force    # apply anyway
"""
from __future__ import annotations

import hashlib
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
    digest = hashlib.sha256(sql.replace("\r\n", "\n").encode()).hexdigest()[:16]
    force = "--force" in sys.argv

    try:
        with db.connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regclass('public.schema_meta') IS NOT NULL AS ok")
                if cur.fetchone()["ok"]:
                    cur.execute("SELECT value FROM schema_meta WHERE key = 'schema_sha'")
                    row = cur.fetchone()
                    if row and row["value"] == digest and not force:
                        print(f"schema unchanged ({digest}) - nothing to apply")
                        return
            conn.commit()
            with conn.cursor() as cur:
                # Schema changes need a moment of exclusive access to each table,
                # and while this waits, the site's reads queue behind it. So if a
                # job is holding a table, give up quickly with a clear message.
                cur.execute("SET LOCAL lock_timeout = '5s'")
                try:
                    cur.execute(sql)
                except psycopg.errors.LockNotAvailable:
                    raise SystemExit(
                        "\nA table is busy - most likely a GitHub job (chatter or the hourly refresh) is\n"
                        "running right now. Wait for it to finish (Actions tab), then run this again.\n")
                cur.execute("""INSERT INTO schema_meta (key, value) VALUES ('schema_sha', %s)
                               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()""",
                            (digest,))
            conn.commit()
            print(f"schema applied ({digest})\n")

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

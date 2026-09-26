"""Remove everything the IPO Watch GMP backfill wrote, so it can be reloaded.

    python scripts\\reset_gmp_backfill.py

Needed once: the first backfill run misparsed some pages and paired one
issue with the wrong company, and the append-only tables (correctly) refuse
to let a rerun overwrite those rows. This is the deliberate, scoped repair
the schema comments describe - it touches only capture_mode='backfill' GMP
rows, the T-1 snapshots the backfill created, and the issue fields it filled.
Live data and the Chittorgarh listing backfill are left alone.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402


def main() -> None:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("ALTER TABLE gmp_history DISABLE TRIGGER gmp_history_append_only")
        cur.execute("ALTER TABLE signal_snapshot DISABLE TRIGGER signal_snapshot_append_only")

        cur.execute("DELETE FROM gmp_history WHERE source = 'ipowatch' AND capture_mode = 'backfill'")
        g = cur.rowcount
        cur.execute("""DELETE FROM signal_snapshot
                       WHERE phase = 't_minus_1' AND extras->>'source' = 'ipowatch-backfill'""")
        s = cur.rowcount
        # Only the GMP loader writes these four fields so far (the Chittorgarh
        # tracker has no open/close dates or price band), so clearing them on
        # the issues it touched is exact.
        cur.execute("""UPDATE issues SET open_date = NULL, close_date = NULL,
                              price_band_low = NULL, price_band_high = NULL, ipowatch_url = NULL
                       WHERE ipowatch_url IS NOT NULL""")
        i = cur.rowcount

        cur.execute("ALTER TABLE gmp_history ENABLE TRIGGER gmp_history_append_only")
        cur.execute("ALTER TABLE signal_snapshot ENABLE TRIGGER signal_snapshot_append_only")
    print(f"removed {g} backfilled GMP rows, {s} T-1 snapshots; cleared dates on {i} issues")
    print("append-only triggers re-enabled")


if __name__ == "__main__":
    main()

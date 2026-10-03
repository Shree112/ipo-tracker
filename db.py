"""Thin Postgres helpers. psycopg 3, no ORM - the schema is small
and explicit SQL is easier to reason about than a mapping layer."""
from __future__ import annotations

import contextlib
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row

import config


@contextlib.contextmanager
def connect() -> Iterator[psycopg.Connection]:
    """One connection, committed on clean exit, rolled back on error."""
    # prepare_threshold=None: never create server-side prepared statements.
    # Supabase's pooler can hand the connection a different backend between
    # statements, and a reused name then fails with "prepared statement
    # _pg3_0 already exists" (seen in the chatter job).
    conn = psycopg.connect(config.database_url(), row_factory=dict_row, prepare_threshold=None)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def fetch_all(sql: str, params: tuple | dict | None = None) -> list[dict[str, Any]]:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def fetch_one(sql: str, params: tuple | dict | None = None) -> dict[str, Any] | None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone()


def upsert_issue(conn: psycopg.Connection, *, slug: str, name: str, **fields: Any) -> int:
    """Insert or update an issue by slug, returning its id.

    Only overwrites a column when the incoming value is not NULL, so a
    thin source (the performance tracker) can't blank out richer data
    written earlier by the per-issue page scrape.
    """
    cols = ["slug", "name", *fields.keys()]
    vals = [slug, name, *fields.values()]
    placeholders = ", ".join(["%s"] * len(cols))
    updates = ", ".join(
        f"{c} = COALESCE(EXCLUDED.{c}, issues.{c})" for c in cols if c != "slug"
    )
    sql = (
        f"INSERT INTO issues ({', '.join(cols)}) VALUES ({placeholders}) "
        f"ON CONFLICT (slug) DO UPDATE SET {updates} "
        f"RETURNING id"
    )
    with conn.cursor() as cur:
        cur.execute(sql, vals)
        row = cur.fetchone()
        assert row is not None
        return row["id"]


class RunLog:
    """Records every scrape attempt. A source that silently returns
    zero rows is the failure mode that quietly rots the dataset, so
    'empty' is recorded as distinct from 'ok'."""

    def __init__(self, conn: psycopg.Connection, source: str) -> None:
        self.conn = conn
        self.source = source
        self.id: int | None = None
        self.seen = 0
        self.written = 0

    def __enter__(self) -> "RunLog":
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO scrape_run (source) VALUES (%s) RETURNING id",
                (self.source,),
            )
            row = cur.fetchone()
            assert row is not None
            self.id = row["id"]
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        if exc_type is not None:
            status, message = "error", f"{exc_type.__name__}: {exc}"[:2000]
        elif getattr(self, "error", None) and self.written == 0:
            # the caller caught a fetch/parse failure and carried on
            status, message = "error", str(self.error)[:2000]
        elif self.written == 0 and getattr(self, "ok_if_seen", False) and self.seen > 0:
            # frequent refreshes often find nothing new - that's not a failure
            status, message = "ok", "no changes since last run"
        elif self.written == 0:
            status, message = "empty", "scraper completed but wrote nothing"
        else:
            status, message = "ok", None
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE scrape_run SET finished_at = now(), status = %s, "
                "rows_seen = %s, rows_written = %s, message = %s WHERE id = %s",
                (status, self.seen, self.written, message, self.id),
            )
        return False

import { cache } from "react";
import type postgres from "postgres";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db, within } from "./db";
import { recordVisit } from "./events";

// Who is looking at the page. The middleware has already verified the
// Supabase session and passed the user's id and email in request headers;
// this adds the account row (approval status, admin flag) from our own
// app_users table.
//
// Accounts: anyone can sign in with Google and is in straight away, until
// MAX_USERS (default 80) accounts exist. After that new sign-ups go on a
// waitlist (status 'pending') and get in, oldest first, when a place frees up.
// The admin (ADMIN_EMAIL) can remove people from /admin.

export type Viewer = {
  id: string;
  email: string;
  name: string | null;
  status: "pending" | "approved" | "rejected";
  isAdmin: boolean;
  pending: number; // sign-ups waiting, for the admin's badge (0 for others)
};

export const maxUsers = () => Math.max(1, Number(process.env.MAX_USERS) || 80);
const adminEmail = () => (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();

async function viewerHeaders() {
  const h = await headers();
  const id = h.get("x-viewer-id");
  const email = h.get("x-viewer-email");
  if (!id || !email) return null;
  return { id, email, name: decodeURIComponent(h.get("x-viewer-name") ?? "") || null };
}

// One sign-up at a time, so two people signing in together can't both take
// the last place. A reserved connection with BEGIN/COMMIT, because the shared
// client runs with pipelining off (see db.ts), which sql.begin() can't use.
// The advisory lock is transaction-scoped: released at COMMIT/ROLLBACK.
const SIGNUP_LOCK = 4207;

async function underSignupLock<T>(fn: (sql: postgres.ReservedSql) => Promise<T>): Promise<T> {
  const sql = await db().reserve();
  try {
    await sql`BEGIN`;
    await sql`SELECT pg_advisory_xact_lock(${SIGNUP_LOCK})`;
    const out = await fn(sql);
    await sql`COMMIT`;
    return out;
  } catch (e) {
    await sql`ROLLBACK`.catch(() => undefined);
    throw e;
  } finally {
    sql.release();
  }
}

/** Create or refresh the account row for someone who just signed in. New
 *  accounts are approved while there is room (MAX_USERS); after that they go
 *  on the waitlist. A waitlisted account is let in on its next sign-in if a
 *  place has freed up. Removed ('rejected') accounts stay out. The
 *  ADMIN_EMAIL account is always approved and made admin. */
export async function ensureAccount(id: string, email: string, name: string | null) {
  const isAdmin = adminEmail() !== "" && email.toLowerCase() === adminEmail();
  const row = await underSignupLock(async (sql) => {
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app_users WHERE status = 'approved' AND user_id <> ${id}::uuid`;
    const admit = isAdmin || n < maxUsers();
    const [r] = await sql<{ status: Viewer["status"]; is_admin: boolean }[]>`
      INSERT INTO app_users (user_id, email, name, status, is_admin, decided_at, last_seen_at, welcome_sent_at)
      VALUES (${id}::uuid, ${email}, ${name},
              ${admit ? "approved" : "pending"}, ${isAdmin}, ${admit ? sql`now()` : null}, now(),
              ${isAdmin ? sql`now()` : null})
      ON CONFLICT (user_id) DO UPDATE SET
        email = EXCLUDED.email,
        name = COALESCE(EXCLUDED.name, app_users.name),
        last_seen_at = now(),
        is_admin = app_users.is_admin OR EXCLUDED.is_admin,
        status = CASE WHEN EXCLUDED.is_admin THEN 'approved'
                      WHEN app_users.status = 'pending' AND ${admit} THEN 'approved'
                      ELSE app_users.status END,
        decided_at = CASE WHEN app_users.status = 'pending' AND (EXCLUDED.is_admin OR ${admit}) THEN now()
                          ELSE app_users.decided_at END
      RETURNING status, is_admin`;
    if (r.status === "approved") {
      await sql`INSERT INTO alert_rules (user_id) VALUES (${id}::uuid) ON CONFLICT (user_id) DO NOTHING`;
    }
    return r;
  });
  if (row.is_admin) {
    // the owner's decisions from the single-user days move into the account
    await db()`
      INSERT INTO user_issue_status (user_id, issue_id, status, first_notified_at, resolved_at, note)
      SELECT ${id}::uuid, s.issue_id, s.status, s.first_notified_at, s.resolved_at, s.note
      FROM issue_status s WHERE s.status <> 'eligible'
      ON CONFLICT (user_id, issue_id) DO NOTHING`.catch(() => undefined);
  }
  return row;
}

/** Let waitlisted people in, oldest first, while there are free places -
 *  after the admin removes someone or MAX_USERS goes up. Returns how many got
 *  in; their "You're in" email goes out with the next account-email run. */
export async function admitWaitlist(): Promise<number> {
  return underSignupLock(async (sql) => {
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM app_users WHERE status = 'approved'`;
    const room = Math.max(0, maxUsers() - n);
    if (!room) return 0;
    const admitted = await sql<{ user_id: string }[]>`
      UPDATE app_users SET status = 'approved', decided_at = now()
      WHERE user_id IN (SELECT user_id FROM app_users WHERE status = 'pending' ORDER BY created_at LIMIT ${room})
      RETURNING user_id::text AS user_id`;
    for (const a of admitted) {
      await sql`INSERT INTO alert_rules (user_id) VALUES (${a.user_id}::uuid) ON CONFLICT (user_id) DO NOTHING`;
    }
    return admitted.length;
  });
}

/** The signed-in viewer, or null when signed out. Cached per request. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const v = await viewerHeaders();
  if (!v) return null;
  const load = () => db()<{ email: string; name: string | null; status: Viewer["status"]; is_admin: boolean; pending: number }[]>`
    SELECT u.email, u.name, u.status, u.is_admin,
           CASE WHEN u.is_admin THEN (SELECT count(*)::int FROM app_users WHERE status = 'pending') ELSE 0 END AS pending
    FROM app_users u WHERE u.user_id = ${v.id}::uuid`;
  let [row] = await within(load(), 8000, "account");
  if (!row) {
    // signed in, but no account row (e.g. the callback's write failed)
    await within(ensureAccount(v.id, v.email, v.name), 8000, "account");
    [row] = await within(load(), 8000, "account");
  }
  if (row.status === "approved") recordVisit(v.id);
  return { id: v.id, email: row.email, name: row.name, status: row.status, isAdmin: row.is_admin, pending: row.pending };
});

/** The viewer's id straight from the verified headers - no database trip, so
 *  data queries can start in parallel with getViewer(). */
export async function viewerId(): Promise<string | null> {
  return (await viewerHeaders())?.id ?? null;
}

/** For pages that show data: signed in *and* approved. */
export async function requireApproved(): Promise<Viewer> {
  const v = await getViewer();
  if (!v) redirect("/signin");
  if (v.status !== "approved") redirect("/pending");
  return v;
}

export async function requireAdmin(): Promise<Viewer> {
  const v = await requireApproved();
  if (!v.isAdmin) redirect("/");
  return v;
}

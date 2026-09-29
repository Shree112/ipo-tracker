import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db, within } from "./db";
import { recordVisit } from "./events";

// Who is looking at the page. The middleware has already verified the
// Supabase session and passed the user's id and email in request headers;
// this adds the account row (approval status, admin flag) from our own
// app_users table.
//
// Accounts: anyone can sign in with Google, which creates a *pending* account.
// The admin (ADMIN_EMAIL) approves people from /admin, up to MAX_USERS. Only
// approved accounts see the data.

export type Viewer = {
  id: string;
  email: string;
  name: string | null;
  status: "pending" | "approved" | "rejected";
  isAdmin: boolean;
  pending: number; // sign-ups waiting, for the admin's badge (0 for others)
};

export const maxUsers = () => Math.max(1, Number(process.env.MAX_USERS) || 100);
const adminEmail = () => (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();

async function viewerHeaders() {
  const h = await headers();
  const id = h.get("x-viewer-id");
  const email = h.get("x-viewer-email");
  if (!id || !email) return null;
  return { id, email, name: decodeURIComponent(h.get("x-viewer-name") ?? "") || null };
}

/** Create or refresh the account row for someone who just signed in. The
 *  ADMIN_EMAIL account is approved and made admin on its first sign-in. */
export async function ensureAccount(id: string, email: string, name: string | null) {
  const sql = db();
  const isAdmin = adminEmail() !== "" && email.toLowerCase() === adminEmail();
  const [row] = await sql<{ status: string; is_admin: boolean }[]>`
    INSERT INTO app_users (user_id, email, name, status, is_admin, decided_at, last_seen_at, welcome_sent_at)
    VALUES (${id}::uuid, ${email}, ${name},
            ${isAdmin ? "approved" : "pending"}, ${isAdmin}, ${isAdmin ? sql`now()` : null}, now(),
            ${isAdmin ? sql`now()` : null})
    ON CONFLICT (user_id) DO UPDATE SET
      email = EXCLUDED.email,
      name = COALESCE(EXCLUDED.name, app_users.name),
      last_seen_at = now(),
      is_admin = app_users.is_admin OR EXCLUDED.is_admin,
      status = CASE WHEN EXCLUDED.is_admin THEN 'approved' ELSE app_users.status END
    RETURNING status, is_admin`;
  if (row.status === "approved") {
    await sql`INSERT INTO alert_rules (user_id) VALUES (${id}::uuid) ON CONFLICT (user_id) DO NOTHING`;
  }
  if (row.is_admin) {
    // the owner's decisions from the single-user days move into the account
    await sql`
      INSERT INTO user_issue_status (user_id, issue_id, status, first_notified_at, resolved_at, note)
      SELECT ${id}::uuid, s.issue_id, s.status, s.first_notified_at, s.resolved_at, s.note
      FROM issue_status s WHERE s.status <> 'eligible'
      ON CONFLICT (user_id, issue_id) DO NOTHING`.catch(() => undefined);
  }
  return row;
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

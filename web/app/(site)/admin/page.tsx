import { redirect } from "next/navigation";
import AdminTabs from "@/components/AdminTabs";
import { revalidatePath } from "next/cache";
import { db, within } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { getViewer, maxUsers, requireAdmin } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Members" };

type Member = {
  user_id: string;
  email: string;
  name: string | null;
  status: "pending" | "approved" | "rejected";
  is_admin: boolean;
  created_at: Date;
  last_seen_at: Date | null;
  rules: string | null;
};

async function decide(fd: FormData) {
  "use server";
  const v = await getViewer();
  if (!v?.isAdmin || v.status !== "approved") redirect("/");
  const id = String(fd.get("id") ?? "");
  const to = String(fd.get("to") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id) || !["approved", "rejected"].includes(to) || id === v.id) redirect("/admin");
  const sql = db();
  if (to === "approved") {
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM app_users WHERE status = 'approved'`;
    if (n >= maxUsers()) redirect("/admin?full=1");
    await sql`UPDATE app_users SET status = 'approved', decided_at = now() WHERE user_id = ${id}::uuid`;
    await sql`INSERT INTO alert_rules (user_id) VALUES (${id}::uuid) ON CONFLICT (user_id) DO NOTHING`;
  } else {
    await sql`UPDATE app_users SET status = 'rejected', decided_at = now() WHERE user_id = ${id}::uuid AND NOT is_admin`;
  }
  revalidatePath("/admin");
  redirect("/admin");
}

const when = (d: Date | null) => (d ? fmtDate(d.toISOString().slice(0, 10)) : "–");

function Row({ m, actions }: { m: Member; actions: [string, string, string][] }) {
  return (
    <div className="member">
      <div className="who">
        <b>{m.name || m.email}</b>
        <span className="small muted">
          {m.name ? `${m.email} · ` : ""}joined {when(m.created_at)}
          {m.last_seen_at ? ` · seen ${when(m.last_seen_at)}` : ""}
        </span>
        {m.rules ? <span className="xs muted">{m.rules}</span> : null}
      </div>
      <div className="acts">
        {m.is_admin ? <span className="badge blue">Admin</span> : null}
        {actions.map(([to, label, cls]) => (
          <form key={to} action={decide}>
            <input type="hidden" name="id" value={m.user_id} />
            <input type="hidden" name="to" value={to} />
            <button className={`btn ${cls}`} type="submit">
              {label}
            </button>
          </form>
        ))}
      </div>
    </div>
  );
}

export default async function Admin({ searchParams }: { searchParams: Promise<{ full?: string }> }) {
  const { full } = await searchParams;
  const [viewer, members] = await within(Promise.all([
    requireAdmin(),
    db()<Member[]>`
      SELECT u.user_id::text AS user_id, u.email, u.name, u.status, u.is_admin, u.created_at, u.last_seen_at,
             CASE WHEN r.user_id IS NULL THEN NULL ELSE
               concat_ws(' · ',
                 CASE WHEN r.gmp_pct_min IS NOT NULL THEN 'GMP ' || r.gmp_pct_min::float || '%' END,
                 CASE WHEN r.profit_per_lot_min IS NOT NULL THEN 'profit ₹' || r.profit_per_lot_min::float END,
                 CASE WHEN r.sub_retail_min IS NOT NULL THEN 'retail ' || r.sub_retail_min::float || 'x' END,
                 CASE WHEN r.sub_total_min IS NOT NULL THEN 'total ' || r.sub_total_min::float || 'x' END,
                 r.match_mode, lpad(r.digest_hour::text, 2, '0') || ':00',
                 CASE WHEN r.paused THEN 'paused' END) END AS rules
      FROM app_users u LEFT JOIN alert_rules r ON r.user_id = u.user_id
      ORDER BY u.created_at`,
  ]), 9000, "members");
  const pending = members.filter((m) => m.status === "pending");
  const approved = members.filter((m) => m.status === "approved");
  const rejected = members.filter((m) => m.status === "rejected");
  const cap = maxUsers();
  const isFull = approved.length >= cap;

  return (
    <>
      <main className="wrap narrow">
        <div className="page-head">
          <div>
            <div className="eyebrow">Admin</div>
            <h1 style={{ marginTop: 10 }}>Members</h1>
            <p>
              {approved.length} of {cap} places taken{pending.length ? ` · ${pending.length} waiting` : ""}.
            </p>
          </div>
          <AdminTabs current="members" pending={pending.length} />
        </div>
        <div className="capbar" aria-hidden>
          <span style={{ width: `${Math.min(100, (approved.length / cap) * 100)}%` }} />
        </div>

        {full || (isFull && pending.length) ? (
          <div className="warn-line">All {cap} places are taken. Remove someone, or raise MAX_USERS on Vercel.</div>
        ) : null}

        <section className="card section">
          <div className="card-head">
            <h2>Waiting for approval</h2>
            <span className="sub">{pending.length || "none"}</span>
          </div>
          {pending.length ? (
            pending.map((m) => (
              <Row
                key={m.user_id}
                m={m}
                actions={[
                  ["rejected", "Decline", "ghost"],
                  ["approved", "Approve", "primary"],
                ]}
              />
            ))
          ) : (
            <p className="small muted">No one right now. New sign-ups show up here, and you get an email within the hour.</p>
          )}
        </section>

        <section className="card section">
          <div className="card-head">
            <h2>Members</h2>
            <span className="sub">{approved.length}</span>
          </div>
          {approved.map((m) => (
            <Row key={m.user_id} m={m} actions={m.user_id === viewer.id ? [] : [["rejected", "Remove", "ghost"]]} />
          ))}
        </section>

        {rejected.length ? (
          <section className="card section">
            <div className="card-head">
              <h2>Declined or removed</h2>
              <span className="sub">{rejected.length}</span>
            </div>
            {rejected.map((m) => (
              <Row key={m.user_id} m={m} actions={[["approved", "Approve", ""]]} />
            ))}
          </section>
        ) : null}
      </main>
    </>
  );
}

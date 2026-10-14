import { redirect } from "next/navigation";
import { ensureAccount, getViewer, maxUsers } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Waitlist" };

export default async function Pending() {
  const v = await getViewer();
  if (!v) redirect("/signin");
  if (v.status === "approved") redirect("/");
  if (v.status === "pending") {
    // a place may have opened since they signed up
    const now = await ensureAccount(v.id, v.email, v.name).catch(() => null);
    if (now?.status === "approved") redirect("/");
  }
  const first = v.name?.split(" ")[0];
  return (
    <>
      <main className="wrap">
        <div className="center-card">
          <div className="card" style={{ padding: 28, display: "grid", gap: 12 }}>
            {v.status === "rejected" ? (
              <>
                <h1 style={{ fontSize: 22 }}>No access for this account</h1>
                <p className="muted">
                  {v.email} isn&apos;t on the member list. If you think that&apos;s a mistake, reply to whoever shared the
                  link with you.
                </p>
              </>
            ) : (
              <>
                <span className="badge amber" style={{ justifySelf: "start" }}>
                  <span className="dot" aria-hidden /> On the waitlist
                </span>
                <h1 style={{ fontSize: 22 }}>Thanks{first ? `, ${first}` : ""}. We&apos;re full right now.</h1>
                <p className="muted">
                  IPO Copilot is limited to {maxUsers()} members and every place is taken. You&apos;re on the waitlist:
                  when a place opens you get in automatically, oldest sign-up first, and we email{" "}
                  <b style={{ color: "var(--ink)" }}>{v.email}</b>.
                </p>
              </>
            )}
            <form action="/auth/signout" method="post">
              <button className="btn ghost" type="submit">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </main>
    </>
  );
}

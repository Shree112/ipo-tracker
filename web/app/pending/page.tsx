import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Waiting for approval" };

export default async function Pending() {
  const v = await getViewer();
  if (!v) redirect("/signin");
  if (v.status === "approved") redirect("/");
  const first = v.name?.split(" ")[0];
  return (
    <>
      <TopBar viewer={v} />
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
                  <span className="dot" aria-hidden /> Waiting for approval
                </span>
                <h1 style={{ fontSize: 22 }}>Thanks{first ? `, ${first}` : ""}. You&apos;re on the list.</h1>
                <p className="muted">
                  Accounts are approved by hand. You&apos;ll get an email at <b style={{ color: "var(--ink)" }}>{v.email}</b>{" "}
                  once you&apos;re in, and your first digest the next morning an IPO matches.
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

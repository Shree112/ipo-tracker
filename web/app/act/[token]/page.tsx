import Link from "next/link";
import { redirect } from "next/navigation";
import { verifyToken } from "@/lib/links";
import { db } from "@/lib/db";
import { setDecision } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Confirm" };

async function confirm(formData: FormData) {
  "use server";
  const token = String(formData.get("token") || "");
  const v = await verifyToken(token);
  if (!v.ok) redirect(`/act/${encodeURIComponent(token)}`);
  const note = String(formData.get("note") || "").trim().slice(0, 200) || null;
  await setDecision(v.payload.s, v.payload.d, note);
  redirect(`/act/${encodeURIComponent(token)}?done=1`);
}

export default async function ActPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const { token } = await params;
  const { done } = await searchParams;
  const v = await verifyToken(token);

  const shell = (children: React.ReactNode) => (
    <main className="wrap">
      <div className="center-card">
        <div className="logo" style={{ marginBottom: 24 }}>
          <span className="logo-mark" aria-hidden>IC</span>
          <span>IPO Copilot</span>
        </div>
        <div className="card" style={{ padding: 24, display: "grid", gap: 14 }}>
          {children}
        </div>
      </div>
    </main>
  );

  if (!v.ok) {
    return shell(
      <>
        <h1 style={{ fontSize: 22 }}>{v.reason === "expired" ? "This link has expired" : "This link isn't valid"}</h1>
        <p className="muted">
          {v.reason === "expired"
            ? "Buttons in the email stop working once the issue has closed."
            : v.reason === "unconfigured"
              ? "LINK_SECRET isn't set on the server."
              : "It may have been cut short when copied."}{" "}
          You can still mark it on the site.
        </p>
        <Link className="btn" href="/">
          Open IPO Copilot
        </Link>
      </>,
    );
  }

  const { s: slug, d: decision } = v.payload;
  const [issue] = await db()<{ name: string; status: string | null }[]>`
    SELECT i.name, st.status FROM issues i LEFT JOIN issue_status st ON st.issue_id = i.id WHERE i.slug = ${slug}`;
  if (!issue) return shell(<h1 style={{ fontSize: 22 }}>Issue not found</h1>);
  const name = issue.name.replace(/ (Ltd|Limited)\.?$/i, "");

  if (done || issue.status === decision) {
    return shell(
      <>
        <div className="badges">
          <span className={`badge ${decision === "applied" ? "green" : ""}`}>{decision === "applied" ? "✓ Applied" : "Skipped"}</span>
        </div>
        <h1 style={{ fontSize: 22 }}>{name}</h1>
        <p className="muted">Marked {decision}. It won&apos;t appear in tomorrow&apos;s digest.</p>
        <Link className="btn" href={`/issue/${slug}`}>
          Open the issue page
        </Link>
      </>,
    );
  }

  return shell(
    <form action={confirm} style={{ display: "grid", gap: 14 }}>
      <input type="hidden" name="token" value={token} />
      <div>
        <p className="muted small">Confirm from the digest</p>
        <h1 style={{ fontSize: 22, marginTop: 4 }}>
          Mark {name} as {decision}?
        </h1>
      </div>
      {decision === "applied" ? (
        <input className="input" name="note" placeholder="Note, e.g. 2 PANs (optional)" maxLength={200} aria-label="Note" />
      ) : null}
      <button className="btn primary" type="submit">
        {decision === "applied" ? "Yes, I applied" : "Yes, skip it"}
      </button>
      <p className="xs muted">This removes it from the daily digest. You can undo it on the issue page.</p>
    </form>,
  );
}

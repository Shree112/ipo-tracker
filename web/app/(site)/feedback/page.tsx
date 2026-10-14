import { createHash } from "node:crypto";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db, within } from "@/lib/db";
import { getViewer } from "@/lib/viewer";

// Feedback from anyone, signed in or not. Saved to the feedback table; the
// admin gets an email about new messages with the hourly account emails and
// sees them on the admin dashboard.

export const dynamic = "force-dynamic";
export const metadata = { title: "Feedback" };

const KINDS = [
  ["idea", "Idea"],
  ["bug", "Something broke"],
  ["data", "Wrong data"],
  ["other", "Other"],
] as const;
const PER_HOUR = 5; // per sender, to keep a bot from filling the table

async function send(fd: FormData) {
  "use server";
  // bots fill every field, including this one, which people never see
  if (String(fd.get("company") ?? "")) redirect("/feedback?sent=1");

  const message = String(fd.get("message") ?? "").trim().slice(0, 4000);
  if (message.length < 3) redirect("/feedback?error=empty");
  const kindIn = String(fd.get("kind") ?? "");
  const kind = KINDS.some(([k]) => k === kindIn) ? kindIn : "other";
  const pageIn = String(fd.get("page") ?? "");
  const page = pageIn.startsWith("/") && !pageIn.startsWith("//") ? pageIn.slice(0, 200) : null;

  const v = await getViewer().catch(() => null);
  const emailIn = String(fd.get("email") ?? "").trim();
  const email = v?.email ?? (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailIn) ? emailIn.slice(0, 200) : null);
  const ip = ((await headers()).get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const senderKey = createHash("sha256").update(`ipo-copilot-feedback:${ip}`).digest("hex").slice(0, 32);

  let outcome: "sent" | "slow" | "failed" = "sent";
  try {
    const sql = db();
    const [{ n }] = await within(
      sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM feedback
        WHERE sender_key = ${senderKey} AND created_at > now() - interval '1 hour'`,
      6000,
      "feedback",
    );
    if (n >= PER_HOUR) outcome = "slow";
    else
      await within(
        sql`
          INSERT INTO feedback (user_id, email, kind, message, page, sender_key)
          VALUES (${v?.id ?? null}, ${email}, ${kind}, ${message}, ${page}, ${senderKey})`,
        6000,
        "feedback",
      );
  } catch {
    outcome = "failed";
  }
  redirect(outcome === "sent" ? "/feedback?sent=1" : `/feedback?error=${outcome}`);
}

const ERRORS: Record<string, string> = {
  empty: "Write a few words first.",
  slow: "That's a lot of messages in an hour. Please try again a bit later.",
  failed: "Couldn't save that just now. Please try again in a minute.",
};

export default async function Feedback({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string; from?: string }>;
}) {
  const { sent, error, from } = await searchParams;
  const viewer = await getViewer().catch(() => null);
  return (
    <main className="wrap narrow">
      <div className="page-head">
        <div>
          <h1>Feedback</h1>
          <p>What&apos;s useful, what&apos;s broken, what you wish it did. Every message gets read.</p>
        </div>
      </div>

      {sent ? (
        <section className="card section">
          <div className="saved-line">Thanks, got it.</div>
          <p className="small muted" style={{ marginTop: 12 }}>
            {viewer ? "If it needs a reply, it'll come to your sign-in email." : null}{" "}
            <Link className="link" href="/feedback">
              Send another
            </Link>{" "}
            ·{" "}
            <Link className="link" href="/">
              Back to live IPOs
            </Link>
          </p>
        </section>
      ) : (
        <form action={send} className="card section feedback-form">
          {error && ERRORS[error] ? <div className="warn-line" style={{ marginTop: 0 }}>{ERRORS[error]}</div> : null}

          <fieldset className="seg" aria-label="What is it about">
            {KINDS.map(([k, label]) => (
              <label key={k}>
                <input type="radio" name="kind" value={k} defaultChecked={k === "idea"} />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>

          <label className="feedback-label" htmlFor="fb-message">
            Your feedback
          </label>
          <textarea
            id="fb-message"
            name="message"
            className="input feedback-text"
            rows={6}
            maxLength={4000}
            required
            placeholder="e.g. The GMP for X looks off, or I'd love alerts for…"
          />

          {viewer ? (
            <p className="xs muted">Sent as {viewer.email}.</p>
          ) : (
            <>
              <label className="feedback-label" htmlFor="fb-email">
                Email <span className="muted">(optional, only if you&apos;d like a reply)</span>
              </label>
              <input id="fb-email" name="email" type="email" className="input" placeholder="you@example.com" />
            </>
          )}

          <input type="hidden" name="page" value={from ?? ""} />
          <div className="hp" aria-hidden="true">
            <label>
              Company <input name="company" tabIndex={-1} autoComplete="off" />
            </label>
          </div>

          <div>
            <button className="btn primary" type="submit">
              Send feedback
            </button>
          </div>
        </form>
      )}
    </main>
  );
}

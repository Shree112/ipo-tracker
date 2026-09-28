import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseEnv, supabaseServer } from "@/lib/supabase";
import { maxUsers } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

async function continueWithGoogle(formData: FormData) {
  "use server";
  const next = String(formData.get("next") || "/");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${proto}://${host}/auth/callback?next=${encodeURIComponent(safeNext)}`,
      queryParams: { prompt: "select_account" },
    },
  });
  if (error || !data.url) redirect("/signin?error=start");
  redirect(data.url);
}

const ERRORS: Record<string, string> = {
  start: "Couldn't reach Google sign-in. Try again in a moment.",
  signin: "Sign-in didn't complete. Try again.",
};

const FEATURES: [string, string][] = [
  ["Set your rules once", "GMP %, expected profit per lot, subscription, anchor book or issue size. All of them, or any one."],
  ["We watch every IPO for you", "GMP and subscription checked every hour, and every few minutes on the last day."],
  ["One email, only when it matters", "At the hour you pick, on days something qualifies. Tap Applied or Skip from your inbox, plus a 1 pm last-day nudge if you want it."],
];

export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next = "/", error } = await searchParams;
  const configured = supabaseEnv() !== null;
  return (
    <main className="wrap">
      <div className="landing">
        <div className="logo" style={{ marginBottom: 32 }}>
          <span className="logo-mark" aria-hidden>IC</span>
          <span>IPO Copilot</span>
        </div>
        <h1 className="landing-title">Stop checking GMP every morning.</h1>
        <p className="landing-sub">
          Tell IPO Copilot what makes a mainboard IPO worth applying for. It watches every issue and emails you only when
          one qualifies.
        </p>

        <ul className="features">
          {FEATURES.map(([t, d]) => (
            <li key={t}>
              <span className="tick" aria-hidden>
                <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </span>
              <div>
                <b>{t}</b>
                <div className="muted small">{d}</div>
              </div>
            </li>
          ))}
        </ul>

        {configured ? (
          <form action={continueWithGoogle} className="signin-form">
            <input type="hidden" name="next" value={next} />
            <button className="btn primary big" type="submit">
              Continue with Google
            </button>
            <a className="link small" href="/">
              Or browse live IPOs first →
            </a>
            {error ? <p className="small down">{ERRORS[error] ?? "Sign-in was cancelled."}</p> : null}
          </form>
        ) : (
          <p className="note">Sign-in isn&apos;t configured yet: SUPABASE_URL and SUPABASE_ANON_KEY are missing on the server.</p>
        )}

        <p className="xs muted" style={{ marginTop: 18, maxWidth: 460 }}>
          Invite-only for now: new accounts are approved by hand, up to {maxUsers()} members. GMP is an unofficial
          grey-market quote and nothing here is investment advice.
        </p>
        <p className="xs landing-links">
          <a className="link" href="/privacy">Privacy</a> · <a className="link" href="/terms">Terms</a>
        </p>
      </div>
    </main>
  );
}

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AUTH_COOKIE, AUTH_MAX_AGE, expectedToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function login(formData: FormData) {
  "use server";
  const next = String(formData.get("next") || "/");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const token = await expectedToken();
  const given = String(formData.get("password") || "");
  const pw = process.env.SITE_PASSWORD;
  if (!token || !pw || given !== pw) {
    redirect(`/login?error=1&next=${encodeURIComponent(safeNext)}`);
  }
  (await cookies()).set(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_MAX_AGE,
  });
  redirect(safeNext);
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next = "/", error } = await searchParams;
  const configured = Boolean(process.env.SITE_PASSWORD);
  return (
    <main className="wrap">
      <div className="center-card">
        <div className="logo" style={{ marginBottom: 28 }}>
          <span className="logo-mark" aria-hidden>IC</span>
          <span>IPO Copilot</span>
        </div>
        {!configured ? (
          <p className="note">
            SITE_PASSWORD isn&apos;t set on the server yet, so nobody can sign in. Add it under the project&apos;s environment
            variables and redeploy.
          </p>
        ) : (
          <form action={login} className="card" style={{ display: "grid", gap: 14, padding: 24 }}>
            <div>
              <h1 style={{ fontSize: 22 }}>Sign in</h1>
              <p className="muted small" style={{ marginTop: 4 }}>This browser stays signed in for 90 days.</p>
            </div>
            <input type="hidden" name="next" value={next} />
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Password"
              aria-label="Password"
              required
              autoFocus
              className="input"
            />
            {error ? <p className="small down">That password didn&apos;t match.</p> : null}
            <button className="btn primary" type="submit">
              Continue
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

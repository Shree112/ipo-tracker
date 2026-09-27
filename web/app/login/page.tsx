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
    <main className="wrap" style={{ maxWidth: 420, paddingTop: "12vh" }}>
      <p className="eyebrow">IPO Copilot</p>
      <h1 style={{ marginBottom: 18 }}>Sign in</h1>
      {!configured ? (
        <p className="note-box">
          SITE_PASSWORD isn&apos;t set on the server yet, so nobody can sign in. Add it under the
          project&apos;s environment variables and redeploy.
        </p>
      ) : (
        <form action={login} className="card" style={{ display: "grid", gap: 12 }}>
          <input type="hidden" name="next" value={next} />
          <label className="small muted" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            className="note-input"
            style={{ width: "100%" }}
          />
          {error ? <p className="small down" style={{ margin: 0 }}>That password didn&apos;t match.</p> : null}
          <button className="btn primary" type="submit">
            Continue
          </button>
          <p className="small muted" style={{ margin: 0 }}>
            This browser stays signed in for 90 days.
          </p>
        </form>
      )}
    </main>
  );
}

import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase";
import { ensureAccount } from "@/lib/viewer";

// Google sends people back here (via Supabase) with a one-time code. Swap it
// for a session cookie, make sure there's an account row, and move on:
// approved people to where they were going, everyone else to /pending.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const back = (path: string) => NextResponse.redirect(new URL(path, url.origin));

  if (!code) return back(`/signin?error=${encodeURIComponent(url.searchParams.get("error_description") ?? "cancelled")}`);

  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user?.email) return back("/signin?error=signin");

  const u = data.user;
  const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
  const name = String(meta.full_name ?? meta.name ?? "") || null;
  const account = await ensureAccount(u.id, u.email!, name);
  return back(account.status === "approved" ? safeNext : "/pending");
}

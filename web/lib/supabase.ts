import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Supabase is used for one thing only: signing people in with Google. All data
// still goes through the direct Postgres connection in lib/db.ts, scoped to the
// signed-in user on the server.
//
// Both values stay server-side (no NEXT_PUBLIC_ prefix) because every auth
// step - starting the Google redirect, the callback, sign-out - runs on the
// server. The browser never talks to Supabase.

export function supabaseEnv(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
}

/** For server actions and route handlers, where cookies can be written. */
export async function supabaseServer() {
  const env = supabaseEnv();
  if (!env) throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY are not set");
  const store = await cookies();
  return createServerClient(env.url, env.key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (toSet) => {
        try {
          toSet.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // called from a server component, where cookies are read-only; the
          // middleware has already refreshed the session for this request
        }
      },
    },
  });
}

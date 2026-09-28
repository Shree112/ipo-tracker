import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Runs before every page. It does the one auth check per request:
//   1. refresh the Supabase session cookie if it's close to expiring
//   2. verify the signed-in user (getClaims)
//   3. hand the verified id/email to the page as request headers, so pages
//      and server actions don't have to call Supabase again
// Signed-out visitors can read / and /issue/*; anything else sends them to
// /signin. Approval (pending/approved) is checked
// on the page, which needs the database for it.
//
// Headers of the same names sent by the browser are always stripped first,
// so they can't be forged.

export const VIEWER_HEADERS = ["x-viewer-id", "x-viewer-email", "x-viewer-name"] as const;

function devViewer(): { id: string; email: string; name: string } | null {
  // Local testing only: never honoured on Vercel.
  if (process.env.VERCEL || process.env.ALLOW_DEV_AUTH !== "1") return null;
  const id = process.env.DEV_AUTH_ID;
  const email = process.env.DEV_AUTH_EMAIL;
  return id && email ? { id, email, name: process.env.DEV_AUTH_NAME ?? "" } : null;
}

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const onSignin = path === "/signin";
  // readable without an account: the live list and the issue pages (with the
  // research sections locked). Everything else needs a signed-in user.
  const isPublic = path === "/" || path.startsWith("/issue/");

  const setCookies: { name: string; value: string; options: object }[] = [];
  const setHeaders: Record<string, string> = {};
  let viewer = devViewer();

  if (!viewer) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (url && key) {
      const supabase = createServerClient(url, key, {
        cookies: {
          getAll: () => req.cookies.getAll(),
          setAll: (toSet, headers) => {
            toSet.forEach(({ name, value, options }) => {
              req.cookies.set(name, value);
              setCookies.push({ name, value, options });
            });
            Object.assign(setHeaders, headers ?? {});
          },
        },
      });
      const { data } = await supabase.auth.getClaims();
      const c = data?.claims;
      if (c?.sub && c.email) {
        const meta = (c.user_metadata ?? {}) as Record<string, unknown>;
        viewer = { id: c.sub, email: String(c.email), name: String(meta.full_name ?? meta.name ?? "") };
      }
    }
  }

  let res: NextResponse;
  if (!viewer && !onSignin && !isPublic) {
    const to = req.nextUrl.clone();
    to.pathname = "/signin";
    to.search = path === "/" ? "" : `?next=${encodeURIComponent(path + req.nextUrl.search)}`;
    res = NextResponse.redirect(to);
  } else if (viewer && onSignin) {
    const to = req.nextUrl.clone();
    to.pathname = "/";
    to.search = "";
    res = NextResponse.redirect(to);
  } else {
    const headers = new Headers(req.headers);
    VIEWER_HEADERS.forEach((h) => headers.delete(h));
    if (viewer) {
      headers.set("x-viewer-id", viewer.id);
      headers.set("x-viewer-email", viewer.email);
      headers.set("x-viewer-name", encodeURIComponent(viewer.name));
    }
    res = NextResponse.next({ request: { headers } });
  }
  setCookies.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
  Object.entries(setHeaders).forEach(([k, v]) => res.headers.set(k, v));
  return res;
}

export const config = {
  // Not for: the OAuth callback and sign-out (they handle the session
  // themselves), the public privacy and terms pages, /act/<token> (the email buttons carry their own signature,
  // so they work on a phone that has never signed in), and static assets.
  matcher: ["/((?!auth/|act/|privacy$|terms$|_next/static|_next/image|favicon.ico|robots.txt).*)"],
};

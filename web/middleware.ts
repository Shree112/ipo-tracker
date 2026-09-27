import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, expectedToken } from "@/lib/auth";

export async function middleware(req: NextRequest) {
  const token = await expectedToken();
  if (token && req.cookies.get(AUTH_COOKIE)?.value === token) {
    return NextResponse.next();
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the login page itself and Next's static assets.
  // /act/<token> carries its own signature, so the email buttons work on a
  // phone that has never signed in.
  matcher: ["/((?!login|act/|_next/static|_next/image|favicon.ico|robots.txt).*)"],
};

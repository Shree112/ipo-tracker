// One password, one cookie. This is a personal tool: the point is to keep the
// data and the Applied/Skip actions off the open internet, not to run accounts.
// The cookie holds a hash of the password, so changing SITE_PASSWORD on Vercel
// logs every browser out.

export const AUTH_COOKIE = "ipo_auth";
export const AUTH_MAX_AGE = 60 * 60 * 24 * 90; // 90 days

export async function expectedToken(): Promise<string | null> {
  const pw = process.env.SITE_PASSWORD;
  if (!pw) return null; // fail closed: no password configured, nobody gets in
  const data = new TextEncoder().encode(`ipo-copilot:${pw}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

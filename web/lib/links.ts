// Signed one-tap links for the digest's Applied / Skip buttons.
//
// token = base64url(JSON {s: slug, d: decision, x: expiry-unix, u: user id}) + "." +
//         base64url(HMAC-SHA256(LINK_SECRET, <that first part>))
//
// The Python digest signs with the same secret. A link only ever opens a
// confirmation page; the change itself happens on the POST from that page,
// so Gmail's link scanner prefetching the URL changes nothing.

// u is the account the digest was sent to. Links from the single-user days
// have no u; they belong to the admin.
export type LinkPayload = { s: string; d: "applied" | "skipped"; x: number; u?: string };

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToB64url(b: Uint8Array): string {
  let s = "";
  b.forEach((x) => (s += String.fromCharCode(x)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return bytesToB64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type Verified = { ok: true; payload: LinkPayload } | { ok: false; reason: "invalid" | "expired" | "unconfigured" };

export async function verifyToken(token: string): Promise<Verified> {
  const secret = process.env.LINK_SECRET;
  if (!secret) return { ok: false, reason: "unconfigured" };
  const [body, sig] = decodeURIComponent(token).split(".");
  if (!body || !sig) return { ok: false, reason: "invalid" };
  if (!safeEqual(await sign(body, secret), sig)) return { ok: false, reason: "invalid" };
  let payload: LinkPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!payload?.s || !["applied", "skipped"].includes(payload.d)) return { ok: false, reason: "invalid" };
  if (payload.u !== undefined && !/^[0-9a-f-]{36}$/i.test(payload.u)) return { ok: false, reason: "invalid" };
  if (!payload.x || Date.now() / 1000 > payload.x) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

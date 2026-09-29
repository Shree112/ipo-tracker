import { db } from "./db";

// Telegram: members link the bot once ("Connect Telegram" on the Alerts page
// opens t.me/<bot>?start=<one-time code>); Telegram then calls our webhook,
// which ties that chat to the account. The Python jobs send the messages.
//
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, TELEGRAM_WEBHOOK_SECRET
// (any long random string), and SITE_URL (or Vercel's production URL).

const token = () => (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
export const botUsername = () => (process.env.TELEGRAM_BOT_USERNAME ?? "").trim().replace(/^@/, "");
export const telegramReady = () => Boolean(token() && botUsername() && process.env.TELEGRAM_WEBHOOK_SECRET);

async function api(method: string, body?: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  return (await r.json()) as { ok: boolean; result?: Record<string, unknown>; description?: string };
}

export async function sendMessage(chatId: number, text: string) {
  if (!token()) return;
  await api("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }).catch(() => undefined);
}

function siteUrl() {
  const s = (process.env.SITE_URL ?? "").trim().replace(/\/$/, "");
  if (s) return s;
  const v = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return v ? `https://${v}` : "";
}

export async function setTelegramWebhook() {
  if (!telegramReady() || !siteUrl()) return;
  await api("setWebhook", {
    url: `${siteUrl()}/api/telegram`,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message"],
  });
}

/** For the dashboard: is the bot set up and pointed at us? */
export async function telegramStatus(): Promise<{ label: string; detail: string; canConnect: boolean }> {
  if (!token()) return { label: "Not set up", detail: "Add TELEGRAM_BOT_TOKEN on Vercel", canConnect: false };
  if (!telegramReady()) return { label: "Half set up", detail: "Also add TELEGRAM_BOT_USERNAME and TELEGRAM_WEBHOOK_SECRET", canConnect: false };
  const info = await api("getWebhookInfo").catch(() => null);
  const url = String(info?.result?.url ?? "");
  if (url.endsWith("/api/telegram")) {
    const err = info?.result?.last_error_message;
    return { label: err ? "Webhook error" : "Connected", detail: err ? String(err) : `@${botUsername()}`, canConnect: Boolean(err) };
  }
  return { label: "Not connected", detail: "", canConnect: true };
}

/** A one-time code for this member's /start link. */
export async function newLinkCode(userId: string): Promise<string> {
  const code = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
  await db()`UPDATE app_users SET telegram_link_code = ${code} WHERE user_id = ${userId}::uuid`;
  return code;
}

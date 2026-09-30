import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { sendMessage } from "@/lib/telegram";

// Telegram calls this for every message sent to the bot. It only handles
// linking (/start <code>) and unlinking (/stop); alerts go out from the jobs.
export async function POST(req: NextRequest) {
  const secret = (process.env.TELEGRAM_WEBHOOK_SECRET ?? "").trim();
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return new NextResponse("forbidden", { status: 403 });
  }
  const update = (await req.json().catch(() => null)) as {
    message?: { chat?: { id?: number }; text?: string };
  } | null;
  const chatId = update?.message?.chat?.id;
  const text = (update?.message?.text ?? "").trim();
  if (!chatId) return NextResponse.json({ ok: true });
  const site = (process.env.SITE_URL ?? "").replace(/\/$/, "");

  if (text.startsWith("/start")) {
    const code = text.split(/\s+/)[1] ?? "";
    const [u] = code
      ? await db()<{ user_id: string; name: string | null }[]>`
          UPDATE app_users SET telegram_chat_id = ${chatId}, telegram_link_code = NULL
          WHERE telegram_link_code = ${code} AND status = 'approved'
          RETURNING user_id::text, name`
      : [];
    if (u) {
      await db()`UPDATE alert_rules SET channel = 'both' WHERE user_id = ${u.user_id}::uuid AND channel = 'email'`;
      await sendMessage(
        chatId,
        `Connected${u.name ? `, ${u.name.split(" ")[0]}` : ""}. Your IPO digests and listing-day notes will arrive here too.\n\nChoose email, Telegram or both on the Alerts page${site ? `: ${site}/settings` : ""}. Send /stop to disconnect.`,
      );
    } else {
      await sendMessage(chatId, `This link has expired. Open the Alerts page on IPO Copilot and tap "Connect Telegram" again.`);
    }
  } else if (text.startsWith("/stop")) {
    const rows = await db()<{ user_id: string }[]>`
      UPDATE app_users SET telegram_chat_id = NULL WHERE telegram_chat_id = ${chatId} RETURNING user_id::text`;
    for (const r of rows) await db()`UPDATE alert_rules SET channel = 'email' WHERE user_id = ${r.user_id}::uuid`;
    await sendMessage(chatId, "Disconnected. Alerts will go to your email only.");
  } else {
    await sendMessage(chatId, "I only send IPO Copilot alerts. Manage them on the Alerts page. Send /stop to disconnect.");
  }
  return NextResponse.json({ ok: true });
}

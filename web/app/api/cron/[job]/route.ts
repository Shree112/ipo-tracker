import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { db, within } from "@/lib/db";
import { todayIST } from "@/lib/format";
import { refreshSubscription } from "@/lib/subscription";

// The clock for everything that has to happen on time. A Supabase cron job
// (pg_cron + pg_net, see scripts/supabase_cron.sql) calls these URLs, because
// GitHub's own scheduler skips most scheduled runs on a quiet repository.
//
//   /api/cron/subscription   every 10 min in market hours - fetched right here
//   /api/cron/refresh        hourly: starts the GitHub "refresh" workflow
//   /api/cron/live           twice a day: starts "live"
//   /api/cron/chatter        twice a day: starts "chatter"
//
// Every call needs  Authorization: Bearer <CRON_SECRET>.

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const WORKFLOWS: Record<string, { file: string; inputs?: Record<string, string> }> = {
  refresh: { file: "refresh.yml", inputs: { mode: "hourly" } },
  live: { file: "live.yml" },
  chatter: { file: "chatter.yml" },
};

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (secret.length < 16 || got.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(secret));
}

function marketHours(): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return !["Sat", "Sun"].includes(parts.weekday) && minutes >= 9 * 60 && minutes <= 17 * 60 + 45;
}

async function dispatch(job: string) {
  const wf = WORKFLOWS[job];
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPO || "Shree112/ipo-tracker";
  if (!token) return NextResponse.json({ ok: false, error: "GITHUB_DISPATCH_TOKEN is not set on Vercel" }, { status: 501 });
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${wf.file}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: "main", ...(wf.inputs ? { inputs: wf.inputs } : {}) }),
    signal: AbortSignal.timeout(15000),
  });
  if (r.status !== 204) {
    const detail = (await r.text()).slice(0, 300);
    return NextResponse.json({ ok: false, error: `GitHub answered ${r.status}`, detail }, { status: 502 });
  }
  return NextResponse.json({ ok: true, started: wf.file });
}

async function handle(req: NextRequest, job: string) {
  if (!authorised(req)) return new NextResponse("forbidden", { status: 403 });

  if (job === "subscription") {
    const force = req.nextUrl.searchParams.get("force") === "1";
    if (!force && !marketHours()) return NextResponse.json({ ok: true, skipped: "outside market hours" });
    const today = todayIST();
    const [open] = await within(
      db()<{ n: number }[]>`
        SELECT count(*)::int AS n FROM issues
        WHERE board IN ('mainboard', 'sme') AND NOT COALESCE(withdrawn, false) AND ${today}::date BETWEEN open_date AND close_date`,
      6000,
      "open issues",
    );
    if (!force && !open.n) return NextResponse.json({ ok: true, skipped: "no mainboard issue open today" });
    const result = await refreshSubscription("cron");
    return NextResponse.json({ ok: result.status !== "error", ...result }, { status: result.status === "error" ? 502 : 200 });
  }
  if (job in WORKFLOWS) return dispatch(job);
  return new NextResponse("unknown job", { status: 404 });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ job: string }> }) {
  return handle(req, (await params).job);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ job: string }> }) {
  return handle(req, (await params).job);
}

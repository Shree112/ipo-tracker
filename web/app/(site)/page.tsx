import Link from "next/link";
import { redirect } from "next/navigation";
import HomeList, { type HomeRow } from "@/components/HomeList";
import { addDays, crore, fmtDate, fmtWhen, pct, sizeSplit, stageOf, times, todayIST } from "@/lib/format";
import { describeRules, listIssues, matchesFor, rulesFor, type IssueRow, type Match } from "@/lib/queries";
import { getViewer, viewerId } from "@/lib/viewer";
import AlertsPitch from "@/components/AlertsPitch";
import Ticker from "@/components/Ticker";

export const dynamic = "force-dynamic";

const SRC: Record<string, string> = { investorgain: "InvestorGain", ipowatch: "IPO Watch" };

function toRow(i: IssueRow, today: string, m: Match | undefined): HomeRow {
  const stage = stageOf(i.open_date, i.close_date, i.listing_date, today);
  const all = i.gmp_latest ?? [];
  const g = all.find((x) => x.source === "investorgain") ?? all[0] ?? null;
  const other = all.find((x) => x.source !== g?.source);
  const radar = m !== undefined;
  const kept = radar && m.sticky && m.reasons.length === 0;
  const before = stage.key === "upcoming" || stage.key === "tomorrow";
  const after = stage.key === "closed" || stage.key === "listed";
  const group: HomeRow["group"] =
    stage.key === "listed" ? "listed" : stage.key === "closed" ? "awaiting" : before ? "upcoming" : "open";
  return {
    id: i.id,
    slug: i.slug,
    name: i.name.replace(/ (Ltd|Limited)\.?$/i, ""),
    stage,
    group,
    radar,
    kept,
    reasons: m?.reasons ?? [],
    status: i.status,
    allotment: i.allotment,
    gmp: g ? pct(g.gmp_pct) : "–",
    gmpSub: other ? `${SRC[other.source]} ${pct(other.gmp_pct)}` : g ? fmtWhen(g.observed_at, today) : "no quote",
    gmpTone: kept ? "warn" : "",
    spark: [...(i.spark ?? [])].reverse(),
    listingGain: stage.key === "listed" && i.listing_gain_pct !== null ? `${i.listing_gain_pct >= 0 ? "+" : ""}${pct(i.listing_gain_pct)}` : null,
    listingUp: (i.listing_gain_pct ?? 0) >= 0,
    size: crore(i.issue_size_cr),
    sizeSub: sizeSplit(i.fresh_issue_cr, i.ofs_cr),
    sub: i.sub_latest ? times(i.sub_latest.total_x) : "–",
    subSub: i.sub_latest ? `retail ${times(i.sub_latest.rii_x)}` : before ? "opens " + fmtDate(i.open_date) : "no reading",
    dateLabel: before ? "Opens" : after ? "Lists" : "Closes",
    date: fmtDate(before ? i.open_date : after ? i.listing_date : i.close_date, true),
    window: i.open_date && i.close_date ? `${fmtDate(i.open_date)} – ${fmtDate(i.close_date)}` : "",
  };
}

export default async function Home({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const { welcome } = await searchParams;
  const today = todayIST();
  // the verified id comes from the middleware, so the data queries start
  // alongside the account check instead of after it
  const uid = (await viewerId()) ?? "00000000-0000-0000-0000-000000000000";
  const [viewer, issues, allMatches, rules] = await Promise.all([
    getViewer(),
    listIssues(uid),
    matchesFor(uid, today),
    rulesFor(uid),
  ]);
  // The list is public; the radar, alerts and Applied/Skip are for approved members.
  const member = viewer?.status === "approved";
  // first sign-in after approval: pick a starting set of alerts
  if (member && rules && !rules.onboarded_at) redirect("/welcome");
  const matches = member ? allMatches : new Map<number, Match>();
  const rows = issues.map((i) => toRow(i, today, matches.get(i.id)));
  const radar = rows.filter((r) => r.radar).length;
  const ruleText = describeRules(rules);

  // a live example for the pitch: the open issue with the highest GMP
  const ex = issues
    .filter((i) => i.open_date && i.close_date && i.open_date <= today && today <= i.close_date)
    .map((i) => ({ i, g: (i.gmp_latest ?? []).find((x) => x.source === "investorgain") ?? i.gmp_latest?.[0] }))
    .filter((x) => x.g)
    .sort((a, b) => b.g!.gmp_pct - a.g!.gmp_pct)[0];
  const example = ex
    ? {
        name: ex.i.name.replace(/ (Ltd|Limited)\.?$/i, ""),
        gmp: pct(ex.g!.gmp_pct),
        size: crore(ex.i.issue_size_cr),
        closes: fmtDate(ex.i.close_date, true),
      }
    : null;

  // live GMPs for the ticker: everything open or about to open, biggest first
  const ticker = issues
    .filter((i) => i.close_date && i.close_date >= today && i.open_date && i.open_date <= addDays(today, 3))
    .map((i) => ({ i, g: (i.gmp_latest ?? []).find((x) => x.source === "investorgain") ?? i.gmp_latest?.[0] }))
    .filter((x) => x.g)
    .sort((a, b) => b.g!.gmp_pct - a.g!.gmp_pct)
    .map(({ i, g }) => ({
      name: i.name.replace(/ (Ltd|Limited)\.?$/i, "").replace(/\s*\(India\)/i, ""),
      value: `${g!.gmp_pct > 0 ? "+" : ""}${pct(g!.gmp_pct)}`,
      tone: (g!.gmp_pct > 0 ? "up" : g!.gmp_pct < 0 ? "down" : "") as "up" | "down" | "",
    }));

  return (
    <>
      <main className="wrap">
        <div className="page-head">
          <div>
            <h1>
              Live <em>IPOs</em>
            </h1>
            {member ? (
              <p>
                Mainboard issues, open and upcoming.{" "}
                {radar ? `${radar} on your radar` : "Nothing on your radar right now"}
                {ruleText === "no alerts set" ? "" : ` (${ruleText})`}.{" "}
                <Link href="/settings" className="link">
                  {ruleText === "no alerts set" ? "Set your alerts" : "Edit alerts"}
                </Link>
              </p>
            ) : (
              <p>Every mainboard IPO that is open, upcoming or just listed, with GMP and subscription updated through the day.</p>
            )}
          </div>
        </div>
        <Ticker items={ticker} />
        {member && welcome ? (
          <div className="saved-line" style={{ marginBottom: 16 }}>
            You&apos;re set: {ruleText}. Your digest arrives around{" "}
            {rules ? `${((rules.digest_hour + 11) % 12) + 1}:00 ${rules.digest_hour < 12 ? "am" : "pm"}` : "8:00 am"} on
            days something matches. <Link href="/settings" className="link">Fine-tune</Link>
          </div>
        ) : null}
        {!viewer ? (
          <AlertsPitch example={example} />
        ) : !member ? (
          <div className="warn-line" style={{ marginBottom: 16 }}>
            Your account is waiting for approval. Once you&apos;re in, you&apos;ll set your alerts and get the daily digest.
          </div>
        ) : null}
        {rows.length ? (
          <HomeList rows={rows} personal={member} />
        ) : (
          <div className="card empty">Nothing open, upcoming or recently listed.</div>
        )}
      </main>
    </>
  );
}

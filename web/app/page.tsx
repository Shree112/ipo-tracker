import TopBar from "@/components/TopBar";
import HomeList, { type HomeRow } from "@/components/HomeList";
import { crore, fmtDate, fmtWhen, pct, sizeSplit, stageOf, times, todayIST } from "@/lib/format";
import { inDigest, listIssues, TRIGGER_PCT, type IssueRow } from "@/lib/queries";

export const dynamic = "force-dynamic";

const SRC: Record<string, string> = { investorgain: "InvestorGain", ipowatch: "IPO Watch" };

function toRow(i: IssueRow, today: string): HomeRow {
  const stage = stageOf(i.open_date, i.close_date, i.listing_date, today);
  const all = i.gmp_latest ?? [];
  const g = all.find((x) => x.source === "investorgain") ?? all[0] ?? null;
  const other = all.find((x) => x.source !== g?.source);
  const radar = inDigest(i, today);
  const sticky = radar && g !== null && g.gmp_pct <= TRIGGER_PCT;
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
    sticky,
    status: i.status,
    gmp: g ? pct(g.gmp_pct) : "–",
    gmpSub: other ? `${SRC[other.source]} ${pct(other.gmp_pct)}` : g ? fmtWhen(g.observed_at, today) : "no quote",
    gmpTone: sticky ? "warn" : "",
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

export default async function Home() {
  const today = todayIST();
  const rows = (await listIssues()).map((i) => toRow(i, today));
  const radar = rows.filter((r) => r.radar).length;
  return (
    <>
      <TopBar />
      <main className="wrap">
        <div className="page-head">
          <div>
            <h1>Live IPOs</h1>
            <p>
              Mainboard issues, open and upcoming.{" "}
              {radar ? `${radar} on your radar with GMP above ${TRIGGER_PCT}%.` : `Nothing above ${TRIGGER_PCT}% GMP right now.`}
            </p>
          </div>
        </div>
        {rows.length ? <HomeList rows={rows} /> : <div className="card empty">Nothing open, upcoming or recently listed.</div>}
      </main>
    </>
  );
}

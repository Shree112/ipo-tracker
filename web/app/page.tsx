import Link from "next/link";
import TopBar from "@/components/TopBar";
import { StageChip, StatusChip } from "@/components/Chips";
import { crore, fmtDate, fmtWhen, pct, sizeSplit, stageOf, times, todayIST } from "@/lib/format";
import { inDigest, listIssues, TRIGGER_PCT, type IssueRow } from "@/lib/queries";

export const dynamic = "force-dynamic";

function primaryGmp(i: IssueRow) {
  const all = i.gmp_latest ?? [];
  return all.find((g) => g.source === "investorgain") ?? all[0] ?? null;
}

function Row({ i, today, flagged }: { i: IssueRow; today: string; flagged: boolean }) {
  const stage = stageOf(i.open_date, i.close_date, i.listing_date, today);
  const g = primaryGmp(i);
  const other = (i.gmp_latest ?? []).find((x) => x.source !== g?.source);
  const sticky = flagged && g !== null && g.gmp_pct <= TRIGGER_PCT;
  const listed = stage.key === "listed" && i.listing_gain_pct !== null;
  return (
    <Link href={`/issue/${i.slug}`} className={`row-card ${flagged ? "flag" : ""} ${sticky ? "sticky" : ""}`}>
      <div className="head">
        <div className="nm">{i.name}</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          <StageChip stage={stage} />
          <StatusChip status={i.status} />
        </div>
      </div>
      {listed ? (
        <div className="cell">
          <div className="label">Listing gain</div>
          <div className={`value ${i.listing_gain_pct! >= 0 ? "up" : "down"}`}>
            {i.listing_gain_pct! >= 0 ? "+" : ""}
            {pct(i.listing_gain_pct)}
          </div>
          <div className="sub">at the {i.price_basis ?? "open"}</div>
        </div>
      ) : (
        <div className="cell">
          <div className="label">GMP</div>
          <div className="value" style={{ color: sticky ? "var(--amber)" : undefined }}>{g ? pct(g.gmp_pct) : "–"}</div>
          <div className="sub">
            {other ? `${other.source === "ipowatch" ? "IPO Watch" : "InvestorGain"} ${pct(other.gmp_pct)}` : g ? fmtWhen(g.observed_at, today) : ""}
          </div>
        </div>
      )}
      <div className="cell">
        <div className="label">Size</div>
        <div className="value">{crore(i.issue_size_cr)}</div>
        <div className="sub">{sizeSplit(i.fresh_issue_cr, i.ofs_cr)}</div>
      </div>
      <div className="cell">
        <div className="label">Subscribed</div>
        <div className="value">{i.sub_latest ? times(i.sub_latest.total_x) : "–"}</div>
        <div className="sub">
          {i.sub_latest
            ? `retail ${times(i.sub_latest.rii_x)}`
            : stage.key === "upcoming" || stage.key === "tomorrow"
              ? "not open yet"
              : "no reading yet"}
        </div>
      </div>
      <div className="cell">
        <div className="label">{stage.key === "upcoming" || stage.key === "tomorrow" ? "Opens" : stage.key === "closed" || stage.key === "listed" ? "Lists" : "Closes"}</div>
        <div className="value">
          {fmtDate(
            stage.key === "upcoming" || stage.key === "tomorrow"
              ? i.open_date
              : stage.key === "closed" || stage.key === "listed"
                ? i.listing_date
                : i.close_date,
          )}
        </div>
        <div className="sub">{i.open_date && i.close_date ? `${fmtDate(i.open_date)} – ${fmtDate(i.close_date)}` : ""}</div>
      </div>
    </Link>
  );
}

function Group({ title, note, items, today, digest }: { title: string; note?: string; items: IssueRow[]; today: string; digest: Set<number> }) {
  if (!items.length) return null;
  return (
    <section className="group">
      <div className="group-title">
        <h2 style={{ margin: 0 }}>{title}</h2>
        <span className="muted small">
          {items.length}
          {note ? ` · ${note}` : ""}
        </span>
      </div>
      <div className="list">
        {items.map((i) => (
          <Row key={i.id} i={i} today={today} flagged={digest.has(i.id)} />
        ))}
      </div>
    </section>
  );
}

export default async function Home() {
  const today = todayIST();
  const issues = await listIssues();
  const digest = new Set(issues.filter((i) => inDigest(i, today)).map((i) => i.id));

  const inWindow = (i: IssueRow) => i.close_date !== null && today <= i.close_date;
  const listed = (i: IssueRow) => i.listing_date !== null && today >= i.listing_date;

  const radar = issues.filter((i) => digest.has(i.id));
  const others = issues.filter((i) => !digest.has(i.id) && inWindow(i));
  const awaiting = issues.filter((i) => !inWindow(i) && !listed(i));
  const recent = issues.filter((i) => listed(i)).reverse();

  return (
    <main className="wrap">
      <TopBar />
      <p className="eyebrow">{fmtDate(today, true)} · mainboard</p>
      <h1>Live IPOs</h1>
      {!issues.length ? (
        <div className="card empty section">Nothing open, upcoming or recently listed.</div>
      ) : null}
      <Group title="On your radar" note={`GMP above ${TRIGGER_PCT}% from the day before opening`} items={radar} today={today} digest={digest} />
      <Group title="Open & upcoming" items={others} today={today} digest={digest} />
      <Group title="Closed · awaiting listing" items={awaiting} today={today} digest={digest} />
      <Group title="Recently listed" items={recent} today={today} digest={digest} />
    </main>
  );
}

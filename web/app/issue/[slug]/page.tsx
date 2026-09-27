import Link from "next/link";
import { notFound } from "next/navigation";
import TopBar from "@/components/TopBar";
import GmpChart, { type Series } from "@/components/GmpChart";
import DecisionButtons from "@/components/DecisionButtons";
import { StageChip, StatusChip } from "@/components/Chips";
import {
  addDays,
  band,
  crore,
  fmtDate,
  fmtDateTime,
  fmtWhen,
  pct,
  rupees,
  sizeSplit,
  stageOf,
  times,
  todayIST,
} from "@/lib/format";
import { getIssue, inDigest, TRIGGER_PCT, type GmpPoint, type SubPoint } from "@/lib/queries";

export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = { investorgain: "InvestorGain", ipowatch: "IPO Watch" };
const IST_MS = 5.5 * 3_600_000;
const istMidnight = (iso: string) => Date.parse(`${iso}T00:00:00Z`) - IST_MS;

function latestBefore(points: GmpPoint[], before: number) {
  let best: GmpPoint | null = null;
  for (const p of points) if (new Date(p.observed_at).getTime() < before) best = p;
  return best;
}

function SubBars({ sub }: { sub: SubPoint }) {
  const rows: [string, number | null, boolean?][] = [
    ["QIB", sub.qib_x],
    ["NII", sub.nii_x],
    ["· small", sub.shni_x],
    ["· big", sub.bhni_x],
    ["Retail", sub.rii_x],
    ["Employee", sub.employee_x],
    ["Total", sub.total_x, true],
  ];
  const shown = rows.filter(([, v]) => v !== null && v !== undefined) as [string, number, boolean?][];
  const max = Math.max(1, ...shown.map(([, v]) => v));
  return (
    <div className="bars" role="table" aria-label="Subscription by category, times subscribed">
      {shown.map(([name, v, total]) => (
        <div className={`barrow ${total ? "total" : ""}`} role="row" key={name}>
          <span className="name" role="rowheader">{name}</span>
          <span className="track" aria-hidden>
            <span className="fill" style={{ display: "block", width: `${(v / max) * 100}%` }} />
          </span>
          <span className="val" role="cell">{times(v)}</span>
        </div>
      ))}
    </div>
  );
}

export default async function IssuePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await getIssue(slug);
  if (!data) notFound();
  const { issue: i, gmp, subs, snaps, history, refGmp } = data;
  const today = todayIST();
  const stage = stageOf(i.open_date, i.close_date, i.listing_date, today);
  const digest = inDigest(i, today);

  // GMP: InvestorGain is the headline, IPO Watch the cross-check
  const bySource = (src: string) => gmp.filter((p) => p.source === src);
  const ig = bySource("investorgain");
  const iw = bySource("ipowatch");
  const primary = ig.length ? ig : iw;
  const latest = primary[primary.length - 1] ?? null;
  const prev = latest ? latestBefore(primary, istMidnight(today)) : null;
  const delta = latest && prev && prev !== latest ? latest.gmp_pct - prev.gmp_pct : null;
  const otherLatest = (ig.length ? iw : [])[iw.length - 1] ?? null;
  const sticky = digest && latest !== null && latest.gmp_pct <= TRIGGER_PCT && (i.peak_since_t1 ?? 0) > TRIGGER_PCT;

  const series: Series[] = [
    { key: "investorgain", label: "InvestorGain", colorVar: "--series-1", points: ig },
    { key: "ipowatch", label: "IPO Watch", colorVar: "--series-2", points: iw },
  ]
    .filter((s) => s.points.length)
    .map((s) => ({
      ...s,
      points: s.points.map((p) => ({ t: new Date(p.observed_at).getTime(), v: p.gmp_pct, amt: p.gmp_amount })),
    }));

  const sub = subs[subs.length - 1] ?? null;
  const oneLot = i.lot_size && i.price_band_high ? i.lot_size * i.price_band_high : i.min_order_amount;
  const t1 = snaps.find((s) => s.phase === "t_minus_1");
  const closeSnap = snaps.find((s) => s.phase === "close_day");
  const listed = i.listing_gain_pct !== null;
  const canDecide = stage.key !== "listed";

  const timeline: [string, string | null][] = [
    ["Anchor book", i.anchor_date],
    ["Opens", i.open_date],
    ["Closes", i.close_date],
    ["Lists", i.listing_date],
  ];

  return (
    <main className="wrap">
      <TopBar />
      <p className="small" style={{ margin: "0 0 10px" }}>
        <Link href="/">← All live IPOs</Link>
      </p>

      <div className="issue-head">
        <div style={{ minWidth: 0 }}>
          <p className="eyebrow">Mainboard{i.exchanges ? ` · ${i.exchanges}` : ""}</p>
          <h1>{i.name}</h1>
          <div className="meta">
            <StageChip stage={stage} />
            <StatusChip status={i.status} />
            {digest && i.status !== "notified" ? <span className="chip amber">In today&apos;s digest</span> : null}
          </div>
        </div>
        {canDecide ? <DecisionButtons slug={i.slug} status={i.status} note={i.note} /> : null}
      </div>

      <div className="stats">
        {listed ? (
          <div className="stat">
            <div className="label">Listing gain</div>
            <div className={`value ${i.listing_gain_pct! >= 0 ? "up" : "down"}`}>
              {i.listing_gain_pct! >= 0 ? "+" : ""}
              {pct(i.listing_gain_pct)}
            </div>
            <div className="sub">
              {rupees(i.listing_open)} at the {i.price_basis ?? "open"}
            </div>
          </div>
        ) : null}
        <div className="stat">
          <div className="label">GMP</div>
          <div className={`value ${sticky ? "amber" : "accent"}`}>{latest ? pct(latest.gmp_pct) : "–"}</div>
          <div className="sub">
            {latest ? rupees(latest.gmp_amount) : ""}
            {delta !== null && Math.abs(delta) >= 0.05 ? (
              <span className={delta > 0 ? "up" : "down"}>
                {" "}
                · {delta > 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)} pts today
              </span>
            ) : latest ? " · flat today" : ""}
          </div>
        </div>
        <div className="stat">
          <div className="label">Issue size</div>
          <div className="value">{crore(i.issue_size_cr)}</div>
          <div className="sub">{sizeSplit(i.fresh_issue_cr, i.ofs_cr)}</div>
        </div>
        <div className="stat">
          <div className="label">1 lot</div>
          <div className="value">{rupees(oneLot, 0)}</div>
          <div className="sub">{i.lot_size ? `${i.lot_size} shares at ${rupees(i.price_band_high)} · band ${band(i.price_band_low, i.price_band_high)}` : band(i.price_band_low, i.price_band_high)}</div>
        </div>
        <div className="stat">
          <div className="label">Subscribed</div>
          <div className="value">{sub ? times(sub.total_x) : "–"}</div>
          <div className="sub">
            {sub
              ? `retail ${times(sub.rii_x)} · QIB ${times(sub.qib_x)}`
              : stage.key === "upcoming" || stage.key === "tomorrow"
                ? `bidding opens ${fmtDate(i.open_date)}`
                : "no reading yet"}
          </div>
        </div>
        <div className="stat">
          <div className="label">P/E</div>
          <div className="value">{i.pe_ratio ? i.pe_ratio.toFixed(1) : "–"}</div>
          <div className="sub">at the upper band</div>
        </div>
      </div>

      {sticky ? (
        <p className="warn-text small" style={{ margin: "10px 2px 0" }}>
          GMP peaked at {pct(i.peak_since_t1)} after the day before opening and has fallen below {TRIGGER_PCT}% — it stays in the
          digest until you mark it.
        </p>
      ) : null}

      <div className="card section">
        <div className="timeline">
          {timeline.map(([k, d]) => (
            <div key={k} className={`tl ${d && d < today ? "done" : ""} ${d === today ? "today" : ""}`}>
              <div className="k">{k}</div>
              <div className="v">{d ? fmtDate(d, true) : "–"}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid2 section">
        <div className="card">
          <h2>GMP history</h2>
          <p className="small muted" style={{ marginTop: -6 }}>
            % of the upper price band.{" "}
            {latest ? `Latest ${LABEL[latest.source]} ${fmtWhen(latest.observed_at, today)}` : ""}
            {otherLatest ? ` · IPO Watch ${pct(otherLatest.gmp_pct)} ${fmtWhen(otherLatest.observed_at, today)}` : ""}
          </p>
          <GmpChart
            series={series}
            threshold={TRIGGER_PCT}
            windowStart={i.open_date ? istMidnight(i.open_date) : null}
            windowEnd={i.close_date ? istMidnight(addDays(i.close_date, 1)) : null}
          />
          <details>
            <summary>Show readings as a table ({gmp.length})</summary>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>When (IST)</th>
                    <th>Source</th>
                    <th className="r">GMP</th>
                    <th className="r">%</th>
                  </tr>
                </thead>
                <tbody>
                  {[...gmp].reverse().map((p, k) => (
                    <tr key={k}>
                      <td>{fmtDateTime(p.observed_at)}{p.capture_mode === "backfill" ? " *" : ""}</td>
                      <td>{LABEL[p.source]}</td>
                      <td className="r">{rupees(p.gmp_amount)}</td>
                      <td className="r">{pct(p.gmp_pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="small muted">* read from the site after the fact, not captured live.</p>
            </div>
          </details>
        </div>

        <div style={{ display: "grid", gap: 18, alignContent: "start" }}>
          <div className="card">
            <h2>Subscription</h2>
            {sub ? (
              <>
                <SubBars sub={sub} />
                <p className="small muted" style={{ margin: "10px 0 0" }}>
                  Times subscribed, as of {fmtWhen(sub.observed_at, today)}.
                </p>
                {subs.length > 1 ? (
                  <details>
                    <summary>How it built up ({subs.length} readings)</summary>
                    <div className="scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>When</th>
                            <th className="r">QIB</th>
                            <th className="r">NII</th>
                            <th className="r">Retail</th>
                            <th className="r">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...subs].reverse().map((s, k) => (
                            <tr key={k}>
                              <td>{fmtDateTime(s.observed_at)}</td>
                              <td className="r">{times(s.qib_x)}</td>
                              <td className="r">{times(s.nii_x)}</td>
                              <td className="r">{times(s.rii_x)}</td>
                              <td className="r">{times(s.total_x)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                ) : null}
              </>
            ) : (
              <p className="muted small" style={{ margin: 0 }}>
                {stage.key === "upcoming" || stage.key === "tomorrow"
                  ? `Starts when bidding opens${i.open_date ? ` on ${fmtDate(i.open_date, true)}` : ""}.`
                  : "No live subscription readings for this issue."}
              </p>
            )}
          </div>

          <div className="card">
            <h2>Documents</h2>
            <div className="links">
              {i.rhp_url ? <a href={i.rhp_url} target="_blank" rel="noreferrer">Red herring prospectus (RHP) ↗</a> : null}
              {i.anchor_report_url ? (
                <a href={i.anchor_report_url} target="_blank" rel="noreferrer">
                  Anchor allocation{i.anchor_date && i.anchor_date > today ? ` (due ${fmtDate(i.anchor_date)})` : ""} ↗
                </a>
              ) : (
                <span className="muted small">Anchor book {i.anchor_date ? `due ${fmtDate(i.anchor_date)}` : "not published yet"}</span>
              )}
              {i.investorgain_url ? <a href={i.investorgain_url} target="_blank" rel="noreferrer">InvestorGain page ↗</a> : null}
              {i.ipowatch_url ? <a href={i.ipowatch_url} target="_blank" rel="noreferrer">IPO Watch GMP page ↗</a> : null}
            </div>
          </div>

          {history && history.n > 0 && refGmp !== null ? (
            <div className="card">
              <h2>What history says</h2>
              <p style={{ margin: 0 }}>
                Past IPOs with a day-before GMP of <b>{history.label}</b> opened a median{" "}
                <b className={history.median! >= 0 ? "up" : "down"}>
                  {history.median! >= 0 ? "+" : ""}
                  {pct(history.median)}
                </b>
                , and {Math.round(history.positive ?? 0)}% opened above the issue price.
              </p>
              <p className="small muted" style={{ margin: "8px 0 0" }}>
                {history.n} mainboard issues since 2023, compared on {t1 ? "this issue's frozen day-before GMP" : "the current GMP"} ({pct(refGmp)}).
                Context, not a forecast.
              </p>
            </div>
          ) : null}

          {t1 || closeSnap ? (
            <div className="card">
              <h2>Frozen for calibration</h2>
              <div className="small" style={{ display: "grid", gap: 6 }}>
                {t1 ? (
                  <div>
                    <b>Day before opening:</b> GMP {pct(t1.gmp_pct)}
                    <span className="muted"> · {String(t1.extras?.source ?? "").replace("-", " ")}</span>
                  </div>
                ) : null}
                {closeSnap ? (
                  <div>
                    <b>Close day:</b> {times(closeSnap.sub_total_x)} total, retail {times(closeSnap.sub_rii_x)}
                    {closeSnap.gmp_pct !== null ? `, GMP ${pct(closeSnap.gmp_pct)}` : ""}
                    <span className="muted"> · decision {String(closeSnap.extras?.decision ?? "–")}</span>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}

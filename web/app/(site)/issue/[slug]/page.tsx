import Link from "next/link";
import { notFound } from "next/navigation";
import GmpChart, { type Series } from "@/components/GmpChart";
import DecisionButtons from "@/components/DecisionButtons";
import { Avatar, RadarBadge, StageBadge, StatusBadge } from "@/components/Chips";
import { AnchorBook, Financials, Objects, Peers } from "@/components/Research";
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
import { getIssue, matchesFor, rulesFor, type GmpPoint, type SubPoint } from "@/lib/queries";
import { getViewer, viewerId } from "@/lib/viewer";
import { logEvent } from "@/lib/events";
import { Fold, LockedFold } from "@/components/Fold";
import AlertsPitch from "@/components/AlertsPitch";
import OpenOnHash from "@/components/OpenOnHash";
import Chatter from "@/components/Chatter";
import AboutCompany from "@/components/AboutCompany";
import AskProspectus from "@/components/AskProspectus";
import AskCard from "@/components/AskCard";
import { askReady, prospectusStatus, webReady } from "@/lib/ask";
import AllotmentCard from "@/components/AllotmentCard";
import { BSE_STATUS, registrarLink } from "@/lib/registrars";
import { lotTable } from "@/lib/lots";
import { lastSubscriptionCheck } from "@/lib/subscription";
import RefreshSubscription from "@/components/RefreshSubscription";
import BrokerLinks from "@/components/BrokerLinks";

export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = { investorgain: "InvestorGain", ipowatch: "IPO Watch" };
const LOT_LABEL: Record<string, [string, string]> = {
  "Retail (min)": ["Retail", "smallest bid"],
  "Retail (max)": ["Retail", "largest bid"],
  "Small HNI (min)": ["Small HNI", "smallest bid"],
  "Small HNI (max)": ["Small HNI", "largest bid"],
  "Big HNI (min)": ["Big HNI", "smallest bid"],
  "Individual (min)": ["Individual", "smallest bid (2 lots, over ₹2 lakh)"],
};
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
          <span aria-hidden>
            <span className="fill" style={{ display: "block", width: `${(v / max) * 100}%` }} />
          </span>
          <span className="val" role="cell">{times(v)}</span>
        </div>
      ))}
    </div>
  );
}

export default async function IssuePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ src?: string }>;
}) {
  const [{ slug }, { src }] = await Promise.all([params, searchParams]);
  const today = todayIST();
  const uid = await viewerId();
  const [viewer, data, allMatches, allRules, rhpDoc, subChecked] = await Promise.all([
    getViewer(),
    getIssue(slug, uid),
    matchesFor(uid, today),
    rulesFor(uid),
    askReady() && uid ? prospectusStatus(slug) : Promise.resolve(null),
    uid ? lastSubscriptionCheck() : Promise.resolve(null),
  ]);
  if (!data) notFound();
  if (src === "email" || src === "tg") logEvent(src === "email" ? "email_click" : "tg_click", viewer?.id ?? null, slug);
  // Signed-out visitors (and accounts still waiting for approval) get the
  // headline numbers, the GMP chart and subscription; the research sections
  // and anything personal need an approved account.
  const member = viewer?.status === "approved";
  const matches = member ? allMatches : new Map<number, { reasons: string[]; sticky: boolean }>();
  const rules = member ? allRules : null;
  const here = `/issue/${slug}`;
  const { issue: i, gmp, subs, snaps, history, refGmp, detail, chatter } = data;
  const stage = stageOf(i.open_date, i.close_date, i.listing_date, today);
  const match = matches.get(i.id);
  const digest = match !== undefined;
  const threshold = rules?.gmp_pct_min ?? null;

  // GMP: InvestorGain is the headline, IPO Watch the cross-check
  const bySource = (src: string) => gmp.filter((p) => p.source === src);
  const ig = bySource("investorgain");
  const iw = bySource("ipowatch");
  const primary = ig.length ? ig : iw;
  const latest = primary[primary.length - 1] ?? null;
  const prev = latest ? latestBefore(primary, istMidnight(today)) : null;
  const delta = latest && prev && prev !== latest ? latest.gmp_pct - prev.gmp_pct : null;
  const otherLatest = (ig.length ? iw : [])[iw.length - 1] ?? null;
  const sticky = digest && match.sticky && match.reasons.length === 0;

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
  // bidding is live (or closed yesterday: the final numbers can still land the next morning)
  const subLive = !!i.open_date && !!i.close_date && i.open_date <= today && today <= addDays(i.close_date, 1);
  const sme = i.board === "sme";
  const lots = lotTable(i.lot_size, i.price_band_high, i.board);
  // bidding is open, or opens within three days (brokers take pre-applications)
  const canApply = !!i.open_date && !!i.close_date && today <= i.close_date && i.open_date <= addDays(today, 3);
  // While bidding is live, the card's time is when we last checked the source,
  // not when the numbers last moved - a check that finds no change still counts.
  const checkedAt = subLive && subChecked ? new Date(subChecked) : null;
  const subAt = sub ? new Date(sub.observed_at) : null;
  const freshAt = checkedAt && subAt && checkedAt > subAt ? checkedAt : subAt;
  const unchangedSince =
    checkedAt && subAt && checkedAt.getTime() - subAt.getTime() > 5 * 60_000 ? fmtWhen(subAt, today) : null;


  const steps: [string, string | null][] = [
    ["Anchor book", i.anchor_date],
    ["Opens", i.open_date],
    ["Closes", i.close_date],
    ["Allotment", i.allotment_date],
    ["Lists", i.listing_date],
  ];
  const shortName = i.name.replace(/ (Ltd|Limited)\.?$/i, "");
  const meta = [
    sme ? "SME" : "Mainboard",
    i.exchanges?.replace(",", ", ").replace(/\s+/g, " "),
    i.price_band_high ? `Price band ${band(i.price_band_low, i.price_band_high)}` : null,
  ].filter(Boolean);

  return (
    <>
      <main className="wrap">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href="/">Live IPOs</Link>
          <span aria-hidden>/</span>
          <span style={{ color: "var(--ink-2)" }}>{shortName}</span>
        </nav>

        <div className="issue-head">
          <div className="issue-id">
            <Avatar name={i.name} size="lg" />
            <div style={{ minWidth: 0 }}>
              <h1>{shortName}</h1>
              <div className="meta">{meta.join(" · ")}</div>
              <div className="badges">
                <StageBadge stage={stage} />
                {digest ? <RadarBadge kept={sticky} reasons={match.reasons} /> : null}
                <StatusBadge status={i.status} allotment={i.allotment} />
              </div>
            </div>
          </div>
          {!canDecide ? null : member ? (
            <DecisionButtons slug={i.slug} status={i.status} note={i.note} />
          ) : viewer ? (
            <span className="badge amber">
              <span className="dot" aria-hidden /> Account waiting for approval
            </span>
          ) : (
            <Link href={`/signin?next=${encodeURIComponent(here)}`} className="btn primary">
              Get alerts like this
            </Link>
          )}
        </div>

        <div className="metrics">
          {listed ? (
            <div className="metric">
              <div className="label">Listing gain</div>
              <div className={`value ${i.listing_gain_pct! >= 0 ? "up" : "down"}`}>
                {i.listing_gain_pct! >= 0 ? "+" : ""}
                {pct(i.listing_gain_pct)}
              </div>
              <div className="sub">{rupees(i.listing_open)} at the {i.price_basis ?? "open"}</div>
            </div>
          ) : null}
          <div className="metric">
            <div className="label">GMP</div>
            <div className={`value ${sticky ? "warn" : "accent"}`}>{latest ? pct(latest.gmp_pct) : "–"}</div>
            <div className="sub">
              {latest ? rupees(latest.gmp_amount) : "no quote yet"}
              {delta !== null && Math.abs(delta) >= 0.05 ? (
                <span className={delta > 0 ? "up" : "down"}>
                  {" "}
                  · {delta > 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)} pts today
                </span>
              ) : latest ? " · flat today" : ""}
            </div>
          </div>
          <div className="metric">
            <div className="label">Issue size</div>
            <div className="value">{crore(i.issue_size_cr)}</div>
            <div className="sub">{sizeSplit(i.fresh_issue_cr, i.ofs_cr)}</div>
          </div>
          <div className="metric">
            <div className="label">1 lot</div>
            <div className="value">{rupees(oneLot, 0)}</div>
            <div className="sub">{i.lot_size ? `${i.lot_size} shares at ${rupees(i.price_band_high)}` : ""}</div>
          </div>
          <div className="metric">
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
          <div className="metric">
            <div className="label">P/E</div>
            <div className="value">{i.pe_ratio ? i.pe_ratio.toFixed(1) : "–"}</div>
            <div className="sub">
              {detail?.kpis?.pe_post !== undefined ? `${detail.kpis.pe_post} post-issue` : "at the upper band"}
            </div>
          </div>
        </div>

        {!viewer ? (
          <AlertsPitch next={here} compact />
        ) : sticky ? (
          <div className="warn-line">
            This no longer matches your alerts, but it was in your digest, so it stays on your radar until you mark it
            applied or skipped.
          </div>
        ) : digest && match.reasons.length ? (
          <div className="match-line">
            <span className="dot" aria-hidden /> On your radar: {match.reasons.join(" · ")}.{" "}
            <Link href="/settings" className="link">
              Alert settings
            </Link>
          </div>
        ) : null}

        {member && i.status === "applied" && (i.allotment_date || i.registrar) ? (
          (() => {
            const reg = registrarLink(i.registrar);
            return (
              <AllotmentCard
                slug={i.slug}
                result={i.allotment}
                allotmentDate={i.allotment_date}
                allotmentLabel={i.allotment_date ? fmtDate(i.allotment_date, true) : "a date not announced yet"}
                registrar={i.registrar}
                registrarLabel={reg.label}
                registrarUrl={reg.url}
                bseUrl={reg.known ? BSE_STATUS : null}
                out={!!i.allotment_date && i.allotment_date <= today}
              />
            );
          })()
        ) : null}

        {canApply ? <BrokerLinks name={shortName} preApply={!!i.open_date && today < i.open_date} /> : null}

        <div className="card section">
          <div className="stepper">
            {steps.map(([k, d]) => (
              <div key={k} className={`step ${d && d < today ? "done" : ""} ${d === today ? "today" : ""}`}>
                <span className="pin" aria-hidden />
                <div className="k">{k}</div>
                <div className="v">{d ? fmtDate(d, true) : "–"}</div>
              </div>
            ))}
          </div>
        </div>

        {lots.length ? (
          <Fold
            id="lots"
            title="How much to apply"
            summary={
              <>
                <span className="chip">
                  {sme ? "minimum bid" : "1 lot"} <b>{rupees(lots[0].amount, 0)}</b>
                </span>
                {lots.find((l) => l.category === "Retail (max)") ? (
                  <span className="chip">
                    retail up to <b>{rupees(lots.find((l) => l.category === "Retail (max)")!.amount, 0)}</b>
                  </span>
                ) : null}
              </>
            }
          >
            <p className="small muted" style={{ marginBottom: 12 }}>
              The smallest and largest bid for each type of investor, at the upper price of {rupees(i.price_band_high)} a
              share.
            </p>
            <div className="table-wrap">
              <table className="lots">
                <thead>
                  <tr>
                    <th>Investor type</th>
                    <th className="r">Lots</th>
                    <th className="r">Shares</th>
                    <th className="r">You pay</th>
                  </tr>
                </thead>
                <tbody>
                  {lots.map((l) => (
                    <tr key={l.category}>
                      <td>
                        <div>{LOT_LABEL[l.category]?.[0] ?? l.category}</div>
                        <div className="xs muted">{LOT_LABEL[l.category]?.[1]}</div>
                      </td>
                      <td className="r">{l.lots}</td>
                      <td className="r">{l.shares.toLocaleString("en-IN")}</td>
                      <td className="r">{rupees(l.amount, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="xs muted lots-key">
              {sme ? (
                <li>
                  <b>Individual</b>: on SME issues individuals must bid at least 2 lots, and more than ₹2 lakh.
                </li>
              ) : (
                <li>
                  <b>Retail</b>: individuals bidding up to ₹2 lakh.
                </li>
              )}
              <li>
                <b>Small HNI</b> (sNII): above ₹2 lakh, up to ₹10 lakh.
              </li>
              <li>
                <b>Big HNI</b> (bNII): above ₹10 lakh.
              </li>
            </ul>
          </Fold>
        ) : null}

        <AboutCompany detail={detail} shortName={shortName} sourceUrl={i.investorgain_url} />

        {askReady() ? (
          <AskCard
            name={shortName}
            member={member}
            next={here}
            sources={[rhpDoc?.status === "ok" ? `${rhpDoc.pages}-page prospectus` : null, webReady() ? "live web search" : null]
              .filter(Boolean)
              .join(" + ")}
          >
            {member && (rhpDoc?.status === "ok" || webReady()) ? (
              <AskProspectus slug={i.slug} rhpUrl={i.rhp_url} pages={rhpDoc?.status === "ok" ? rhpDoc.pages : null} web={webReady()} />
            ) : member ? (
              <p className="small muted">
                The prospectus for this IPO hasn&apos;t been loaded yet (it&apos;s picked up twice a day once the RHP is
                published){i.rhp_url ? ". You can still read it directly: " : "."}
                {i.rhp_url ? (
                  <a className="link" href={i.rhp_url} target="_blank" rel="noreferrer">
                    open the prospectus ↗
                  </a>
                ) : null}
              </p>
            ) : null}
          </AskCard>
        ) : null}

        <nav className="subnav" aria-label="On this page">
          <OpenOnHash />
          {askReady() ? (
            <a href="#ask" className="subnav-ai">
              ✦ Ask AI
            </a>
          ) : null}
          <a href="#gmp">GMP</a>
          <a href="#subscription">Subscription</a>
          <a href="#chatter">Chatter</a>
          <a href="#anchor">Anchor book</a>
          {!member || detail?.financials || detail?.kpis ? <a href="#financials">Financials</a> : null}
          {!member || detail?.peers?.rows?.length ? <a href="#peers">Peers</a> : null}
          {!member || detail?.objects?.length ? <a href="#objects">Use of funds</a> : null}
          <a href="#documents">Documents</a>
        </nav>

        <div className="grid-main section" style={{ marginTop: 8 }}>
          <section className="card" id="gmp">
            <div className="card-head">
              <h2>GMP history</h2>
              <span className="sub">% of the upper price band</span>
            </div>
            <GmpChart
              series={series}
              threshold={threshold}
              windowStart={i.open_date ? istMidnight(i.open_date) : null}
              windowEnd={i.close_date ? istMidnight(addDays(i.close_date, 1)) : null}
            />
            <p className="xs muted" style={{ marginTop: 10 }}>
              {latest ? `Latest ${LABEL[latest.source]} ${fmtWhen(latest.observed_at, today)}` : ""}
              {otherLatest ? ` · IPO Watch ${pct(otherLatest.gmp_pct)} ${fmtWhen(otherLatest.observed_at, today)}` : ""}
            </p>
            <details className="more">
              <summary>All readings ({gmp.length})</summary>
              <div className="table-wrap">
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
                        <td>
                          {fmtDateTime(p.observed_at)}
                          {p.capture_mode === "backfill" ? " *" : ""}
                        </td>
                        <td>{LABEL[p.source]}</td>
                        <td className="r">{rupees(p.gmp_amount)}</td>
                        <td className="r">{pct(p.gmp_pct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="xs muted" style={{ marginTop: 8 }}>* read from the site after the fact, not captured live.</p>
              </div>
            </details>
          </section>

          <section className="card" id="subscription">
            <div className="card-head">
              <h2>Subscription</h2>
              {sub && freshAt ? (
                <span className="sub">
                  {checkedAt ? "updated" : "as of"} {fmtWhen(freshAt, today)}
                </span>
              ) : null}
            </div>
            {member && subLive ? (
              <RefreshSubscription slug={i.slug} unchangedSince={unchangedSince} />
            ) : null}
            {sub ? (
              <>
                <SubBars sub={sub} />
                {subs.length > 1 ? (
                  <details className="more">
                    <summary>How it built up ({subs.length} readings)</summary>
                    <div className="table-wrap">
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
              <p className="muted small">
                {stage.key === "upcoming" || stage.key === "tomorrow"
                  ? `Starts when bidding opens${i.open_date ? ` on ${fmtDate(i.open_date, true)}` : ""}.`
                  : "No live subscription readings for this issue."}
              </p>
            )}
          </section>
        </div>

        {member ? (
          <>
            <Chatter data={chatter} today={today} />
            <AnchorBook detail={detail} issueSizeCr={i.issue_size_cr} />
            <Financials detail={detail} />
            <Peers detail={detail} companyName={i.name} />
            <Objects detail={detail} />
            {!sme && history && history.n > 0 && refGmp !== null ? (
              <Fold
                id="history"
                title="What history says"
                summary={
                  <span className="chip">
                    similar issues opened a median{" "}
                    <b className={history.median! >= 0 ? "up" : "down"}>
                      {history.median! >= 0 ? "+" : ""}
                      {pct(history.median)}
                    </b>
                  </span>
                }
              >
                <p>
                  Past IPOs with a day-before GMP of <b>{history.label}</b> opened a median{" "}
                  <b className={history.median! >= 0 ? "up" : "down"}>
                    {history.median! >= 0 ? "+" : ""}
                    {pct(history.median)}
                  </b>
                  ; {Math.round(history.positive ?? 0)}% opened above the issue price.
                </p>
                <p className="xs muted" style={{ marginTop: 8 }}>
                  {history.n} mainboard issues since 2023, compared on{" "}
                  {t1 ? "this issue's frozen day-before GMP" : "the current GMP"} ({pct(refGmp)}). Context, not a forecast.
                </p>
              </Fold>
            ) : null}
          </>
        ) : (
          <>
            <LockedFold id="chatter" title="What investors are saying" blurb="An AI summary of what people on Reddit and IPO Watch are saying about this IPO." next={here} />
            <LockedFold id="anchor" title="Anchor book" blurb="Who bought in the anchor round, how much, and how much went to mutual funds." next={here} />
            <LockedFold id="financials" title="Financials & valuation" blurb="Income, profit, ROE, debt and valuation from the offer document." next={here} />
            <LockedFold id="peers" title="Listed peers" blurb="The listed companies it compares itself with, side by side." next={here} />
            <LockedFold id="objects" title="Use of funds" blurb="What the fresh-issue money will be spent on." next={here} />
            <LockedFold id="history" title="What history says" blurb="How past IPOs with a similar GMP actually listed." next={here} />
          </>
        )}

        <Fold id="documents" title="Documents & sources" summary={<span className="chip">prospectus, anchor list and GMP sources</span>}>
          <div className="links">
            {i.rhp_url ? (
              <a href={i.rhp_url} target="_blank" rel="noreferrer">
                <span>Red herring prospectus</span>
                <span>↗</span>
              </a>
            ) : null}
            {i.anchor_report_url ? (
              <a href={i.anchor_report_url} target="_blank" rel="noreferrer">
                <span>Anchor allocation (PDF)</span>
                <span>↗</span>
              </a>
            ) : null}
            {i.investorgain_url ? (
              <a href={i.investorgain_url} target="_blank" rel="noreferrer">
                <span>InvestorGain</span>
                <span>↗</span>
              </a>
            ) : null}
            {i.ipowatch_url ? (
              <a href={i.ipowatch_url} target="_blank" rel="noreferrer">
                <span>IPO Watch GMP</span>
                <span>↗</span>
              </a>
            ) : null}
          </div>
        </Fold>

        {member && (t1 || closeSnap) ? (
          <Fold
            id="frozen"
            title="Frozen for calibration"
            summary={t1 ? <span className="chip">day-before GMP <b>{pct(t1.gmp_pct)}</b></span> : undefined}
          >
            <div className="small" style={{ display: "grid", gap: 8 }}>
              {t1 ? (
                <div>
                  <div className="muted xs">Day before opening</div>
                  GMP {pct(t1.gmp_pct)}
                </div>
              ) : null}
              {closeSnap ? (
                <div>
                  <div className="muted xs">Close day</div>
                  {times(closeSnap.sub_total_x)} total, retail {times(closeSnap.sub_rii_x)}
                  {closeSnap.gmp_pct !== null ? `, GMP ${pct(closeSnap.gmp_pct)}` : ""}
                  {viewer?.isAdmin ? ` · decision ${String(closeSnap.extras?.decision ?? "–")}` : ""}
                </div>
              ) : null}
            </div>
          </Fold>
        ) : null}
      </main>
    </>
  );
}

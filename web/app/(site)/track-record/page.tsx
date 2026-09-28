import Link from "next/link";
import TrackScatter from "@/components/TrackScatter";
import { fmtDate } from "@/lib/format";
import { backtest, pastIssues, stats } from "@/lib/history";
import { describeRules, rulesFor } from "@/lib/queries";
import { getViewer, viewerId } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Track record" };

const pct = (x: number | null, dp = 1) => (x === null ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(dp)}%`);
const THRESHOLDS = [0, 5, 10, 15, 20, 30];

export default async function TrackRecord() {
  const uid = await viewerId();
  const [viewer, past, rules] = await Promise.all([
    getViewer(),
    pastIssues(),
    uid ? rulesFor(uid) : Promise.resolve(null),
  ]);
  const all = stats(past);
  const errors = past.map((p) => p.gain - p.gmp).sort((a, b) => a - b);
  const medErr = errors.length ? errors[errors.length >> 1] : null;
  const within10 = past.length ? (100 * past.filter((p) => Math.abs(p.gain - p.gmp) <= 10).length) / past.length : 0;
  const since = past.length ? past[past.length - 1].listing_date : null;
  const mine = viewer?.status === "approved" && rules ? backtest(past, rules) : null;

  const rows = THRESHOLDS.map((t) => ({ t, s: stats(past.filter((p) => p.gmp > t)) }));
  const below = stats(past.filter((p) => p.gmp <= 0));

  return (
    <main className="wrap">
      <div className="page-head">
        <div>
          <div className="eyebrow">Track record</div>
          <h1 style={{ marginTop: 10 }}>
            How IPOs <em>actually</em> listed
          </h1>
          <p>
            Every mainboard IPO since{" "}
            {since ? new Date(`${since}T00:00:00Z`).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }) : "2023"}: the grey market premium
            the day before bidding opened, against where the stock opened on listing day.
          </p>
        </div>
      </div>

      <div className="metrics">
        <div className="metric">
          <div className="label">IPOs tracked</div>
          <div className="value">{all.n}</div>
          <div className="sub">mainboard, NSE / BSE</div>
        </div>
        <div className="metric">
          <div className="label">Opened above issue price</div>
          <div className="value">{Math.round(all.up)}%</div>
          <div className="sub">median gain {pct(all.median)}</div>
        </div>
        <div className="metric">
          <div className="label">GMP vs reality</div>
          <div className="value">{medErr === null ? "–" : `${medErr >= 0 ? "+" : "−"}${Math.abs(medErr).toFixed(1)}`}</div>
          <div className="sub">
            median points the open {medErr !== null && medErr < 0 ? "fell short of" : "beat"} GMP
          </div>
        </div>
        <div className="metric">
          <div className="label">GMP within 10 points</div>
          <div className="value">{Math.round(within10)}%</div>
          <div className="sub">of listings</div>
        </div>
      </div>

      {mine && mine.n ? (
        <div className="match-line">
          <span className="dot" aria-hidden /> Your alerts ({describeRules(rules)}) would have caught {mine.n} of these:{" "}
          {Math.round(mine.up)}% opened up, median {pct(mine.median)}.{" "}
          <Link href="/settings" className="link">
            Adjust
          </Link>
        </div>
      ) : !viewer ? (
        <div className="match-line">
          <span className="dot" aria-hidden /> Want an email only when an IPO clears the bar you choose?{" "}
          <Link href="/signin?next=/track-record" className="link">
            Set up alerts
          </Link>
        </div>
      ) : null}

      <section className="card section">
        <div className="card-head">
          <h2>GMP the day before vs the listing-day open</h2>
          <span className="sub">one dot per IPO · on the line means GMP was spot on</span>
        </div>
        <TrackScatter
          points={past.map((p) => ({
            x: p.gmp,
            y: p.gain,
            name: p.name.replace(/ (Ltd|Limited)\.?$/i, ""),
            date: fmtDate(p.listing_date),
            slug: p.slug,
          }))}
        />
        <p className="xs muted" style={{ marginTop: 10 }}>
          Dots below the line opened worse than the grey market implied; above it, better. Hover or use the arrow keys
          for each IPO.
        </p>
      </section>

      <section className="card section">
        <div className="card-head">
          <h2>If you had applied whenever GMP was above…</h2>
          <span className="sub">GMP the day before opening</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>GMP above</th>
                <th className="r">IPOs</th>
                <th className="r">Opened up</th>
                <th className="r">Median gain</th>
                <th className="r">Average gain</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ t, s }) => (
                <tr key={t}>
                  <td>{t}%</td>
                  <td className="r">{s.n}</td>
                  <td className="r">{s.n ? `${Math.round(s.up)}%` : "–"}</td>
                  <td className={`r ${s.median !== null && s.median < 0 ? "down" : ""}`}>{pct(s.median)}</td>
                  <td className="r">{pct(s.mean)}</td>
                </tr>
              ))}
              <tr>
                <td className="muted">0% or below</td>
                <td className="r">{below.n}</td>
                <td className="r">{below.n ? `${Math.round(below.up)}%` : "–"}</td>
                <td className={`r ${below.median !== null && below.median < 0 ? "down" : ""}`}>{pct(below.median)}</td>
                <td className="r">{pct(below.mean)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="card section">
        <div className="card-head">
          <h2>Recent listings</h2>
          <span className="sub">latest 20</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>IPO</th>
                <th className="hide-sm">Listed</th>
                <th className="r">GMP day before</th>
                <th className="r">Opened at</th>
                <th className="r hide-sm">Difference</th>
              </tr>
            </thead>
            <tbody>
              {past.slice(0, 20).map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/issue/${p.slug}`}>{p.name.replace(/ (Ltd|Limited)\.?$/i, "")}</Link>
                  </td>
                  <td className="hide-sm muted">{fmtDate(p.listing_date)}</td>
                  <td className="r">{pct(p.gmp)}</td>
                  <td className={`r ${p.gain >= 0 ? "up" : "down"}`}>{pct(p.gain)}</td>
                  <td className="r hide-sm muted">{`${p.gain - p.gmp >= 0 ? "+" : "−"}${Math.abs(p.gain - p.gmp).toFixed(1)} pts`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="xs muted" style={{ marginTop: 18, maxWidth: 760 }}>
        GMP is the last grey-market quote dated before the opening day (IPO Watch history, InvestorGain for recent issues).
        Listing gain is the listing-day opening price against the upper price band. Past listings don&apos;t predict future
        ones, and nothing here is investment advice.
      </p>
    </main>
  );
}

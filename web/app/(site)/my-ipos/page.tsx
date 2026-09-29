import Link from "next/link";
import { db } from "@/lib/db";
import { fmtDate, toISODate } from "@/lib/format";
import { requireApproved, viewerId } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const metadata = { title: "My IPOs" };

type Row = {
  slug: string;
  name: string;
  status: "applied" | "skipped";
  allotment: "allotted" | "not_allotted" | null;
  note: string | null;
  close_date: string | null;
  listing_date: string | null;
  price: number | null;
  lot: number | null;
  open_price: number | null;
  gain: number | null;
};

const pct = (x: number | null) => (x === null ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);
const rs = (x: number | null) =>
  x === null ? "–" : `${x < 0 ? "−" : ""}₹${Math.abs(Math.round(x)).toLocaleString("en-IN")}`;

export default async function MyIpos() {
  const uid = await viewerId();
  const [viewer, raw] = await Promise.all([
    requireApproved(),
    uid
      ? db()<(Omit<Row, "close_date" | "listing_date"> & { close_date: Date | null; listing_date: Date | null })[]>`
          SELECT i.slug, i.name, st.status, st.allotment, st.note, i.close_date, i.listing_date,
                 i.price_band_high AS price, i.lot_size AS lot, o.listing_open AS open_price, o.listing_gain_pct AS gain
          FROM user_issue_status st JOIN issues i ON i.id = st.issue_id
          LEFT JOIN listing_outcome o ON o.issue_id = i.id AND o.price_basis = 'open'
          WHERE st.user_id = ${uid}::uuid AND st.status IN ('applied', 'skipped')
          ORDER BY COALESCE(i.listing_date, i.close_date) DESC NULLS LAST`.catch(() => [])
      : Promise.resolve([]),
  ]);
  const rows: Row[] = raw.map((r) => ({ ...r, close_date: toISODate(r.close_date), listing_date: toISODate(r.listing_date) }));
  const perLot = (r: Row) => (r.open_price !== null && r.price !== null && r.lot ? (r.open_price - r.price) * r.lot : null);

  const applied = rows.filter((r) => r.status === "applied");
  const skipped = rows.filter((r) => r.status === "skipped");
  const decided = applied.filter((r) => r.allotment);
  const allotted = applied.filter((r) => r.allotment === "allotted");
  const allottedListed = allotted.filter((r) => perLot(r) !== null);
  const total = allottedListed.reduce((a, r) => a + (perLot(r) ?? 0), 0);
  const skippedListed = skipped.filter((r) => r.gain !== null);
  const missed = skippedListed.filter((r) => (r.gain ?? 0) > 0);
  const dodged = skippedListed.filter((r) => (r.gain ?? 0) <= 0);

  return (
    <main className="wrap">
      <div className="page-head">
        <div>
          <div className="eyebrow">{viewer.name?.split(" ")[0] ?? "Your"} record</div>
          <h1 style={{ marginTop: 10 }}>
            My <em>IPOs</em>
          </h1>
          <p>Everything you marked Applied or Skipped, and how it actually listed. Gains assume one lot, sold at the listing-day open.</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="card empty">
          Nothing here yet. Mark an IPO <b>Applied</b> or <b>Skip</b> from your digest or its page, and it&apos;ll show up here with
          its listing result. <Link href="/" className="link">Browse live IPOs</Link>
        </div>
      ) : (
        <>
          <div className="metrics">
            <div className="metric">
              <div className="label">Applied</div>
              <div className="value">{applied.length}</div>
              <div className="sub">{skipped.length} skipped</div>
            </div>
            <div className="metric">
              <div className="label">Allotted</div>
              <div className="value">{decided.length ? `${allotted.length}/${decided.length}` : "–"}</div>
              <div className="sub">{decided.length ? `${Math.round((100 * allotted.length) / decided.length)}% of marked results` : "mark results on each IPO's page"}</div>
            </div>
            <div className="metric">
              <div className="label">Listing-day gain</div>
              <div className={`value ${!allottedListed.length ? "" : total >= 0 ? "up" : "down"}`}>{allottedListed.length ? rs(total) : "–"}</div>
              <div className="sub">{allottedListed.length} allotted IPO{allottedListed.length === 1 ? "" : "s"} listed, one lot each</div>
            </div>
            <div className="metric">
              <div className="label">Your skips</div>
              <div className="value">{skippedListed.length ? `${dodged.length}/${skippedListed.length}` : "–"}</div>
              <div className="sub">{skippedListed.length ? `listed flat or down; ${missed.length} went up` : "none listed yet"}</div>
            </div>
          </div>

          {applied.length ? (
            <section className="card section">
              <div className="card-head">
                <h2>Applied</h2>
                <span className="sub">{applied.length}</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>IPO</th>
                      <th>Result</th>
                      <th className="hide-sm">Listed</th>
                      <th className="r">Listing gain</th>
                      <th className="r">Per lot</th>
                    </tr>
                  </thead>
                  <tbody>
                    {applied.map((r) => (
                      <tr key={r.slug}>
                        <td>
                          <Link href={`/issue/${r.slug}`}>{r.name.replace(/ (Ltd|Limited)\.?$/i, "")}</Link>
                          {r.note ? <div className="xs muted">{r.note}</div> : null}
                        </td>
                        <td>
                          {r.allotment === "allotted" ? (
                            <span className="badge green">Allotted</span>
                          ) : r.allotment === "not_allotted" ? (
                            <span className="badge">Not allotted</span>
                          ) : (
                            <Link href={`/issue/${r.slug}#allotment`} className="link small">
                              Mark result
                            </Link>
                          )}
                        </td>
                        <td className="hide-sm muted">{r.listing_date ? fmtDate(r.listing_date) : "–"}</td>
                        <td className={`r ${r.gain === null ? "" : r.gain >= 0 ? "up" : "down"}`}>{pct(r.gain)}</td>
                        <td className="r">{r.allotment === "allotted" ? rs(perLot(r)) : <span className="faint">{rs(perLot(r))}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="xs muted" style={{ marginTop: 10 }}>Per lot is shown faded where you weren&apos;t allotted (or haven&apos;t said).</p>
            </section>
          ) : null}

          {skipped.length ? (
            <section className="card section">
              <div className="card-head">
                <h2>Skipped</h2>
                <span className="sub">how the ones you passed on did</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>IPO</th>
                      <th className="hide-sm">Listed</th>
                      <th className="r">Listing gain</th>
                      <th className="r">Per lot</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skipped.map((r) => (
                      <tr key={r.slug}>
                        <td>
                          <Link href={`/issue/${r.slug}`}>{r.name.replace(/ (Ltd|Limited)\.?$/i, "")}</Link>
                        </td>
                        <td className="hide-sm muted">{r.listing_date ? fmtDate(r.listing_date) : "–"}</td>
                        <td className={`r ${r.gain === null ? "" : r.gain >= 0 ? "up" : "down"}`}>{pct(r.gain)}</td>
                        <td className="r">{rs(perLot(r))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </>
      )}
      <p className="xs muted" style={{ marginTop: 16 }}>
        Listing gain is the listing-day opening price against the upper price band. Taxes and charges aren&apos;t included.
      </p>
    </main>
  );
}

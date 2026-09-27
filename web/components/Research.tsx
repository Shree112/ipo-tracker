import type { AnchorInvestor, IssueDetail } from "@/lib/queries";
import { crore, fmtDate } from "@/lib/format";

// Anchor categories use categorical slots 1-4 of the validated palette, in
// palette order (so every adjacent pair in the stacked bar is a validated
// pair); "other" is a neutral grey, not a fifth hue.
const CATS: { key: NonNullable<AnchorInvestor["category"]>; label: string; color: string }[] = [
  { key: "mf", label: "Mutual fund / SIF", color: "var(--series-1)" },
  { key: "foreign", label: "Foreign (FPI)", color: "var(--series-2)" },
  { key: "insurance", label: "Insurance", color: "var(--series-3)" },
  { key: "aif", label: "AIF", color: "var(--series-4)" },
  { key: "other", label: "Other / unclassified", color: "var(--neutral-mark)" },
];
const CAT_LABEL = Object.fromEntries(CATS.map((c) => [c.key, c.label]));

const n2 = (x: number | null | undefined, dp = 2) =>
  x === null || x === undefined ? "–" : x.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export function AnchorBook({ detail, issueSizeCr }: { detail: IssueDetail | null; issueSizeCr: number | null }) {
  const a = detail?.anchor;
  const s = detail?.anchor_summary;
  if (!a || !s || !a.investors?.length) {
    return (
      <section className="card section" id="anchor">
        <h2>Anchor book</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Not published yet. The anchor allocation usually lands the working day before the issue opens.
        </p>
      </section>
    );
  }
  const investors = [...a.investors].sort((x, y) => (y.amount_cr ?? 0) - (x.amount_cr ?? 0));
  const segments = CATS.map((c) => ({ ...c, pct: s.by_category_pct[c.key] ?? 0 })).filter((c) => c.pct > 0);
  const TOP = 10;

  const row = (inv: AnchorInvestor, k: number) => (
    <tr key={`${inv.name}-${k}`}>
      <td className="r muted hide-sm">{k + 1}</td>
      <td>
        {inv.name}
        <div className="show-sm small muted">
          <span className="catkey" style={{ background: CATS.find((c) => c.key === inv.category)?.color }} aria-hidden />
          {CAT_LABEL[inv.category ?? "other"]}
        </div>
      </td>
      <td className="hide-sm">
        <span className="catkey" style={{ background: CATS.find((c) => c.key === inv.category)?.color }} aria-hidden />
        {CAT_LABEL[inv.category ?? "other"]}
      </td>
      <td className="r">{n2(inv.amount_cr)}</td>
      <td className="r">{n2(inv.pct_of_anchor)}%</td>
    </tr>
  );

  return (
    <section className="card section" id="anchor">
      <div className="section-head">
        <h2 style={{ margin: 0 }}>Anchor book</h2>
        <span className="muted small">
          {a.bid_date ? `Bid ${a.bid_date}` : ""}
          {a.price ? ` · at ₹${a.price}` : ""}
          {a.pct_of_qib ? ` · ${a.pct_of_qib}% of the QIB portion` : ""}
        </span>
      </div>

      <div className="mini-stats">
        <div>
          <div className="label">Raised</div>
          <div className="value">{crore(s.total_cr)}</div>
          <div className="sub">{issueSizeCr ? `${Math.round((s.total_cr / issueSizeCr) * 100)}% of the issue` : ""}</div>
        </div>
        <div>
          <div className="label">Investors</div>
          <div className="value">{s.investors}</div>
          <div className="sub">in the book</div>
        </div>
        <div>
          <div className="label">Top 5 take</div>
          <div className="value">{s.top5_pct.toFixed(0)}%</div>
          <div className="sub">of the anchor amount</div>
        </div>
        <div>
          <div className="label">Mutual funds</div>
          <div className="value">{s.mf_pct.toFixed(0)}%</div>
          <div className="sub">domestic MFs and SIFs</div>
        </div>
      </div>

      <div className="stackbar" role="img" aria-label={segments.map((c) => `${c.label} ${c.pct}%`).join(", ")}>
        {segments.map((c) => (
          <span key={c.key} style={{ width: `${c.pct}%`, background: c.color }} title={`${c.label}: ${c.pct}%`} />
        ))}
      </div>
      <div className="legend" style={{ marginTop: 8 }}>
        {segments.map((c) => (
          <span key={c.key}>
            <span className="swatch" style={{ background: c.color }} />
            {c.label} <b style={{ color: "var(--ink)" }}>{c.pct.toFixed(0)}%</b>
          </span>
        ))}
      </div>

      <div className="scroll" style={{ marginTop: 12 }}>
        <table>
          <thead>
            <tr>
              <th className="r hide-sm">#</th>
              <th>Investor</th>
              <th className="hide-sm">Type</th>
              <th className="r">₹ Cr</th>
              <th className="r">Share</th>
            </tr>
          </thead>
          <tbody>{investors.slice(0, TOP).map(row)}</tbody>
        </table>
      </div>
      {investors.length > TOP ? (
        <details>
          <summary>Show the other {investors.length - TOP} investors</summary>
          <div className="scroll">
            <table>
              <tbody>{investors.slice(TOP).map((inv, k) => row(inv, k + TOP))}</tbody>
            </table>
          </div>
        </details>
      ) : null}

      <p className="small muted" style={{ margin: "12px 0 0" }}>
        {detail?.anchor_lockin_30 ? `Half the anchor shares unlock ${fmtDate(detail.anchor_lockin_30, true)}` : ""}
        {detail?.anchor_lockin_90 ? `, the rest ${fmtDate(detail.anchor_lockin_90, true)}. ` : ". "}
        Investor type is inferred from the name, so treat it as approximate.
      </p>
    </section>
  );
}

const FIN_LABEL: Record<string, string> = {
  "Total Income": "Total income",
  "Profit After Tax": "Profit after tax",
  "NET Worth": "Net worth",
  "Reserves and Surplus": "Reserves & surplus",
  "Total Borrowing": "Total borrowing",
};

export function Financials({ detail }: { detail: IssueDetail | null }) {
  const f = detail?.financials;
  const k = detail?.kpis ?? {};
  if (!f && !Object.keys(k).length) return null;
  const kpis: [string, string][] = (
    [
      ["ROE", k.roe !== undefined ? `${k.roe}%` : null],
      ["ROCE", k.roce !== undefined ? `${k.roce}%` : null],
      ["Debt / equity", k.debt_equity !== undefined ? `${k.debt_equity}` : null],
      ["PAT margin", k.pat_margin !== undefined ? `${k.pat_margin}%` : null],
      ["EBITDA margin", k.ebitda_margin !== undefined ? `${k.ebitda_margin}%` : null],
      ["Price / book", k.price_to_book !== undefined ? `${k.price_to_book}` : null],
      ["P/E pre-issue", k.pe_pre !== undefined ? `${k.pe_pre}` : null],
      ["P/E post-issue", k.pe_post !== undefined ? `${k.pe_post}` : null],
      ["Market cap", k.market_cap_cr !== undefined ? crore(k.market_cap_cr) : null],
      [
        "Promoter holding",
        k.promoter_pre_pct !== undefined ? `${k.promoter_pre_pct}% → ${k.promoter_post_pct ?? "–"}%` : null,
      ],
    ] as [string, string | null][]
  ).filter((x): x is [string, string] => x[1] !== null);

  return (
    <section className="card section" id="financials">
      <h2>Financials &amp; valuation</h2>
      {f ? (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>{f.unit.replace("Amount in ", "")}</th>
                {f.periods.map((p) => (
                  <th key={p} className="r">
                    {p}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {f.rows.map((r) => (
                <tr key={r.metric}>
                  <td>{FIN_LABEL[r.metric] ?? r.metric}</td>
                  {r.values.map((v, i) => (
                    <td key={i} className="r">
                      {v === null ? "–" : v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {kpis.length ? (
        <div className="kpis">
          {kpis.map(([label, v]) => (
            <div key={label}>
              <div className="label">{label}</div>
              <div className="value">{v}</div>
            </div>
          ))}
        </div>
      ) : null}
      <p className="small muted" style={{ margin: "10px 0 0" }}>
        Restated figures from the offer document. The first period may be a part-year.
      </p>
    </section>
  );
}

export function Peers({ detail, companyName }: { detail: IssueDetail | null; companyName: string }) {
  const p = detail?.peers;
  if (!p || !p.rows.length) return null;
  const first = companyName.toLowerCase().split(" ")[0];
  return (
    <section className="card section" id="peers">
      <div className="section-head">
        <h2 style={{ margin: 0 }}>Listed peers</h2>
        <span className="muted small">From the offer document{p.as_of ? ` · as on ${fmtDate(p.as_of)}` : ""}</span>
      </div>
      <div className="scroll" style={{ marginTop: 10 }}>
        <table>
          <thead>
            <tr>
              {p.columns.map((c, i) => (
                <th key={c} className={i > 0 && i < p.columns.length - 1 ? "r" : ""}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r, k) => {
              const isSelf = k === 0 || r[0].toLowerCase().startsWith(first);
              return (
                <tr key={k} className={isSelf ? "self" : ""}>
                  {r.map((c, i) => (
                    <td key={i} className={i > 0 && i < r.length - 1 ? "r" : ""}>
                      {c || "–"}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ margin: "10px 0 0" }}>
        The company picks this peer set itself. The issue&apos;s own P/E is blank here because it depends on the final price.
      </p>
    </section>
  );
}

export function Objects({ detail }: { detail: IssueDetail | null }) {
  const o = detail?.objects;
  if (!o || !o.length) return null;
  return (
    <section className="card section" id="objects">
      <h2>What the money is for</h2>
      <ol className="objects">
        {o.map((x, k) => (
          <li key={k}>
            <span>{x.object}</span>
            <b className="num">{x.amount_cr !== null ? crore(x.amount_cr) : "–"}</b>
          </li>
        ))}
      </ol>
      <p className="small muted" style={{ margin: "8px 0 0" }}>Fresh-issue proceeds only; OFS money goes to the selling shareholders.</p>
    </section>
  );
}

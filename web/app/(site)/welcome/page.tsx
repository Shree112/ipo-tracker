import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { backtest, pastIssues, stats } from "@/lib/history";
import { PRESETS } from "@/lib/presets";
import { describeRules, rulesFor } from "@/lib/queries";
import { getViewer, requireApproved, viewerId } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pick your alerts" };

async function choose(fd: FormData) {
  "use server";
  const v = await getViewer();
  if (!v || v.status !== "approved") redirect("/signin");
  const id = String(fd.get("preset") ?? "");
  if (id === "keep") {
    await db()`UPDATE alert_rules SET onboarded_at = now() WHERE user_id = ${v.id}::uuid`;
    redirect("/");
  }
  const p = PRESETS.find((x) => x.id === id);
  if (!p) redirect("/welcome");
  const r = p.rules;
  await db()`
    INSERT INTO alert_rules (user_id) VALUES (${v.id}::uuid) ON CONFLICT (user_id) DO NOTHING`;
  await db()`
    UPDATE alert_rules SET
      gmp_pct_min = ${r.gmp_pct_min ?? null}, profit_per_lot_min = ${r.profit_per_lot_min ?? null},
      sub_total_min = ${r.sub_total_min ?? null}, sub_retail_min = ${r.sub_retail_min ?? null},
      sub_qib_min = ${r.sub_qib_min ?? null}, anchor_mf_min = ${r.anchor_mf_min ?? null},
      size_min_cr = ${r.size_min_cr ?? null}, size_max_cr = ${r.size_max_cr ?? null},
      match_mode = ${r.match_mode ?? "all"}, onboarded_at = now(), updated_at = now()
    WHERE user_id = ${v.id}::uuid`;
  redirect("/?welcome=1");
}

const pct = (x: number | null) => (x === null ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);

export default async function Welcome() {
  const uid = await viewerId();
  const [viewer, rules, past] = await Promise.all([requireApproved(), rulesFor(uid), pastIssues()]);
  const all = stats(past);
  const first = viewer.name?.split(" ")[0];
  const current = describeRules(rules);

  return (
    <main className="wrap narrow">
      <div className="page-head">
        <div>
          <div className="eyebrow">Welcome{first ? `, ${first}` : ""}</div>
          <h1 style={{ marginTop: 10 }}>
            What should reach <em>your inbox?</em>
          </h1>
          <p>
            Pick a starting point. You can change every number later on the Alerts page. The history shows how each
            rule would have done on {all.n} mainboard IPOs since 2023, at the listing-day open.
          </p>
        </div>
      </div>

      <div className="presets">
        {PRESETS.map((p) => {
          const b = backtest(past, p.rules);
          return (
            <form key={p.id} action={choose} className="card preset">
              <input type="hidden" name="preset" value={p.id} />
              <div className="grow">
                <h2>{p.title}</h2>
                <p className="small muted" style={{ marginTop: 6 }}>{p.blurb}</p>
                <p className="xs faint" style={{ marginTop: 8 }}>{describeRules({ ...rules!, ...p.rules })}</p>
              </div>
              {b && b.n ? (
                <div className="preset-stats">
                  <div>
                    <span className="label">IPOs</span>
                    <b>{b.n}</b>
                  </div>
                  <div>
                    <span className="label">Listed up</span>
                    <b>{Math.round(b.up)}%</b>
                  </div>
                  <div>
                    <span className="label">Median</span>
                    <b className={b.median! >= 0 ? "up" : "down"}>{pct(b.median)}</b>
                  </div>
                </div>
              ) : (
                <p className="xs muted preset-stats">Uses subscription, which we only have for recent issues, so there&apos;s no long history to test yet.</p>
              )}
              <button className="btn primary" type="submit">
                Start with this
              </button>
            </form>
          );
        })}
      </div>

      <div className="welcome-foot">
        <Link href="/settings" className="btn">
          Build my own
        </Link>
        {current !== "no alerts set" ? (
          <form action={choose}>
            <input type="hidden" name="preset" value="keep" />
            <button className="btn ghost" type="submit">
              Keep my current rules ({current})
            </button>
          </form>
        ) : null}
      </div>
      <p className="xs muted" style={{ marginTop: 18 }}>
        Across all {all.n} issues, {Math.round(all.up)}% opened above the issue price, median {pct(all.median)}. Past listings
        don&apos;t predict future ones, and none of this is investment advice. <Link href="/track-record" className="link">See the full track record</Link>.
      </p>
    </main>
  );
}

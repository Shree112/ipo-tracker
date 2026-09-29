import { revalidatePath } from "next/cache";
import AdminTabs from "@/components/AdminTabs";
import DayBars from "@/components/DayBars";
import { dashboardData } from "@/lib/dashboard";
import { getViewer, requireAdmin } from "@/lib/viewer";
import { telegramStatus, setTelegramWebhook } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard" };

const pct = (x: number | null | undefined, dp = 0) => (x === null || x === undefined || Number.isNaN(x) ? "–" : `${x.toFixed(dp)}%`);
const signed = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);
const ago = (d: Date | string | null) => {
  if (!d) return "never";
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const SOURCE_LABEL: Record<string, string> = {
  "investorgain-light": "Hourly GMP (InvestorGain)",
  "investorgain-live": "Full refresh (twice daily)",
  "investorgain-subscription": "Live subscription",
  "ipowatch-live": "IPO Watch GMP table",
  "ipowatch-gmp-backfill": "IPO Watch backfill",
  "chittorgarh-perf": "Listing results",
};

const checkLabel = (key: string) =>
  key.startsWith("source:")
    ? (SOURCE_LABEL[key.slice(7)] ?? key.slice(7))
    : ({ "gmp-fresh": "GMP for open IPOs", delivery: "Email / Telegram delivery", chatter: "Summaries job" } as Record<string, string>)[key] ?? key;

async function connectTelegram() {
  "use server";
  const v = await getViewer();
  if (!v?.isAdmin) return;
  await setTelegramWebhook();
  revalidatePath("/admin/dashboard");
}

function Tile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="metric">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

export default async function Dashboard() {
  const [viewer, d, tg] = await Promise.all([requireAdmin(), dashboardData(), telegramStatus()]);
  const count = (s: string) => d.members.find((m) => m.status === s)?.n ?? 0;
  const approved = count("approved");
  const sent = d.digests.reduce((a, x) => a + x.n, 0);
  const daily = d.digests.find((x) => x.kind === "daily");
  const clicks = d.clicks.reduce((a, x) => a + x.n, 0);
  const dec = (what: string, source?: string) =>
    d.decisions.filter((x) => x.what === what && (!source || x.source === source)).reduce((a, x) => a + x.n, 0);
  const viaEmail = d.decisions.filter((x) => x.source === "email").reduce((a, x) => a + x.n, 0);
  const allDec = d.decisions.reduce((a, x) => a + x.n, 0);
  const tgLinked = d.channels.filter((c) => c.telegram).reduce((a, c) => a + c.n, 0);
  const paused = d.channels.filter((c) => c.paused).reduce((a, c) => a + c.n, 0);
  const decided = d.allot.allotted + d.allot.not_allotted;
  const bad = d.alerts.filter((a) => !a.ok);

  return (
    <main className="wrap">
      <div className="page-head">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 style={{ marginTop: 10 }}>
            How it&apos;s <em>going</em>
          </h1>
        </div>
        <AdminTabs current="dashboard" pending={viewer.pending} />
      </div>

      {bad.length ? (
        <div className="warn-line health-list" style={{ marginBottom: 14 }}>
          <b>
            {bad.length} check{bad.length === 1 ? "" : "s"} failing
          </b>
          <ul>
            {bad.map((b) => (
              <li key={b.key}>
                <b>{checkLabel(b.key)}</b>: {b.message} <span className="muted">(since {ago(b.since)})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : d.alerts.length ? (
        <div className="saved-line" style={{ marginBottom: 14 }}>All data checks passing.</div>
      ) : null}

      <h2 className="dash-h">Growth</h2>
      <div className="metrics">
        <Tile label="Members" value={approved} sub={`of ${Number(process.env.MAX_USERS) || 100} places`} />
        <Tile label="Waiting" value={count("pending")} sub={`${count("rejected")} declined or removed`} />
        <Tile
          label="Time to approve"
          value={d.approveHours === null ? "–" : d.approveHours < 24 ? `${d.approveHours.toFixed(1)}h` : `${(d.approveHours / 24).toFixed(1)}d`}
          sub="median"
        />
        <Tile
          label="Sign-ups, last 4 weeks"
          value={d.weekly.slice(-4).reduce((a, w) => a + w.n, 0)}
          sub={d.weekly.slice(-4).map((w) => w.n).join(" · ") || "none yet"}
        />
      </div>
      {d.presets.length ? (
        <p className="small muted" style={{ marginTop: 10 }}>
          Starter alerts picked: {d.presets.map((p) => `${p.preset} ${p.n}`).join(" · ")}
        </p>
      ) : null}

      <h2 className="dash-h">Engagement</h2>
      <div className="metrics">
        <Tile label="Active today" value={d.actives.d1} />
        <Tile label="Active this week" value={d.actives.d7} sub={approved ? `${pct((100 * d.actives.d7) / approved)} of members` : ""} />
        <Tile label="Active, 30 days" value={d.actives.d30} />
        <Tile label="Messages sent, 30d" value={sent} sub={`${daily?.n ?? 0} digests to ${daily?.people ?? 0} people`} />
        <Tile label="Click-through" value={sent ? pct((100 * clicks) / sent) : "–"} sub={`${clicks} opens from email / Telegram`} />
        <Tile label="Marked from email" value={allDec ? pct((100 * viaEmail) / allDec) : "–"} sub={`${dec("applied")} applied · ${dec("skipped")} skipped`} />
      </div>
      <div className="grid-main section">
        <section className="card">
          <div className="card-head">
            <h2>Members active per day</h2>
            <span className="sub">last 30 days</span>
          </div>
          <DayBars series={d.dailyActive} unit="active members" />
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Digests sent per day</h2>
            <span className="sub">last 30 days</span>
          </div>
          <DayBars series={d.digestDaily} unit="messages" />
          <p className="xs muted" style={{ marginTop: 8 }}>
            Channels: {approved - tgLinked} email only · {tgLinked} with Telegram linked · {paused} paused
          </p>
        </section>
      </div>

      <h2 className="dash-h">Outcomes</h2>
      <div className="metrics">
        <Tile label="Digest picks listed" value={d.picks?.n ?? 0} sub="IPOs that went out in a digest" />
        <Tile label="Opened above issue price" value={pct(d.picks?.up ?? null)} sub={`median ${signed(d.picks?.median ?? null)}`} />
        <Tile label="Applications marked" value={d.allot.applied} sub={`${decided} with a result`} />
        <Tile
          label="Allotment rate"
          value={decided ? pct((100 * d.allot.allotted) / decided) : "–"}
          sub={`avg listing gain when allotted ${signed(d.allot.gain)}`}
        />
      </div>

      <h2 className="dash-h">System health</h2>
      <section className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Last run</th>
                <th className="hide-sm">Last good</th>
                <th className="r">Runs 24h</th>
                <th className="r">Failed 24h</th>
              </tr>
            </thead>
            <tbody>
              {d.sources.map((s) => (
                <tr key={s.source}>
                  <td>
                    {SOURCE_LABEL[s.source] ?? s.source}
                    {s.last_status !== "ok" && s.msg ? <div className="xs muted">{s.msg}</div> : null}
                  </td>
                  <td>
                    <span className={`badge ${s.last_status === "ok" ? "green" : s.last_status === "running" ? "" : "amber"}`}>{s.last_status}</span>{" "}
                    <span className="small muted">{ago(s.last_run)}</span>
                  </td>
                  <td className="hide-sm small muted">{ago(s.last_ok)}</td>
                  <td className="r">{s.runs}</td>
                  <td className={`r ${s.bad ? "down" : ""}`}>{s.bad}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="kpis">
          <div className="kpi">
            <div className="label">Failed deliveries, 7d</div>
            <div className="value">{d.failures.n}</div>
            {d.failures.last ? <div className="xs muted">{d.failures.last}</div> : null}
          </div>
          <div className="kpi">
            <div className="label">Summaries job</div>
            <div className="value">{ago(d.chatter.last)}</div>
            <div className="xs muted">{d.chatter.summaries} comment · {d.chatter.profiles} company</div>
          </div>
          <div className="kpi">
            <div className="label">Prospectuses loaded</div>
            <div className="value">{d.rhpDocs.find((r) => r.status === "ok")?.n ?? 0}</div>
            <div className="xs muted">{d.rhpDocs.filter((r) => r.status !== "ok").map((r) => `${r.n} ${r.status}`).join(" · ") || "none failed"}</div>
          </div>
          <div className="kpi">
            <div className="label">Telegram bot</div>
            <div className="value">{tg.label}</div>
            {tg.canConnect ? (
              <form action={connectTelegram}>
                <button className="btn small-btn" type="submit" style={{ marginTop: 6 }}>
                  Connect webhook
                </button>
              </form>
            ) : (
              <div className="xs muted">{tg.detail}</div>
            )}
          </div>
        </div>
      </section>
      <p className="xs muted" style={{ marginTop: 14 }}>
        Visits count once per member per day. Click-through is opens of an issue page from a digest link or Telegram
        button, divided by messages sent.
      </p>
    </main>
  );
}

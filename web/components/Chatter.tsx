import type { Chatter as ChatterData } from "@/lib/queries";
import { fmtWhen } from "@/lib/format";
import { Fold } from "./Fold";

const MOOD: Record<string, { label: string; tone: string }> = {
  positive: { label: "Mostly positive", tone: "up" },
  mixed: { label: "Mixed", tone: "warn" },
  negative: { label: "Mostly negative", tone: "down" },
  unclear: { label: "No clear view", tone: "" },
};

const SRC: Record<string, string> = { ipowatch: "IPO Watch", reddit: "Reddit" };

/** "What investors are saying": an AI summary of public comments, or an
 *  honest "not enough yet" when there's too little to go on. */
export default function Chatter({ data, today }: { data: ChatterData | null; today: string }) {
  const sources = data?.sources ?? [];
  const total = sources.reduce((a, s) => a + (s.status === "ok" ? s.n : 0), 0);
  const s = data?.summary ?? null;
  const mood = s ? MOOD[s.mood] ?? MOOD.unclear : null;

  const summary = s ? (
    <>
      <span className={`chip mood ${mood!.tone}`}>
        <b>{mood!.label}</b>
      </span>
      <span className="chip">
        <b>{data!.n_comments ?? total}</b> comments
      </span>
    </>
  ) : (
    <span className="chip">{total ? `Limited data · ${total} comment${total === 1 ? "" : "s"} so far` : "Limited data available"}</span>
  );

  const threads = sources.flatMap((x) => (x.status === "ok" ? (x.threads ?? []).map((t) => ({ ...t, source: x.source })) : []));
  const redditOff = sources.find((x) => x.source === "reddit" && x.status === "not_configured");

  return (
    <Fold id="chatter" title="What investors are saying" summary={summary}>
      {s ? (
        <div className="chatter">
          <p className="chatter-head">{s.headline}</p>
          <ul className="chatter-points">
            {s.points.map((p, k) => (
              <li key={k}>{p}</li>
            ))}
          </ul>
          {s.concerns.length ? (
            <>
              <div className="group-label" style={{ marginTop: 16 }}>Worries raised</div>
              <ul className="chatter-points concerns">
                {s.concerns.map((p, k) => (
                  <li key={k}>{p}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : (
        <p className="muted">
          {total
            ? `Only ${total} comment${total === 1 ? "" : "s"} so far, which isn't enough for a fair summary. This fills in as discussion picks up, usually around the opening days.`
            : "No discussion collected for this issue yet. Summaries appear once people start commenting, usually around the opening days."}
        </p>
      )}

      {threads.length ? (
        <div className="links" style={{ marginTop: 16 }}>
          {threads.slice(0, 6).map((t) => (
            <a key={t.url} href={t.url} target="_blank" rel="noreferrer">
              <span>
                {SRC[t.source]}
                {t.sub ? ` · r/${t.sub}` : ""} · <span className="muted">{t.title}</span>
              </span>
              <span>{t.n} ↗</span>
            </a>
          ))}
        </div>
      ) : null}

      <p className="xs muted" style={{ marginTop: 14 }}>
        {s ? "Summarised by an open-source AI model from public comments" : "From public comments"}
        {data?.summarized_at ? `, ${fmtWhen(data.summarized_at, today)}` : ""}.
        {redditOff ? " Reddit is not connected yet." : ""} It reflects what commenters say, can be wrong, and is not advice.
      </p>
    </Fold>
  );
}

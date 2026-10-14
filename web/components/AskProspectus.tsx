"use client";

import { useState, useTransition, type ReactNode } from "react";
import { askProspectus, type AskResult } from "@/app/(site)/issue/[slug]/actions";

const SUGGESTED = [
  "What are the main risks?",
  "How will the money raised be used?",
  "Who are the promoters and how much do they own?",
  "Is there any major litigation?",
  "How much debt does the company have?",
  "How is the industry doing right now?",
];

type QA = { q: string; r: AskResult };

// Ask questions of this IPO's prospectus. Answers come only from the passages
// found, with page numbers so they can be checked in the PDF.
// The model answers in light markdown: "- " bullets, **bold**, the odd
// "### heading". Render just that much, never raw HTML.
function inline(s: string) {
  return s
    .split(/(\*\*[^*\n]+\*\*)/g)
    .map((part, i) => (part.length > 4 && part.startsWith("**") && part.endsWith("**") ? <b key={i}>{part.slice(2, -2)}</b> : part));
}

function RichAnswer({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (!items.length) return;
    blocks.push(
      <ul key={blocks.length}>
        {items.map((t, i) => (
          <li key={i}>{inline(t)}</li>
        ))}
      </ul>,
    );
    items = [];
  };
  for (const raw of text.split("\n")) {
    const bullet = raw.match(/^\s*(?:[-*•–]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      items.push(bullet[1]);
      continue;
    }
    flush();
    const line = raw.replace(/^\s*#{1,6}\s+/, "").trim();
    if (!line) continue;
    blocks.push(<p key={blocks.length}>{/^#{1,6}\s/.test(raw.trim()) ? <b>{inline(line)}</b> : inline(line)}</p>);
  }
  flush();
  return <div className="ask-a">{blocks}</div>;
}

export default function AskProspectus({
  slug,
  rhpUrl,
  pages,
  web,
}: {
  slug: string;
  rhpUrl: string | null;
  pages: number | null;
  web: boolean;
}) {
  const [q, setQ] = useState("");
  const [log, setLog] = useState<QA[]>([]);
  const [pending, start] = useTransition();
  const ask = (question: string) => {
    if (!question.trim() || pending) return;
    setQ("");
    start(async () => {
      const r = await askProspectus(slug, question);
      setLog((l) => [{ q: question, r }, ...l].slice(0, 6));
    });
  };
  return (
    <div className="ask">
      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
      >
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={web ? "Ask anything about this IPO, the company or its industry…" : "Ask anything about this IPO's prospectus…"}
          maxLength={300}
          aria-label="Question"
        />
        <button className="btn primary" type="submit" disabled={pending || !q.trim()}>
          {pending ? "Reading…" : "Ask"}
        </button>
      </form>
      <div className="chips" style={{ marginTop: 10 }}>
        {SUGGESTED.map((s) => (
          <button key={s} type="button" className="chip chip-btn" onClick={() => ask(s)} disabled={pending}>
            {s}
          </button>
        ))}
      </div>
      {pending ? (
        <p className="small muted" style={{ marginTop: 14 }}>
          Searching {pages ? `${pages} prospectus pages` : "the prospectus"}
          {web ? " and the web" : ""}…
        </p>
      ) : null}
      {log.map((x, k) => (
        <div key={k} className="ask-qa">
          <div className="ask-q">{x.q}</div>
          {x.r.ok ? (
            <>
              <RichAnswer text={x.r.answer} />
              <div className="xs muted ask-src">
                {x.r.pages.length ? (
                  <span>
                    Prospectus pages {x.r.pages.join(", ")}
                    {rhpUrl ? (
                      <>
                        {" · "}
                        <a className="link" href={rhpUrl} target="_blank" rel="noreferrer">
                          open it ↗
                        </a>
                      </>
                    ) : null}
                  </span>
                ) : null}
                {x.r.web.map((w) => (
                  <a key={w.n} className="link" href={w.url} target="_blank" rel="noreferrer">
                    [W{w.n}] {w.title.length > 70 ? `${w.title.slice(0, 67)}…` : w.title} ↗
                  </a>
                ))}
              </div>
            </>
          ) : (
            <div className="ask-a muted">{x.r.error}</div>
          )}
        </div>
      ))}
      <p className="xs muted" style={{ marginTop: 14 }}>
        Answers are written by an open-source AI model from the prospectus{web ? " and web search results" : ""} and can be
        wrong or incomplete. Check the cited sources before relying on anything. Not investment advice.
      </p>
    </div>
  );
}

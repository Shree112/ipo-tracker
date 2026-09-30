import { db, within } from "./db";

// "Ask about this IPO": the few prospectus passages that match the question
// (Postgres full-text search over chunks the chatter job loaded) plus, when a
// Tavily key is set, a handful of current web results - then an open-source
// model on Groq's free tier answers from those sources only, citing prospectus
// pages as (p. 34) and web results as [W1].
//
// Env: GROQ_API_KEY (free at console.groq.com), optional GROQ_MODEL;
//      TAVILY_API_KEY (free at app.tavily.com, 1,000 searches a month).

export const askReady = () => Boolean(process.env.GROQ_API_KEY);
export const webReady = () => Boolean(process.env.TAVILY_API_KEY);
// llama-3.3-70b-versatile was retired by Groq in 2026; gpt-oss-120b is the
// current open-weight model there, with gpt-oss-20b as the fallback when the
// free per-minute limit is hit.
const MODELS = () => [process.env.GROQ_MODEL || "openai/gpt-oss-120b", "openai/gpt-oss-20b"];
export const DAILY_LIMIT = 30;

// Plain questions rarely use the prospectus's own headings; add them.
const EXPAND: [RegExp, string][] = [
  [/risk|danger|concern|worry/i, "risk factors adverse"],
  [/money|proceeds|use of funds|spend|raise|object/i, "objects of the issue net proceeds utilisation"],
  [/promoter|owner|founder|who runs|management/i, "promoters promoter group shareholding directors"],
  [/case|court|litigation|legal|lawsuit/i, "outstanding litigation proceedings"],
  [/debt|borrow|loan/i, "borrowings indebtedness"],
  [/profit|revenue|income|financial|margin/i, "restated financial information revenue profit"],
  [/competit|peer|rival/i, "competition competitors industry"],
  [/customer|client/i, "customers concentration revenue"],
  [/dividend/i, "dividend policy"],
  [/valuation|price|p\/e|expensive/i, "basis for issue price earnings per share"],
];

export type Excerpt = { page: number; content: string };

export async function retrieve(slug: string, question: string): Promise<Excerpt[]> {
  const extra = EXPAND.filter(([re]) => re.test(question)).map(([, w]) => w).join(" ");
  const q = `${question} ${extra}`.slice(0, 500);
  return db()<Excerpt[]>`
    WITH q AS (SELECT NULLIF(replace(plainto_tsquery('english', ${q})::text, '&', '|'), '')::tsquery AS q)
    SELECT c.page, c.content
    FROM rhp_chunk c, q
    WHERE c.issue_id = (SELECT id FROM issues WHERE slug = ${slug}) AND q.q IS NOT NULL AND c.tsv @@ q.q
    ORDER BY ts_rank_cd(c.tsv, q.q) DESC
    LIMIT 5`;
}

export type WebResult = { title: string; url: string; content: string; published?: string };

/** A few current web results for the question (1 Tavily credit). Never throws. */
export async function webSearch(company: string, question: string): Promise<WebResult[]> {
  if (!webReady()) return [];
  try {
    const r = await fetch(process.env.TAVILY_URL || "https://api.tavily.com/search", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.TAVILY_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: `${company} ${question}`.slice(0, 380),
        search_depth: "basic",
        max_results: 5,
        country: "india",
      }),
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) {
      console.error("tavily", r.status, (await r.text()).slice(0, 200));
      return [];
    }
    const j = (await r.json()) as { results?: { title?: string; url?: string; content?: string; published_date?: string }[] };
    return (j.results ?? [])
      .filter((x) => x.url && x.content)
      .slice(0, 5)
      .map((x) => ({ title: String(x.title ?? x.url), url: String(x.url), content: String(x.content).slice(0, 700), published: x.published_date }));
  } catch (e) {
    console.error("tavily", e instanceof Error ? e.message : e);
    return [];
  }
}

export async function prospectusStatus(slug: string): Promise<{ status: string; pages: number | null } | null> {
  const [r] = await within(
    db()<{ status: string; pages: number | null }[]>`
      SELECT d.status, d.pages FROM rhp_doc d JOIN issues i ON i.id = d.issue_id WHERE i.slug = ${slug}`,
    6000,
    "prospectus status",
  ).catch(() => []);
  return r ?? null;
}

export class AskError extends Error {
  constructor(public kind: "busy" | "model", message: string) {
    super(message);
  }
}

export async function answer(company: string, question: string, excerpts: Excerpt[], web: WebResult[]): Promise<string> {
  const rhp = excerpts.map((e) => `[page ${e.page}]\n${e.content.slice(0, 1100)}`).join("\n\n---\n\n");
  const webText = web
    .map((w, k) => `[W${k + 1}] ${w.title}${w.published ? ` (${w.published.slice(0, 10)})` : ""}\n${w.content}`)
    .join("\n\n");
  const base = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
  const today = new Date().toISOString().slice(0, 10);
  const system = `You answer questions about ${company}'s IPO in India. Today is ${today}.
Use ONLY the sources given: prospectus excerpts (cite as (p. 34)) and web results (cite as [W1]).
- Prefer the prospectus for facts about the company and the offer; use web results for recent news, the industry, peers and anything after the prospectus date, and say when they disagree.
- Answer in 2 to 6 short sentences or bullets, in plain English. Put a citation after each fact.
- Quote numbers exactly as written. If the sources don't answer the question, say so plainly and suggest where to look.
- Never give investment advice or say whether to apply.`;
  const user = `Question: ${question}\n\nProspectus excerpts:\n\n${rhp || "(none matched)"}\n\nWeb results:\n\n${webText || "(none)"}`;
  let lastErr = "";
  for (const model of MODELS()) {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(18000),
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_completion_tokens: 900,
        reasoning_effort: "low",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    }).catch((e: unknown) => {
      lastErr = e instanceof Error ? e.name : String(e);
      return null;
    });
    if (!r) continue;
    if (r.ok) {
      const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
      const text = (j.choices?.[0]?.message?.content ?? "").trim();
      if (text) return text;
      lastErr = "empty answer";
      continue;
    }
    const body = (await r.text()).slice(0, 300);
    console.error("groq", model, r.status, body);
    lastErr = `${r.status}`;
    if (r.status === 429 || r.status === 413 || r.status === 404 || r.status >= 500) continue; // try the next model
    throw new AskError("model", `The AI service refused the request (${r.status}).`);
  }
  if (lastErr === "429") throw new AskError("busy", "Lots of questions right now - try again in a minute.");
  throw new AskError("model", lastErr === "TimeoutError" ? "The AI took too long to answer. Try again." : `The AI service didn't answer (${lastErr}).`);
}

export async function questionsToday(userId: string): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app_event WHERE kind = 'rhp_question' AND user_id = ${userId}::uuid
      AND at > date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`.catch(() => [{ n: 0 }]);
  return r?.n ?? 0;
}

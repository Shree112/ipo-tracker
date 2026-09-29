import { db, within } from "./db";

// "Ask the prospectus": find the few RHP passages that match the question
// (Postgres full-text search over chunks the chatter job loaded), then have an
// open-source model on Groq's free tier answer from those passages only, with
// page numbers.
//
// Env: GROQ_API_KEY (free at console.groq.com), optional GROQ_MODEL.

export const askReady = () => Boolean(process.env.GROQ_API_KEY);
const MODEL = () => process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
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
    LIMIT 6`;
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

export async function answer(company: string, question: string, excerpts: Excerpt[]): Promise<string> {
  const context = excerpts.map((e) => `[page ${e.page}]\n${e.content}`).join("\n\n---\n\n");
  const base = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      model: MODEL(),
      temperature: 0.1,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: `You answer questions about ${company}'s IPO using ONLY the prospectus excerpts provided.
- Answer in 2 to 5 short sentences or bullets, in plain English.
- Cite pages like (p. 34) after the facts they support.
- Quote numbers exactly as written. If the excerpts don't answer the question, say "The parts of the prospectus I found don't cover this" and suggest what section to look in.
- Never give investment advice or say whether to apply.`,
        },
        { role: "user", content: `Question: ${question}\n\nProspectus excerpts:\n\n${context}` },
      ],
    }),
  });
  if (!r.ok) throw new Error(`model error ${r.status}`);
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return (j.choices?.[0]?.message?.content ?? "").trim();
}

export async function questionsToday(userId: string): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app_event WHERE kind = 'rhp_question' AND user_id = ${userId}::uuid
      AND at > date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`.catch(() => [{ n: 0 }]);
  return r?.n ?? 0;
}

"use server";

import { revalidatePath } from "next/cache";
import { setAllotment, setDecision, type Allotment, type Decision } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";
import { logEvent } from "@/lib/events";

// Server actions are POSTs, so link scanners and email prefetchers can't
// trigger them - the reason the email has no bare "applied" links.
export async function decide(formData: FormData) {
  const slug = String(formData.get("slug") || "");
  const decision = String(formData.get("decision") || "") as Decision;
  const noteRaw = String(formData.get("note") || "").trim();
  if (!slug || !["applied", "skipped", "undo"].includes(decision)) return;
  const viewer = await getViewer();
  if (!viewer || viewer.status !== "approved") throw new Error("not signed in");
  await setDecision(viewer.id, slug, decision, noteRaw ? noteRaw.slice(0, 200) : null);
  logEvent("decision", viewer.id, slug, { decision, source: "site" });
  // Only this page re-renders now; the home list picks the change up on its
  // next load (it's dynamic), so the tap doesn't wait on a second render.
  revalidatePath(`/issue/${slug}`);
}

export async function markAllotment(formData: FormData) {
  const slug = String(formData.get("slug") || "");
  const result = String(formData.get("result") || "") as Allotment;
  if (!slug || !["allotted", "not_allotted", "unknown"].includes(result)) return;
  const viewer = await getViewer();
  if (!viewer || viewer.status !== "approved") throw new Error("not signed in");
  await setAllotment(viewer.id, slug, result);
  logEvent("allotment", viewer.id, slug, { result, source: "site" });
  revalidatePath(`/issue/${slug}`);
}

export type AskResult =
  | { ok: true; answer: string; pages: number[]; web: { n: number; title: string; url: string }[] }
  | { ok: false; error: string };

export async function askProspectus(slug: string, question: string): Promise<AskResult> {
  const { answer, askReady, AskError, DAILY_LIMIT, questionsToday, retrieve, webSearch } = await import("@/lib/ask");
  const q = question.trim().slice(0, 300);
  if (!q) return { ok: false, error: "Type a question first." };
  if (!askReady()) return { ok: false, error: "Questions aren't switched on yet." };
  const viewer = await getViewer();
  if (!viewer || viewer.status !== "approved") return { ok: false, error: "Sign in to ask questions." };
  if ((await questionsToday(viewer.id)) >= DAILY_LIMIT)
    return { ok: false, error: `That's ${DAILY_LIMIT} questions today. The limit resets at midnight.` };
  const { db } = await import("@/lib/db");
  const [co] = await db()<{ name: string }[]>`SELECT name FROM issues WHERE slug = ${slug}`;
  const company = (co?.name ?? slug).replace(/ (Ltd|Limited)\.?$/i, "");
  // prospectus and web in parallel
  const [excerpts, web] = await Promise.all([retrieve(slug, q).catch(() => []), webSearch(company, q)]);
  logEvent("rhp_question", viewer.id, slug, { found: excerpts.length, web: web.length });
  if (!excerpts.length && !web.length)
    return { ok: false, error: "Couldn't find anything on that. Try different words, like 'risk factors' or 'objects of the issue'." };
  try {
    const text = await answer(company, q, excerpts, web);
    // only list the sources the answer actually cites
    const pages = [...new Set(excerpts.map((e) => e.page))].filter((p) => new RegExp(`p\\.\\s*${p}\\b`).test(text));
    const cited = web.map((w, k) => ({ n: k + 1, title: w.title, url: w.url })).filter((w) => text.includes(`[W${w.n}]`));
    return {
      ok: true,
      answer: text,
      pages: pages.sort((a, b) => a - b),
      web: cited,
    };
  } catch (e) {
    return { ok: false, error: e instanceof AskError ? e.message : "Something went wrong answering that. Try again." };
  }
}

export type RefreshSubResult = { ok: boolean; message: string };

/** The Refresh button on the Subscription card: fetch InvestorGain's live
 *  report now (members only; a fetch in the last minute is reused). */
export async function refreshSubscriptionNow(slug: string): Promise<RefreshSubResult> {
  const viewer = await getViewer();
  if (!viewer || viewer.status !== "approved") return { ok: false, message: "Sign in to refresh." };
  const { refreshSubscription } = await import("@/lib/subscription");
  const r = await refreshSubscription("button");
  revalidatePath(`/issue/${slug}`);
  if (r.status === "error") return { ok: false, message: "Couldn't reach the source just now - try again in a minute." };
  if (r.status === "updated") return { ok: true, message: "New numbers loaded." };
  if (r.status === "recent") return { ok: true, message: "Up to date - checked within the last minute." };
  return { ok: true, message: "Up to date - no change since the last reading." };
}

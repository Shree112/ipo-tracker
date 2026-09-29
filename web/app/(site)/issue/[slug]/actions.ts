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

export type AskResult = { ok: true; answer: string; pages: number[] } | { ok: false; error: string };

export async function askProspectus(slug: string, question: string): Promise<AskResult> {
  const { answer, askReady, DAILY_LIMIT, questionsToday, retrieve } = await import("@/lib/ask");
  const q = question.trim().slice(0, 300);
  if (!q) return { ok: false, error: "Type a question first." };
  if (!askReady()) return { ok: false, error: "The prospectus chat isn't switched on yet." };
  const viewer = await getViewer();
  if (!viewer || viewer.status !== "approved") return { ok: false, error: "Sign in to ask the prospectus." };
  if ((await questionsToday(viewer.id)) >= DAILY_LIMIT)
    return { ok: false, error: `That's ${DAILY_LIMIT} questions today. The limit resets at midnight.` };
  const excerpts = await retrieve(slug, q).catch(() => []);
  logEvent("rhp_question", viewer.id, slug, { found: excerpts.length });
  if (!excerpts.length)
    return { ok: false, error: "Couldn't find anything on that in the prospectus. Try different words, like 'risk factors' or 'objects of the issue'." };
  const { db } = await import("@/lib/db");
  const [co] = await db()<{ name: string }[]>`SELECT name FROM issues WHERE slug = ${slug}`;
  try {
    const text = await answer(co?.name ?? slug, q, excerpts);
    return { ok: true, answer: text, pages: [...new Set(excerpts.map((e) => e.page))].sort((a, b) => a - b) };
  } catch {
    return { ok: false, error: "The model didn't answer in time. Try again in a moment." };
  }
}

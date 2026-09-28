"use server";

import { revalidatePath } from "next/cache";
import { setDecision, type Decision } from "@/lib/queries";

// Server actions are POSTs, so link scanners and email prefetchers can't
// trigger them - the reason the email has no bare "applied" links.
export async function decide(formData: FormData) {
  const slug = String(formData.get("slug") || "");
  const decision = String(formData.get("decision") || "") as Decision;
  const noteRaw = String(formData.get("note") || "").trim();
  if (!slug || !["applied", "skipped", "undo"].includes(decision)) return;
  await setDecision(slug, decision, noteRaw ? noteRaw.slice(0, 200) : null);
  // Only this page re-renders now; the home list picks the change up on its
  // next load (it's dynamic), so the tap doesn't wait on a second render.
  revalidatePath(`/issue/${slug}`);
}

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
  revalidatePath(`/issue/${slug}`);
  revalidatePath("/");
}

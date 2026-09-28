"use server";

import { revalidatePath } from "next/cache";
import { setAllotment, setDecision, type Allotment, type Decision } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";

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
  revalidatePath(`/issue/${slug}`);
}

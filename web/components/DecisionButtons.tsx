"use client";

import { useFormStatus } from "react-dom";
import { decide } from "@/app/issue/[slug]/actions";

function Submit({ decision, label, primary }: { decision: string; label: string; primary?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className={`btn ${primary ? "primary" : ""}`} type="submit" name="decision" value={decision} disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

export default function DecisionButtons({ slug, status, note }: { slug: string; status: string; note: string | null }) {
  const resolved = status === "applied" || status === "skipped";
  return (
    <form action={decide} className="decide">
      <input type="hidden" name="slug" value={slug} />
      {resolved ? (
        <>
          <span className="small muted">
            Marked <b style={{ color: "var(--ink)" }}>{status}</b>
            {note ? ` · ${note}` : ""} — it won&apos;t appear in the digest.
          </span>
          <button className="btn link" type="submit" name="decision" value="undo">
            Undo
          </button>
        </>
      ) : (
        <>
          <Submit decision="applied" label="Applied" primary />
          <Submit decision="skipped" label="Skip" />
          <input className="note-input" name="note" placeholder="Note (optional)" maxLength={200} aria-label="Note" />
        </>
      )}
    </form>
  );
}

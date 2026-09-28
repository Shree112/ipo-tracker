"use client";

import { useOptimistic, useTransition } from "react";
import { decide } from "@/app/issue/[slug]/actions";

type State = { status: string; note: string | null };

// Optimistic: the button flips to "Marked applied" the moment it's tapped;
// the database write happens in the background and the page reconciles
// when it's done. If the write fails, React rolls the state back.
export default function DecisionButtons({ slug, status, note }: { slug: string; status: string; note: string | null }) {
  const [state, setOptimistic] = useOptimistic<State, State>({ status, note }, (_, next) => next);
  const [pending, start] = useTransition();
  const resolved = state.status === "applied" || state.status === "skipped";

  const submit = (decision: "applied" | "skipped" | "undo", form: HTMLFormElement | null) => {
    const fd = new FormData(form ?? undefined);
    fd.set("slug", slug);
    fd.set("decision", decision);
    const n = String(fd.get("note") || "").trim() || null;
    start(async () => {
      setOptimistic(decision === "undo" ? { status: "notified", note: null } : { status: decision, note: n ?? state.note });
      await decide(fd);
    });
  };

  return (
    <form className="decide" onSubmit={(e) => e.preventDefault()}>
      {resolved ? (
        <>
          <span className="small muted">
            Marked <b style={{ color: "var(--ink)" }}>{state.status}</b>
            {state.note ? ` · ${state.note}` : ""}
            {pending ? " · saving…" : ""}
          </span>
          <button className="btn ghost" type="button" onClick={(e) => submit("undo", e.currentTarget.form)}>
            Undo
          </button>
        </>
      ) : (
        <>
          <input className="input" name="note" placeholder="Note (optional)" maxLength={200} aria-label="Note" />
          <button className="btn" type="button" onClick={(e) => submit("skipped", e.currentTarget.form)}>
            Skip
          </button>
          <button className="btn primary" type="button" onClick={(e) => submit("applied", e.currentTarget.form)}>
            Mark applied
          </button>
        </>
      )}
    </form>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { refreshSubscriptionNow } from "@/app/(site)/issue/[slug]/actions";

// "Refresh" on the Subscription card: pulls the live numbers now instead of
// waiting for the 10-minute update, then re-renders the card.
export default function RefreshSubscription({ slug, unchangedSince }: { slug: string; unchangedSince: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="sub-refresh">
      <button
        type="button"
        className="btn ghost sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setNote(null);
            const r = await refreshSubscriptionNow(slug);
            setNote(r.message);
            router.refresh();
          })
        }
      >
        <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden className={pending ? "spin" : undefined}>
          <path
            d="M12 7a5 5 0 11-1.46-3.54M12 2v3h-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {pending ? "Checking…" : "Refresh"}
      </button>
      <span className="xs muted" aria-live="polite">
        {note ?? (unchangedSince ? `Numbers unchanged since ${unchangedSince}` : "")}
      </span>
    </div>
  );
}

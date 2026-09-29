"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Shown when a page couldn't load its data (the database didn't answer in
// time, usually). The top bar stays; one tap tries again on fresh
// connections.
export default function SiteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="wrap narrow">
      <div className="page-head">
        <div>
          <div className="eyebrow">Hiccup</div>
          <h1 style={{ marginTop: 10 }}>This page didn&apos;t load</h1>
          <p>The data took too long to arrive. It&apos;s usually a one-off - try again.</p>
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <button
          className="btn primary"
          type="button"
          onClick={() => {
            router.refresh();
            reset();
          }}
        >
          Try again
        </button>
        <a className="btn ghost" href="/">
          Live IPOs
        </a>
      </div>
      {error.digest ? (
        <p className="xs muted" style={{ marginTop: 16 }}>
          Reference {error.digest}
        </p>
      ) : null}
    </main>
  );
}

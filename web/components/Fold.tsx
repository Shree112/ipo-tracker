import Link from "next/link";

const Caret = () => (
  <span className="caret" aria-hidden>
    <svg width="14" height="14" viewBox="0 0 14 14">
      <path d="M3 5l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </span>
);

const Lock = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden>
    <rect x="2.5" y="6.2" width="9" height="6.3" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="M4.6 6.2V4.6a2.4 2.4 0 014.8 0v1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

/** A section that starts closed: title plus a one-line summary, tap to open. */
export function Fold({
  id,
  title,
  summary,
  children,
  open = false,
}: {
  id: string;
  title: string;
  summary?: React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
}) {
  return (
    <details className="card section fold" id={id} open={open}>
      <summary>
        <div className="grow">
          <h2>{title}</h2>
          {summary ? <div className="chips">{summary}</div> : null}
        </div>
        <Caret />
      </summary>
      {children}
    </details>
  );
}

/** The same row for signed-out visitors: says what's inside, links to sign-in. */
export function LockedFold({ id, title, blurb, next }: { id: string; title: string; blurb: string; next: string }) {
  return (
    <Link href={`/signin?next=${encodeURIComponent(next)}`} className="card section fold-locked" id={id}>
      <div className="grow">
        <h2>{title}</h2>
        <p className="small muted">{blurb}</p>
      </div>
      <span className="lock-cta">
        <Lock /> Sign in to see
      </span>
    </Link>
  );
}

import Link from "next/link";

const Spark = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <defs>
      <linearGradient id="aiSpark" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stopColor="var(--ai-1)" />
        <stop offset="1" stopColor="var(--ai-2)" />
      </linearGradient>
    </defs>
    <path d="M12 2c.5 4.6 2 6.6 6.8 7.2-4.8.6-6.3 2.6-6.8 7.2-.5-4.6-2-6.6-6.8-7.2C10 8.6 11.5 6.6 12 2z" fill="url(#aiSpark)" />
    <path d="M19 14.5c.25 2 .9 2.8 3 3.1-2.1.3-2.75 1.1-3 3.1-.25-2-.9-2.8-3-3.1 2.1-.3 2.75-1.1 3-3.1z" fill="url(#aiSpark)" opacity=".75" />
  </svg>
);

/** The "Ask AI" block on an issue page: set apart from the data cards so it
 *  reads as a feature, not another table. Members get the question box;
 *  everyone else sees what it does and a sign-in link. */
export default function AskCard({
  name,
  member,
  next,
  sources,
  children,
}: {
  name: string;
  member: boolean;
  next: string;
  sources: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="ai-card section" id="ask" aria-labelledby="ask-title">
      <div className="ai-inner">
        <div className="ai-head">
          <span className="ai-icon">
            <Spark />
          </span>
          <div className="grow">
            <h2 id="ask-title">
              Ask AI about {name} <span className="ai-badge">AI</span>
            </h2>
            <p className="xs muted">
              Plain-English answers{sources ? ` from the ${sources}` : ""}, with every source cited.
            </p>
          </div>
        </div>
        {member ? (
          children
        ) : (
          <div className="ai-locked">
            <p className="small">
              &ldquo;What are the main risks?&rdquo; &middot; &ldquo;How will the money be used?&rdquo; &middot; &ldquo;How is the
              industry doing?&rdquo;
            </p>
            <Link href={`/signin?next=${encodeURIComponent(next)}`} className="btn ai-btn">
              Sign in to ask
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}

import Link from "next/link";

// The reason to sign up is the automation, not the data: set rules once, get
// one email on mornings an IPO matches, act on it from the inbox. Every
// signed-out page leads with that.

export type PitchExample = { name: string; gmp: string; size: string; closes: string };

const STEPS: [string, string][] = [
  ["Set your rules once", "GMP %, expected profit per lot, subscription, anchor book, issue size. All of them or any one."],
  ["We watch every IPO", "GMP and subscription are checked every hour, and every few minutes on the last day."],
  ["One email when it matches", "At the hour you pick, only on days something qualifies. Tap Applied or Skip right in the email."],
];

export default function AlertsPitch({
  next = "/",
  compact = false,
  example,
}: {
  next?: string;
  compact?: boolean;
  example?: PitchExample | null;
}) {
  const href = `/signin?next=${encodeURIComponent(next)}`;
  if (compact) {
    return (
      <Link href={href} className="pitch-strip">
        <span className="pitch-icon" aria-hidden>
          <svg width="16" height="16" viewBox="0 0 16 16">
            <path d="M2.5 4.5h11v7a1 1 0 01-1 1h-9a1 1 0 01-1-1v-7zM2.5 4.5l5.5 4 5.5-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="grow">
          <b>Stop checking GMP every morning.</b>{" "}
          <span className="muted">Set your rules once and get an email only when an IPO like this matches.</span>
        </span>
        <span className="pitch-go">Set up alerts →</span>
      </Link>
    );
  }
  return (
    <section className="pitch card">
      <div className="pitch-copy">
        <span className="badge green">
          <span className="dot" aria-hidden /> Free · invite-only
        </span>
        <h2 className="pitch-title">Stop checking GMP every morning.</h2>
        <p className="pitch-sub">
          Tell IPO Copilot what makes an IPO worth applying for. It watches every mainboard issue and emails you only when
          one qualifies.
        </p>
        <ol className="pitch-steps">
          {STEPS.map(([t, d], k) => (
            <li key={t}>
              <span className="n" aria-hidden>{k + 1}</span>
              <div>
                <b>{t}</b>
                <div className="small muted">{d}</div>
              </div>
            </li>
          ))}
        </ol>
        <div className="pitch-cta">
          <Link href={href} className="btn primary big">
            Set up my alerts
          </Link>
          <span className="xs muted">Sign in with Google · accounts approved by hand</span>
        </div>
      </div>
      {example ? (
        <div className="mail-mock" aria-label="Example digest email">
          <div className="mail-top">
            <span className="mail-dot" aria-hidden />
            <div>
              <b>IPO Copilot</b>
              <div className="xs muted">8:00 am · your daily digest</div>
            </div>
          </div>
          <div className="mail-subj">1 IPO matches your alerts</div>
          <div className="mail-card">
            <div className="mail-name">{example.name}</div>
            <div className="mail-why">Matched your alerts: GMP {example.gmp}</div>
            <div className="mail-nums">
              <div>
                <span>GMP</span>
                <b>{example.gmp}</b>
              </div>
              <div>
                <span>Size</span>
                <b>{example.size}</b>
              </div>
              <div>
                <span>Closes</span>
                <b>{example.closes}</b>
              </div>
            </div>
            <div className="mail-btns">
              <span className="mb primary">Applied</span>
              <span className="mb">Skip</span>
              <span className="mb ghost">Details</span>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

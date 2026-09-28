import Link from "next/link";

// Shared shell for /privacy and /terms: public pages (no sign-in), linked from
// the sign-in page and from the Google consent screen.
export default function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <main className="wrap">
      <article className="legal">
        <Link href="/signin" className="logo" style={{ marginBottom: 32 }}>
          <span className="logo-mark" aria-hidden>IC</span>
          <span>IPO Copilot</span>
        </Link>
        <h1>{title}</h1>
        <p className="muted small">Last updated {updated}</p>
        {children}
        <p className="small muted legal-foot">
          <Link href="/privacy" className="link">Privacy</Link> · <Link href="/terms" className="link">Terms</Link> ·{" "}
          <Link href="/signin" className="link">Sign in</Link>
        </p>
      </article>
    </main>
  );
}

export const contactEmail = () => process.env.CONTACT_EMAIL || process.env.ADMIN_EMAIL || "ahuja.shree31@gmail.com";

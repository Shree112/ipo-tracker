import Link from "next/link";
import TopBar from "@/components/TopBar";
import { getViewer } from "@/lib/viewer";

// The header lives in the layout so it stays on screen while the next page
// loads: tapping Alerts or Members swaps only the content below it, and the
// page's loading skeleton shows immediately instead of a frozen screen.
// A page that can't get its data in time shows error.tsx; this cap only stops
// a stuck request from running for Vercel's full 300 seconds.
export const maxDuration = 30;

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  // if the account lookup fails, the page below shows the error and a retry
  const viewer = await getViewer().catch(() => null);
  return (
    <>
      <TopBar viewer={viewer} />
      {children}
      <footer className="site-footer">
        <div className="wrap">
          <span className="xs muted">GMP is an unofficial grey-market quote. Nothing here is investment advice.</span>
          <nav className="small">
            <Link className="link" href="/feedback">
              Feedback
            </Link>
            <Link className="link" href="/privacy">
              Privacy
            </Link>
            <Link className="link" href="/terms">
              Terms
            </Link>
          </nav>
        </div>
      </footer>
    </>
  );
}

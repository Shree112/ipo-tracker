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
    </>
  );
}

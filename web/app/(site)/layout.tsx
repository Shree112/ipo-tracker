import TopBar from "@/components/TopBar";
import { getViewer } from "@/lib/viewer";

// The header lives in the layout so it stays on screen while the next page
// loads: tapping Alerts or Members swaps only the content below it, and the
// page's loading skeleton shows immediately instead of a frozen screen.
export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();
  return (
    <>
      <TopBar viewer={viewer} />
      {children}
    </>
  );
}

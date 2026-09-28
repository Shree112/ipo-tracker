import Link from "next/link";
import { fmtDate, todayIST } from "@/lib/format";
import type { Viewer } from "@/lib/viewer";

export default function TopBar({ viewer, current }: { viewer?: Viewer | null; current?: "home" | "settings" | "admin" }) {
  const approved = viewer?.status === "approved";
  const initial = (viewer?.name || viewer?.email || "?").charAt(0).toUpperCase();
  return (
    <header className="site-header">
      <div className="wrap">
        <Link href="/" className="logo" aria-label="IPO Copilot home">
          <span className="logo-mark" aria-hidden>IC</span>
          <span>IPO Copilot</span>
        </Link>
        {approved ? (
          <nav className="site-nav">
            <Link href="/" aria-current={current === "home" ? "page" : undefined}>
              Live IPOs
            </Link>
            <Link href="/settings" aria-current={current === "settings" ? "page" : undefined}>
              Alerts
            </Link>
            {viewer?.isAdmin ? (
              <Link href="/admin" aria-current={current === "admin" ? "page" : undefined}>
                Members
                {viewer.pending ? <span className="nav-count">{viewer.pending}</span> : null}
              </Link>
            ) : null}
          </nav>
        ) : (
          <span className="grow" />
        )}
        <span className="header-date">{fmtDate(todayIST(), true)} · IST</span>
        {viewer ? (
          <details className="menu">
            <summary aria-label="Account">
              <span className="me">{initial}</span>
            </summary>
            <div className="menu-pop">
              <div className="menu-who">
                {viewer.name ? <b>{viewer.name}</b> : null}
                <span className="muted small">{viewer.email}</span>
              </div>
              {approved ? <Link href="/settings">Alert settings</Link> : null}
              {viewer.isAdmin ? <Link href="/admin">Members</Link> : null}
              <form action="/auth/signout" method="post">
                <button type="submit">Sign out</button>
              </form>
            </div>
          </details>
        ) : null}
      </div>
    </header>
  );
}

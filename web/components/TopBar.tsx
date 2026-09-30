import Link from "next/link";
import { fmtDate, todayIST } from "@/lib/format";
import type { Viewer } from "@/lib/viewer";
import { NavLink, SignInLink } from "./NavLink";
import ThemeToggle from "./ThemeToggle";
import LogoMark from "./LogoMark";

export default function TopBar({ viewer }: { viewer?: Viewer | null }) {
  const approved = viewer?.status === "approved";
  const initial = (viewer?.name || viewer?.email || "?").charAt(0).toUpperCase();
  return (
    <header className="site-header">
      <div className="wrap">
        <Link href="/" className="logo" aria-label="IPO Copilot home">
          <LogoMark size={30} />
          <span>IPO Copilot</span>
        </Link>
        <nav className="site-nav">
          <NavLink href="/" exact>
            Live IPOs
          </NavLink>
          <NavLink href="/track-record">Track record</NavLink>
          {approved ? <NavLink href="/my-ipos">My IPOs</NavLink> : null}
          {approved ? <NavLink href="/settings">Alerts</NavLink> : null}
          {approved && viewer?.isAdmin ? (
            <NavLink href="/admin/dashboard" match="/admin">
              Admin
              {viewer.pending ? <span className="nav-count">{viewer.pending}</span> : null}
            </NavLink>
          ) : null}
        </nav>
        <span className="header-date">{fmtDate(todayIST(), true)} · IST</span>
        <ThemeToggle />
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
              {approved ? <Link href="/my-ipos">My IPOs</Link> : null}
              {viewer.isAdmin ? <Link href="/admin/dashboard">Admin</Link> : null}
              <form action="/auth/signout" method="post">
                <button type="submit">Sign out</button>
              </form>
            </div>
          </details>
        ) : (
          <SignInLink />
        )}
      </div>
    </header>
  );
}

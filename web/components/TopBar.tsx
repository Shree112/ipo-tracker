import Link from "next/link";
import { fmtDate, todayIST } from "@/lib/format";

export default function TopBar() {
  return (
    <header className="site-header">
      <div className="wrap">
        <Link href="/" className="logo" aria-label="IPO Copilot home">
          <span className="logo-mark" aria-hidden>IC</span>
          <span>IPO Copilot</span>
        </Link>
        <nav className="site-nav">
          <Link href="/">Live IPOs</Link>
        </nav>
        <span className="header-date">{fmtDate(todayIST(), true)} · IST</span>
      </div>
    </header>
  );
}

import Link from "next/link";

export default function TopBar() {
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        IPO <span>Copilot</span>
      </Link>
      <nav>
        <Link href="/">Live IPOs</Link>
      </nav>
    </header>
  );
}

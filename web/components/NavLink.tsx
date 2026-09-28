"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The header is rendered once in the layout, so which tab is current (and
// where "Sign in" should return to) is worked out in the browser.
export function NavLink({ href, exact, children }: { href: string; exact?: boolean; children: React.ReactNode }) {
  const path = usePathname();
  const current = exact ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <Link href={href} aria-current={current ? "page" : undefined}>
      {children}
    </Link>
  );
}

export function SignInLink() {
  const path = usePathname();
  const href = path && path !== "/" ? `/signin?next=${encodeURIComponent(path)}` : "/signin";
  return (
    <Link href={href} className="btn primary small-btn">
      Sign in
    </Link>
  );
}

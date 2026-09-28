"use client";

import { useEffect } from "react";

// The "On this page" links jump to sections that may be folded shut; open the
// fold they land on (and any fold the page is opened at, e.g. /issue/x#anchor).
export default function OpenOnHash() {
  useEffect(() => {
    const open = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      const el = id ? document.getElementById(id) : null;
      if (el instanceof HTMLDetailsElement && !el.open) el.open = true;
    };
    // clicking the same link again after closing the fold doesn't change the
    // hash, so listen for the click as well
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest?.('a[href^="#"]');
      if (a) setTimeout(open, 0);
    };
    open();
    window.addEventListener("hashchange", open);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", open);
      document.removeEventListener("click", onClick);
    };
  }, []);
  return null;
}

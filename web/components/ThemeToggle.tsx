"use client";

import { useEffect, useState } from "react";

// Dark is the default; this flips to light and remembers it in this browser.
export default function ThemeToggle() {
  const [light, setLight] = useState(false);
  useEffect(() => setLight(document.documentElement.dataset.theme === "light"), []);
  const flip = () => {
    const next = !light;
    setLight(next);
    if (next) document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem("ipo-theme", next ? "light" : "dark");
    } catch {
      // private mode: the choice just won't be remembered
    }
  };
  return (
    <button type="button" className="theme-btn" onClick={flip} aria-label={light ? "Switch to dark theme" : "Switch to light theme"} title={light ? "Dark theme" : "Light theme"}>
      {light ? (
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
          <path d="M13.5 9.6A5.8 5.8 0 016.4 2.5a5.8 5.8 0 107.1 7.1z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

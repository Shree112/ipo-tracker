"use client";

import { BROKERS, type Broker } from "./BrokerLinks";

// Admin-only check for the "Apply through your broker" buttons: every way of
// opening a broker app from a web page, so they can be tried one by one on a
// real phone. Whichever opens the installed app becomes the default.
const play = (pkg: string) => encodeURIComponent(`https://play.google.com/store/apps/details?id=${pkg}`);
const SCHEME_GUESS: Record<string, string> = {
  Zerodha: "kite://",
  Groww: "groww://",
  Upstox: "upstox://",
  "Angel One": "angelone://",
};

function variants(b: Broker): { key: string; label: string; href: string; note: string }[] {
  const u = new URL(b.androidUrl);
  return [
    { key: "A", label: "Play Store launch", href: `market://launch?id=${b.androidPackage}`, note: "current default" },
    {
      key: "B",
      label: "App link, IPO page",
      href: `intent://${u.host}${u.pathname}#Intent;scheme=https;package=${b.androidPackage};S.browser_fallback_url=${play(b.androidPackage)};end`,
      note: "the old button",
    },
    {
      key: "C",
      label: "App link, home page",
      href: `intent://${u.host}/#Intent;scheme=https;package=${b.androidPackage};S.browser_fallback_url=${play(b.androidPackage)};end`,
      note: "",
    },
    { key: "D", label: "Plain web link", href: b.web, note: "opens the app only if Android hands it over" },
    { key: "E", label: "App scheme (guess)", href: SCHEME_GUESS[b.name] ?? "", note: "may do nothing" },
  ].filter((v) => v.href);
}

export default function BrokerTest() {
  return (
    <div style={{ display: "grid", gap: 14 }}>
      {BROKERS.map((b) => (
        <section key={b.name} className="card section">
          <div className="card-head">
            <h2>{b.name}</h2>
            <span className="sub">{b.androidPackage}</span>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {variants(b).map((v) => (
              <div key={v.key} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <a className="btn broker" href={v.href}>
                  {v.key}. {v.label}
                </a>
                {v.note ? <span className="xs muted">{v.note}</span> : null}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";

// "Apply through your broker". On a phone the button should open the broker's
// app, not its website. How that works differs by broker and phone:
//
// - iPhone: a normal https link opens the app only if the broker has told iOS
//   which of its web addresses the app handles ("universal links"). Groww does
//   for groww.in/ipo; Zerodha does for kite.zerodha.com/mobile/*. Upstox and
//   Angel One publish none, so on iPhone those open the App Store page.
// - Android: a market://launch link. The Play Store opens the broker's app
//   when it is installed and shows its store page (with "Install") when it
//   isn't. The earlier intent://<broker web address> links fell through to the
//   Play Store even with the app installed, because the apps don't claim those
//   exact web addresses. /admin/brokers lists other link styles to try on a phone.
// - Desktop: the broker's web IPO page.
//
// Nobody publishes per-issue links, so the app opens on its IPO section (or
// home screen); the member picks the issue there.
export type Platform = "ios" | "android" | "desktop";

export type Broker = {
  name: string;
  web: string;
  ios: string; // universal link, or the App Store page when there is none
  androidPackage: string; // Play Store id; also the fallback page
  androidUrl: string; // the https address handed to the app on Android
};

export const BROKERS: Broker[] = [
  {
    name: "Zerodha",
    web: "https://kite.zerodha.com/bids/ipo",
    ios: "https://kite.zerodha.com/mobile/bids/ipo",
    androidPackage: "com.zerodha.kite3",
    androidUrl: "https://kite.zerodha.com/bids/ipo",
  },
  {
    name: "Groww",
    web: "https://groww.in/ipo",
    ios: "https://groww.in/ipo",
    androidPackage: "com.nextbillion.groww",
    androidUrl: "https://groww.in/ipo",
  },
  {
    name: "Upstox",
    web: "https://upstox.com/ipo/",
    ios: "https://apps.apple.com/in/app/id1584953620",
    androidPackage: "in.upstox.app",
    androidUrl: "https://upstox.com/ipo/",
  },
  {
    name: "Angel One",
    web: "https://www.angelone.in/ipo",
    ios: "https://apps.apple.com/in/app/id1060530981",
    androidPackage: "com.msf.angelmobile",
    androidUrl: "https://www.angelone.in/ipo",
  },
];

export function detect(): Platform {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return "android";
  // iPadOS reports itself as a Mac; touch points give it away
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  return "desktop";
}

function href(b: Broker, p: Platform): string {
  if (p === "ios") return b.ios;
  if (p === "android") return `market://launch?id=${b.androidPackage}`;
  return b.web;
}

export default function BrokerLinks({ name, preApply }: { name: string; preApply: boolean }) {
  // Server render and first paint use the web links; the phone check runs after.
  const [platform, setPlatform] = useState<Platform>("desktop");
  useEffect(() => setPlatform(detect()), []);
  const mobile = platform !== "desktop";
  return (
    <section className="card section brokers" aria-label="Apply through your broker">
      <div className="card-head" style={{ marginBottom: 10 }}>
        <h2>{preApply ? "Pre-apply through your broker" : "Apply through your broker"}</h2>
        <span className="sub">{mobile ? "opens the broker's app" : "opens the broker's IPO page"}</span>
      </div>
      <div className="broker-row">
        {BROKERS.map((b) => (
          <a
            key={b.name}
            className="btn broker"
            href={href(b, platform)}
            {...(mobile ? {} : { target: "_blank", rel: "noreferrer" })}
          >
            {b.name} <span aria-hidden>↗</span>
          </a>
        ))}
      </div>
      <p className="xs muted" style={{ marginTop: 10 }}>
        Find <b>{name}</b> in the broker&apos;s IPO list and enter your lots (individual bids can use the cut-off price).
        Then approve the UPI mandate in your UPI app - the bid isn&apos;t complete until you do. We never see or place your
        bid.
      </p>
    </section>
  );
}

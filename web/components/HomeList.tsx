"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import Sparkline from "./Sparkline";
import { Avatar, RadarBadge, StageBadge, StatusBadge } from "./Chips";
import type { Stage } from "@/lib/format";

export type HomeRow = {
  id: number;
  slug: string;
  name: string;
  stage: Stage;
  group: "open" | "upcoming" | "awaiting" | "listed";
  radar: boolean;
  sticky: boolean;
  status: string;
  gmp: string;
  gmpSub: string;
  gmpTone: "" | "warn";
  spark: number[];
  listingGain: string | null;
  listingUp: boolean;
  size: string;
  sizeSub: string;
  sub: string;
  subSub: string;
  dateLabel: string;
  date: string;
  window: string;
};

const TABS: { key: "radar" | "open" | "upcoming" | "awaiting" | "listed" | "all"; label: string }[] = [
  { key: "radar", label: "On radar" },
  { key: "open", label: "Open" },
  { key: "upcoming", label: "Upcoming" },
  { key: "awaiting", label: "Awaiting listing" },
  { key: "listed", label: "Listed" },
  { key: "all", label: "All" },
];

function Row({ r }: { r: HomeRow }) {
  return (
    <Link href={`/issue/${r.slug}`} className="list-row">
      <div className="co">
        <Avatar name={r.name} />
        <div className="co-text">
          <div className="co-name">{r.name}</div>
          <div className="co-meta">
            <StageBadge stage={r.stage} />
            {r.radar ? <RadarBadge sticky={r.sticky} /> : null}
            <StatusBadge status={r.status} />
          </div>
        </div>
      </div>
      {r.listingGain !== null ? (
        <div data-label="Listing gain">
          <div className={`cell-value ${r.listingUp ? "up" : "down"}`}>{r.listingGain}</div>
          <div className="cell-sub">at the open</div>
        </div>
      ) : (
        <div className="gmp-cell" data-label="GMP">
          <div>
            <div className="cell-value" style={{ color: r.gmpTone === "warn" ? "var(--warn)" : undefined }}>{r.gmp}</div>
            <div className="cell-sub">{r.gmpSub}</div>
          </div>
          <Sparkline values={r.spark} />
        </div>
      )}
      <div data-label="Issue size">
        <div className="cell-value">{r.size}</div>
        <div className="cell-sub">{r.sizeSub}</div>
      </div>
      <div data-label="Subscribed">
        <div className="cell-value">{r.sub}</div>
        <div className="cell-sub">{r.subSub}</div>
      </div>
      <div data-label={r.dateLabel}>
        <div className="cell-value">{r.date}</div>
        <div className="cell-sub">{r.window}</div>
      </div>
      <svg className="chev" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}

export default function HomeList({ rows }: { rows: HomeRow[] }) {
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    for (const r of rows) {
      c[r.group] = (c[r.group] ?? 0) + 1;
      if (r.radar) c.radar = (c.radar ?? 0) + 1;
    }
    return c;
  }, [rows]);
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>(counts.radar ? "radar" : counts.open ? "open" : "all");

  const shown = rows.filter((r) =>
    tab === "all" ? true : tab === "radar" ? r.radar : r.group === tab,
  );

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Filter IPOs">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}
            <span className="count">{counts[t.key] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="list">
        <div className="list-head" aria-hidden>
          <span>Company</span>
          <span>{tab === "listed" ? "Listing gain" : "GMP · trend"}</span>
          <span>Issue size</span>
          <span>Subscribed</span>
          <span>Key date</span>
          <span />
        </div>
        {shown.length ? shown.map((r) => <Row key={r.id} r={r} />) : <div className="empty">Nothing here right now.</div>}
      </div>
    </>
  );
}

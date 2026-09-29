"use client";

import { useState } from "react";

// A small 30-day bar chart for the dashboard: one series, so no legend (the
// card title names it); hover or focus a bar for the exact value.
export default function DayBars({ series, unit }: { series: { day: string; n: number }[]; unit: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = 120;
  const max = Math.max(1, ...series.map((s) => s.n));
  const bw = W / Math.max(1, series.length);
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" });
  const h = hover !== null ? series[hover] : null;
  return (
    <div className="chart daybars">
      <svg viewBox={`0 0 ${W} ${H + 18}`} width="100%" role="img" aria-label={`Last ${series.length} days, ${unit}`} onPointerLeave={() => setHover(null)}>
        <line x1={0} x2={W} y1={H} y2={H} stroke="var(--axis)" />
        {series.map((s, k) => {
          const bh = s.n ? Math.max(3, (s.n / max) * (H - 8)) : 0;
          return (
            <g key={s.day} onPointerEnter={() => setHover(k)}>
              <rect x={k * bw} y={0} width={bw} height={H} fill="transparent" />
              {bh ? (
                <path
                  d={`M${k * bw + 1},${H} v${-(bh - 4)} q0,-4 4,-4 h${Math.max(0, bw - 10)} q4,0 4,4 v${bh - 4} z`}
                  fill="var(--series-1)"
                  opacity={hover === null || hover === k ? 1 : 0.45}
                />
              ) : null}
            </g>
          );
        })}
        <text x={0} y={H + 14} fontSize="10" fill="var(--muted)">{series[0] ? fmt(series[0].day) : ""}</text>
        <text x={W} y={H + 14} fontSize="10" fill="var(--muted)" textAnchor="end">{series.length ? "today" : ""}</text>
        <text x={W} y={10} fontSize="10" fill="var(--muted)" textAnchor="end">max {max}</text>
      </svg>
      {h ? (
        <div className="tooltip" style={{ left: `${Math.min(85, Math.max(15, ((hover! + 0.5) / series.length) * 100))}%`, top: -8 }}>
          <div className="t">{fmt(h.day)}</div>
          <div className="row">
            <b>{h.n}</b> <span className="muted">{unit}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

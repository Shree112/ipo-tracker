"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type Pt = { x: number; y: number; name: string; date: string; slug: string };

const H = 380;
const PAD = { l: 48, r: 16, t: 16, b: 40 };

function niceStep(range: number): number {
  const raw = range / 5;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n >= 5 ? 10 : n >= 2 ? 5 : n >= 1 ? 2 : 1) * mag;
}

// Day-before GMP (x) against the actual listing-day gain at the open (y), one
// dot per IPO. The diagonal is where GMP would have been exactly right: dots
// below it listed worse than the grey market expected.
export default function TrackScatter({ points }: { points: Pt[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(760);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const g = useMemo(() => {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const lo = Math.min(-10, ...xs, ...ys);
    const hi = Math.max(20, ...xs, ...ys);
    const step = niceStep(hi - lo);
    const v0 = Math.floor(lo / step) * step;
    const v1 = Math.ceil(hi / step) * step;
    const x = (v: number) => PAD.l + ((v - v0) / (v1 - v0)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - v0) / (v1 - v0)) * (H - PAD.t - PAD.b);
    const ticks: number[] = [];
    for (let v = v0; v <= v1 + 1e-9; v += step) ticks.push(Math.round(v));
    return { x, y, ticks, v0, v1 };
  }, [points, W]);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const py = ((e.clientY - box.top) / box.height) * H;
    let best = -1;
    let bestD = 18 * 18; // hit radius well beyond the 4px dot
    points.forEach((p, k) => {
      const d = (g.x(p.x) - px) ** 2 + (g.y(p.y) - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    setHover(best >= 0 ? best : null);
  };
  const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowRight") setHover((h) => Math.min(points.length - 1, (h ?? -1) + 1));
    if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? points.length) - 1));
    if (e.key === "Escape") setHover(null);
  };

  const h = hover !== null ? points[hover] : null;
  const fmt = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;

  return (
    <div className="chart" ref={ref}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={`${points.length} IPOs: GMP the day before opening against the listing-day gain. The table below lists the recent ones.`}
        tabIndex={0}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        {g.ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={g.y(v)} y2={g.y(v)} stroke={v === 0 ? "var(--axis)" : "var(--grid)"} />
            <line x1={g.x(v)} x2={g.x(v)} y1={PAD.t} y2={H - PAD.b} stroke={v === 0 ? "var(--axis)" : "var(--grid)"} />
            <text x={PAD.l - 8} y={g.y(v) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
              {v}%
            </text>
            <text x={g.x(v)} y={H - PAD.b + 16} textAnchor="middle" fontSize="11" fill="var(--muted)">
              {v}%
            </text>
          </g>
        ))}
        <text x={W - PAD.r} y={H - 4} textAnchor="end" fontSize="11" fill="var(--ink-3)">
          GMP the day before opening →
        </text>
        <text x={PAD.l + 6} y={PAD.t + 12} fontSize="11" fill="var(--ink-3)">
          ↑ Gain at the listing-day open
        </text>

        {/* where GMP would have been exactly right */}
        <line x1={g.x(g.v0)} y1={g.y(g.v0)} x2={g.x(g.v1)} y2={g.y(g.v1)} stroke="var(--ink-4)" strokeWidth={1} />
        <text
          x={g.x(g.v1) - 6}
          y={g.y(g.v1) + 16}
          textAnchor="end"
          fontSize="11"
          fill="var(--ink-3)"
        >
          GMP spot on
        </text>

        {points.map((p, k) => (
          <circle
            key={p.slug + k}
            cx={g.x(p.x)}
            cy={g.y(p.y)}
            r={hover === k ? 6 : 4}
            fill="var(--series-1)"
            fillOpacity={hover === null || hover === k ? 0.85 : 0.35}
            stroke="var(--chart-surface)"
            strokeWidth={2}
          />
        ))}
        <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} fill="transparent" />
      </svg>
      {h ? (
        <div
          className="tooltip"
          style={{ left: `${Math.min(80, Math.max(20, (g.x(h.x) / W) * 100))}%`, top: Math.max(0, g.y(h.y) - 86) }}
        >
          <div className="t">
            {h.name} · listed {h.date}
          </div>
          <div className="row">
            <span className="muted">GMP day before</span> <b>{fmt(h.x)}</b>
          </div>
          <div className="row">
            <span className="muted">Opened at</span> <b className={h.y >= 0 ? "up" : "down"}>{fmt(h.y)}</b>
          </div>
        </div>
      ) : null}
    </div>
  );
}

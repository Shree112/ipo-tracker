"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type Series = {
  key: string;
  label: string;
  colorVar: string; // e.g. "--series-1"
  points: { t: number; v: number; amt: number }[];
};

type Props = {
  series: Series[];
  windowStart: number | null; // ms, open date 00:00 IST
  windowEnd: number | null; // ms, close date 24:00 IST
  threshold: number | null; // the viewer's GMP alert, drawn as a line
};

const H = 250;
const PAD = { l: 40, r: 74, t: 14, b: 30 };

const dayFmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" });
const tsFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function niceStep(range: number): number {
  const raw = range / 4;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n >= 5 ? 10 : n >= 2 ? 5 : n >= 1 ? 2 : 1) * mag;
}

export default function GmpChart({ series, windowStart, windowEnd, threshold }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Draw at the container's real pixel width so text stays 11-12px on a phone
  // instead of being scaled down with the whole viewBox.
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setW(Math.max(300, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    const all = series.flatMap((s) => s.points);
    const ts = all.map((p) => p.t);
    let t0 = Math.min(...ts, windowStart ?? Infinity);
    let t1 = Math.max(...ts, windowEnd ?? -Infinity);
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
    if (t1 - t0 < 86_400_000) {
      t0 -= 43_200_000;
      t1 += 43_200_000;
    }
    const vs = all.map((p) => p.v);
    const vMax = Math.max(...vs, threshold ?? -Infinity);
    const vMin = Math.min(...vs, 0);
    const step = niceStep(vMax - vMin);
    const y0 = Math.floor(vMin / step) * step;
    const y1 = Math.ceil((vMax * 1.08) / step) * step;
    const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);
    const yTicks: number[] = [];
    for (let v = y0; v <= y1 + 1e-9; v += step) yTicks.push(Math.round(v * 100) / 100);
    // one tick per day, thinned to at most 7
    const dayMs = 86_400_000;
    const istOffset = 5.5 * 3_600_000;
    const firstDay = Math.ceil((t0 + istOffset) / dayMs) * dayMs - istOffset;
    const days: number[] = [];
    for (let d = firstDay; d <= t1; d += dayMs) days.push(d);
    const every = Math.max(1, Math.ceil(days.length / Math.max(3, Math.floor(W / 95))));
    const xTicks = days.filter((_, k) => k % every === 0);
    // unique timestamps for the crosshair
    const stops = Array.from(new Set(ts)).sort((a, b) => a - b);
    return { x, y, y0, y1, yTicks, xTicks, stops, t0, t1 };
  }, [series, windowStart, windowEnd, threshold, W]);

  if (!geo) return <div ref={ref}><p className="muted small">No GMP readings yet.</p></div>;
  const { x, y, yTicks, xTicks, stops } = geo;

  const valueAt = (s: Series, t: number) => {
    let best: Series["points"][number] | null = null;
    for (const p of s.points) if (p.t <= t && (!best || p.t > best.t)) best = p;
    return best;
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - svg.left) / svg.width) * W;
    let k = 0;
    let bestD = Infinity;
    stops.forEach((t, idx) => {
      const d = Math.abs(x(t) - px);
      if (d < bestD) {
        bestD = d;
        k = idx;
      }
    });
    setHover(k);
  };

  const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? stops.length) - 1));
    if (e.key === "ArrowRight") setHover((h) => Math.min(stops.length - 1, (h ?? -1) + 1));
    if (e.key === "Escape") setHover(null);
  };

  const ends = series
    .filter((s) => s.points.length)
    .map((s) => ({ s, p: s.points[s.points.length - 1] }));
  const endsSeparate =
    ends.length < 2 || Math.abs(y(ends[0].p.v) - y(ends[1].p.v)) >= 14;

  const ht = hover !== null ? stops[hover] : null;

  return (
    <div>
      {series.length > 1 ? (
        <div className="legend" aria-hidden>
          {series.map((s) => (
            <span key={s.key}>
              <span className="key" style={{ background: `var(${s.colorVar})` }} />
              {s.label}
            </span>
          ))}
        </div>
      ) : null}
      <div className="chart" ref={ref}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          role="img"
          aria-label="GMP history as a percentage of the upper price band"
          tabIndex={0}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
        >
          {/* subscription window */}
          {windowStart !== null && windowEnd !== null ? (
            <g>
              <rect
                x={x(windowStart)}
                y={PAD.t}
                width={Math.max(0, x(windowEnd) - x(windowStart))}
                height={H - PAD.t - PAD.b}
                fill="var(--accent)"
                opacity={0.07}
              />
              <text x={x(windowStart) + 6} y={PAD.t + 12} fontSize="11" fill="var(--ink-3)">
                open for bids
              </text>
            </g>
          ) : null}

          {/* grid + y axis */}
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth={1} />
              <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--muted)" style={{ fontVariantNumeric: "tabular-nums" }}>
                {v}%
              </text>
            </g>
          ))}

          {/* the viewer's GMP alert */}
          {threshold !== null ? (
            <g>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(threshold)} y2={y(threshold)} stroke="var(--warn)" strokeWidth={1} />
              <text x={W - PAD.r + 6} y={y(threshold) + 4} fontSize="11" fill="var(--ink-3)">
                {threshold}% alert
              </text>
            </g>
          ) : null}

          {/* x ticks */}
          {xTicks.map((t) => (
            <text key={t} x={x(t)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--muted)">
              {dayFmt.format(t)}
            </text>
          ))}

          {/* series */}
          {series.map((s) =>
            s.points.length ? (
              <g key={s.key}>
                <polyline
                  fill="none"
                  stroke={`var(${s.colorVar})`}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  points={s.points.map((p) => `${x(p.t)},${y(p.v)}`).join(" ")}
                />
                {(() => {
                  const p = s.points[s.points.length - 1];
                  return (
                    <circle cx={x(p.t)} cy={y(p.v)} r={4} fill={`var(${s.colorVar})`} stroke="var(--chart-surface)" strokeWidth={2} />
                  );
                })()}
              </g>
            ) : null,
          )}

          {/* end labels, only when they don't collide */}
          {endsSeparate
            ? ends.map(({ s, p }) => (
                <text key={s.key} x={x(p.t) + 8} y={y(p.v) + 4} fontSize="12" fontWeight={700} fill="var(--ink)">
                  {p.v.toFixed(1)}%
                </text>
              ))
            : null}

          {/* crosshair */}
          {ht !== null ? (
            <g pointerEvents="none">
              <line x1={x(ht)} x2={x(ht)} y1={PAD.t} y2={H - PAD.b} stroke="var(--ink-3)" strokeWidth={1} />
              {series.map((s) => {
                const p = valueAt(s, ht);
                return p ? (
                  <circle key={s.key} cx={x(p.t)} cy={y(p.v)} r={4} fill={`var(${s.colorVar})`} stroke="var(--chart-surface)" strokeWidth={2} />
                ) : null;
              })}
            </g>
          ) : null}

          {/* generous hit area */}
          <rect x={PAD.l} y={0} width={W - PAD.l - PAD.r} height={H} fill="transparent" />
        </svg>

        {ht !== null ? (
          <div
            className="tooltip"
            style={{
              left: `${Math.min(82, Math.max(18, (x(ht) / W) * 100))}%`,
              top: 4,
            }}
          >
            <div className="t">{tsFmt.format(ht)}</div>
            {series.map((s) => {
              const p = valueAt(s, ht);
              return (
                <div className="row" key={s.key}>
                  <span className="key" style={{ background: `var(${s.colorVar})` }} />
                  <b>{p ? `${p.v.toFixed(1)}%` : "–"}</b>
                  <span className="muted">{p ? `₹${p.amt}` : ""} {s.label}</span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

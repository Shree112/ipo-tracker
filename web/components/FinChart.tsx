"use client";

import { useState } from "react";

export type FinSeries = {
  metric: string;
  title: string;
  pts: { label: string; full: string; v: number; part: boolean }[]; // oldest first
};

const cr = (v: number) => v.toLocaleString("en-IN", { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 1 });

// One year-on-year bar chart with a picker for the line item, so the section
// stays one chart tall on a phone. Bars run one hue from faint (oldest) to
// full (latest), so the eye lands on the newest year; losses use the "down"
// colour and hang below the zero line.
export default function FinChart({ series, note }: { series: FinSeries[]; note: string | null }) {
  const [pick, setPick] = useState(series[0]?.metric ?? "");
  const s = series.find((x) => x.metric === pick) ?? series[0];
  if (!s) return null;

  const vals = s.pts.map((x) => x.v);
  const hi = Math.max(0, ...vals);
  const lo = Math.min(0, ...vals);
  const span = hi - lo || 1;
  const zero = (hi / span) * 100; // % from the top of the plot
  const full = s.pts.filter((x) => !x.part);
  const [prev, last] = full.slice(-2);
  const change = prev && last && prev.v > 0 ? ((last.v - prev.v) / prev.v) * 100 : null;
  const n = s.pts.length;

  return (
    <div className="fin-chart">
      <div className="fin-chart-head">
        <label className="fin-pick">
          <span className="sr-only">Line item</span>
          <select className="input" value={s.metric} onChange={(e) => setPick(e.target.value)}>
            {series.map((x) => (
              <option key={x.metric} value={x.metric}>
                {x.title}
              </option>
            ))}
          </select>
        </label>
        {change !== null ? (
          <span className={`fin-change ${change >= 0 ? "up" : "down"}`}>
            {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(Math.abs(change) >= 10 ? 0 : 1)}%
            <span className="muted"> vs {prev.label}</span>
          </span>
        ) : null}
      </div>

      <div className={`fin-bars${lo < 0 ? " has-neg" : ""}`} role="img" aria-label={`${s.title}: ${s.pts.map((x) => `${x.label} ₹${cr(x.v)} Cr`).join(", ")}`}>
        {s.pts.map((x, i) => {
          const h = (Math.abs(x.v) / span) * 100;
          const top = x.v >= 0 ? zero - h : zero;
          // 40% for the oldest up to 100% for the latest
          const strength = n === 1 ? 100 : Math.round(40 + (60 * i) / (n - 1));
          const base = x.v < 0 ? "var(--down)" : "var(--accent)";
          return (
            <div key={x.full} className="fin-col" title={`${x.full}: ₹${cr(x.v)} Cr`}>
              <div className="fin-plot">
                <div className="fin-zero" style={{ top: `${zero}%` }} />
                <div
                  className={`fin-bar${x.v < 0 ? " neg" : ""}`}
                  style={{
                    top: `${top}%`,
                    height: `max(${h}%, 2px)`,
                    background: `color-mix(in srgb, ${base} ${strength}%, var(--surface))`,
                  }}
                >
                  <span className={`fin-val${x.v < 0 ? " down" : ""}`}>{x.v < 0 ? `−${cr(-x.v)}` : cr(x.v)}</span>
                </div>
              </div>
              <span className={`fin-per${i === n - 1 ? " latest" : ""}`}>{x.label}</span>
            </div>
          );
        })}
      </div>
      {note ? <p className="xs muted fin-note">{note}</p> : null}
    </div>
  );
}

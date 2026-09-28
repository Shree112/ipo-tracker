// A 20-reading GMP trend for list rows. One series, so no legend; the value
// beside it carries the number, the line only carries the shape.
export default function Sparkline({ values, width = 72, height = 24 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden />;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const x = (i: number) => 2 + (i / (values.length - 1)) * (width - 6);
  const y = (v: number) => 3 + (1 - (v - min) / (max - min || 1)) * (height - 6);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = values[values.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden style={{ flex: "none" }}>
      <polyline className="draw" pathLength={1} points={pts} fill="none" stroke="var(--series-1)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(values.length - 1)} cy={y(last)} r={2.5} fill="var(--series-1)" />
    </svg>
  );
}

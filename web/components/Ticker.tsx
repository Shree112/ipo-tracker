// A slow, looping strip of live GMPs across the top of the home page. The
// list is repeated once so the loop is seamless; hovering pauses it.
export type TickerItem = { name: string; value: string; tone: "up" | "down" | "" };

export default function Ticker({ items }: { items: TickerItem[] }) {
  if (items.length < 3) return null;
  const row = (dup: boolean) =>
    items.map((t, k) => (
      <span className="ticker-item" key={`${dup ? "b" : "a"}${k}`} aria-hidden={dup || undefined}>
        <span className="nm">{t.name}</span>
        <span className={`v ${t.tone}`}>{t.value}</span>
      </span>
    ));
  return (
    <div className="ticker" aria-label="Live grey market premiums">
      <div className="ticker-track">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}

// "Apply through your broker": each broker's IPO page. Brokers don't publish
// stable per-issue links, so these open the IPO section (Zerodha's goes straight
// to Kite's IPO bids), where the issue is listed while it's open. The bid is
// finished by approving the UPI mandate in the member's own UPI app.
const BROKERS: { name: string; url: string }[] = [
  { name: "Zerodha", url: "https://kite.zerodha.com/bids/ipo" },
  { name: "Groww", url: "https://groww.in/ipo" },
  { name: "Upstox", url: "https://upstox.com/ipo/" },
  { name: "Angel One", url: "https://www.angelone.in/ipo" },
];

export default function BrokerLinks({ name, preApply }: { name: string; preApply: boolean }) {
  return (
    <section className="card section brokers" aria-label="Apply through your broker">
      <div className="card-head" style={{ marginBottom: 10 }}>
        <h2>{preApply ? "Pre-apply through your broker" : "Apply through your broker"}</h2>
        <span className="sub">opens the broker&apos;s IPO page</span>
      </div>
      <div className="broker-row">
        {BROKERS.map((b) => (
          <a key={b.name} className="btn broker" href={b.url} target="_blank" rel="noreferrer">
            {b.name} <span aria-hidden>↗</span>
          </a>
        ))}
      </div>
      <p className="xs muted" style={{ marginTop: 10 }}>
        Find <b>{name}</b> in the list and enter your lots (individual bids can use the cut-off price). Then approve the
        UPI mandate in your UPI app - the bid isn&apos;t complete until you do. We never see or place your bid.
      </p>
    </section>
  );
}

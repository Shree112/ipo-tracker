import type { IssueDetail } from "@/lib/queries";

// "What the company does", in a few lines. Prefers the short profile written
// by the summariser (our own words); until that exists, shows the opening of
// the issue page's description with a credit and a link to the rest.
function firstSentences(text: string, max = 2): string {
  const para = text.split(/\n\n/)[0] ?? "";
  const bits = para.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [para];
  const out = bits.slice(0, max).join("").trim();
  return out.length > 360 ? `${out.slice(0, 357).trim()}…` : out;
}

export default function AboutCompany({
  detail,
  shortName,
  sourceUrl,
}: {
  detail: IssueDetail | null;
  shortName: string;
  sourceUrl: string | null;
}) {
  const s = detail?.about_summary;
  const raw = detail?.about;
  if (!s && !raw) return null;
  return (
    <section className="card section about" id="about">
      <div className="eyebrow">What {shortName} does</div>
      {s ? (
        <>
          <p className="about-line">{s.one_liner}</p>
          <ul className="chatter-points">
            {s.points.map((p, k) => (
              <li key={k}>{p}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="about-line small-serif">{firstSentences(raw!)}</p>
      )}
      <p className="xs muted" style={{ marginTop: 12 }}>
        {s ? "Summarised from the offer details by an open-source AI model; check the prospectus for specifics. " : "From the issue description. "}
        {sourceUrl ? (
          <a className="link" href={sourceUrl} target="_blank" rel="noreferrer">
            Full description ↗
          </a>
        ) : null}
      </p>
    </section>
  );
}

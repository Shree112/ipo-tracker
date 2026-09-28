"use client";

import { useOptimistic, useTransition } from "react";
import { markAllotment } from "@/app/(site)/issue/[slug]/actions";

type Result = "allotted" | "not_allotted" | null;

// For an issue the member applied to: when allotment happens, where to check
// it (the registrar's own page - it needs your PAN and a CAPTCHA, so it can't
// be done from here), and one tap to record the result.
export default function AllotmentCard({
  slug,
  result,
  allotmentDate,
  allotmentLabel,
  registrar,
  registrarLabel,
  registrarUrl,
  bseUrl,
  out,
}: {
  slug: string;
  result: Result;
  allotmentDate: string | null;
  allotmentLabel: string;
  registrar: string | null;
  registrarLabel: string;
  registrarUrl: string;
  bseUrl: string | null;
  out: boolean;
}) {
  const [state, setState] = useOptimistic<Result, Result>(result, (_, next) => next);
  const [pending, start] = useTransition();
  const save = (r: "allotted" | "not_allotted" | "unknown") => {
    const fd = new FormData();
    fd.set("slug", slug);
    fd.set("result", r);
    start(async () => {
      setState(r === "unknown" ? null : r);
      await markAllotment(fd);
    });
  };

  return (
    <section className="card section allot" id="allotment">
      <div className="grow">
        <div className="eyebrow">Allotment</div>
        {state ? (
          <p className="allot-head">
            {state === "allotted" ? "You got shares." : "Not allotted this time."}
            {pending ? <span className="muted small"> · saving…</span> : null}
          </p>
        ) : out ? (
          <p className="allot-head">Allotment is out. Check yours in 30 seconds.</p>
        ) : (
          <p className="allot-head">Allotment on {allotmentLabel}.</p>
        )}
        <p className="small muted" style={{ marginTop: 4 }}>
          {state
            ? state === "allotted"
              ? "You'll get a note before the market opens on listing day."
              : "Nothing more to do for this one."
            : out
              ? `On the ${registrarLabel} page, pick this company, choose PAN and enter yours. Then mark it here: tap Got shares and we'll email you on listing morning.`
              : `Registrar: ${registrar ?? "not listed yet"}. We'll email you that evening with the link.`}
        </p>
      </div>
      <div className="allot-actions">
        {state ? (
          <button className="btn ghost" type="button" onClick={() => save("unknown")}>
            Change
          </button>
        ) : (
          <>
            {out || !allotmentDate ? (
              <>
                <a className="btn primary" href={registrarUrl} target="_blank" rel="noreferrer">
                  Check on {registrarLabel} ↗
                </a>
                {bseUrl ? (
                  <a className="btn" href={bseUrl} target="_blank" rel="noreferrer">
                    BSE ↗
                  </a>
                ) : null}
              </>
            ) : null}
            <button className="btn" type="button" onClick={() => save("allotted")}>
              Got shares
            </button>
            <button className="btn" type="button" onClick={() => save("not_allotted")}>
              Not allotted
            </button>
          </>
        )}
      </div>
    </section>
  );
}

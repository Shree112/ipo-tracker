import type { Stage } from "@/lib/format";

export function StageChip({ stage }: { stage: Stage }) {
  const tone =
    stage.key === "lastday" ? "amber" : stage.key === "open" || stage.key === "tomorrow" ? "accent" : "";
  return <span className={`chip ${tone}`}>{stage.label}</span>;
}

export function StatusChip({ status }: { status: string }) {
  if (status === "applied")
    return (
      <span className="chip accent">
        <span className="dot" aria-hidden /> Applied
      </span>
    );
  if (status === "skipped")
    return (
      <span className="chip">
        <span className="dot" aria-hidden /> Skipped
      </span>
    );
  if (status === "notified")
    return (
      <span className="chip amber">
        <span className="dot" aria-hidden /> In digest
      </span>
    );
  return null;
}

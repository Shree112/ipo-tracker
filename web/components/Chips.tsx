import type { Stage } from "@/lib/format";

export function StageBadge({ stage }: { stage: Stage }) {
  const tone =
    stage.key === "lastday" ? "amber" : stage.key === "open" ? "green" : stage.key === "tomorrow" ? "blue" : "";
  return <span className={`badge ${tone}`}>{stage.label}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  if (status === "applied") return <span className="badge green">✓ Applied</span>;
  if (status === "skipped") return <span className="badge">Skipped</span>;
  return null;
}

export function RadarBadge({ kept, reasons }: { kept: boolean; reasons?: string[] }) {
  const title = kept
    ? "No longer matches your alerts; it stays until you mark it applied or skipped"
    : reasons?.length
      ? `Matches your alerts: ${reasons.join(", ")}`
      : "Matches your alerts";
  return (
    <span className={`badge ${kept ? "amber" : "green"}`} title={title}>
      <span className="dot" aria-hidden /> {kept ? "On radar · kept" : "On radar"}
    </span>
  );
}

export function Avatar({ name, size }: { name: string; size?: "lg" }) {
  const letter = name.replace(/[^A-Za-z0-9]/g, "").charAt(0).toUpperCase() || "?";
  return (
    <span className={`avatar ${size === "lg" ? "lg" : ""}`} aria-hidden>
      {letter}
    </span>
  );
}

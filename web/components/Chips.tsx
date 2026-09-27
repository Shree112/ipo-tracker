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

export function RadarBadge({ sticky }: { sticky: boolean }) {
  return (
    <span className={`badge ${sticky ? "amber" : "green"}`} title={sticky ? "GMP fell back below 10% after crossing it" : "GMP above 10% from the day before opening"}>
      <span className="dot" aria-hidden /> {sticky ? "On radar · fell below 10%" : "On radar"}
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

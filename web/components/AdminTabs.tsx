import Link from "next/link";

export default function AdminTabs({ current, pending }: { current: "dashboard" | "members"; pending: number }) {
  return (
    <div className="tabs admin-tabs" role="tablist" aria-label="Admin">
      <Link role="tab" aria-selected={current === "dashboard"} href="/admin/dashboard">
        Dashboard
      </Link>
      <Link role="tab" aria-selected={current === "members"} href="/admin">
        Members {pending ? <span className="count">{pending} waiting</span> : null}
      </Link>
    </div>
  );
}

// Formatting and date logic shared by every page. All "today" logic is IST:
// the market, the issue windows and the digest all run on Indian time.

export const IST = "Asia/Kolkata";

export function todayIST(): string {
  // YYYY-MM-DD in IST
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date());
}

export function toISODate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  // DATE columns arrive as midnight UTC Date objects; take the UTC calendar day.
  return d.toISOString().slice(0, 10);
}

function parse(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function addDays(iso: string, n: number): string {
  const d = parse(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
}

export function isWeekday(iso: string): boolean {
  const w = parse(iso).getUTCDay();
  return w !== 0 && w !== 6;
}

export function workdays(a: string, b: string): number {
  let n = 0;
  for (let d = a; d <= b; d = addDays(d, 1)) if (isWeekday(d)) n++;
  return n;
}

export function fmtDate(iso: string | null, withDay = false): string {
  if (!iso) return "–";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    ...(withDay ? { weekday: "short" } : {}),
  }).format(parse(iso));
}

export function fmtDateTime(ts: Date | string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ts));
}

export function fmtWhen(ts: Date | string, today: string): string {
  const d = new Date(ts);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(d);
  const time = new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return day === today ? `today ${time}` : fmtDateTime(d);
}

export function rupees(x: number | null | undefined, dp?: number): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "–";
  const d = dp ?? (Number.isInteger(x) ? 0 : 2);
  return `₹${x.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

export function crore(x: number | null | undefined): string {
  if (x === null || x === undefined) return "–";
  return `₹${x.toLocaleString("en-IN", { maximumFractionDigits: x >= 100 ? 0 : 1 })} Cr`;
}

export function pct(x: number | null | undefined, dp = 1): string {
  if (x === null || x === undefined) return "–";
  return `${x.toFixed(dp)}%`;
}

export function times(x: number | null | undefined): string {
  if (x === null || x === undefined) return "–";
  return `${x.toFixed(2)}×`;
}

export function band(lo: number | null, hi: number | null): string {
  if (lo && hi && lo !== hi) return `₹${lo.toLocaleString("en-IN")}–${hi.toLocaleString("en-IN")}`;
  return rupees(hi ?? lo);
}

export function sizeSplit(fresh: number | null, ofs: number | null): string {
  if (fresh === null && ofs === null) return "";
  const f = fresh ?? 0;
  const o = ofs ?? 0;
  if (o === 0 && f > 0) return "all fresh issue";
  if (f === 0 && o > 0) return "all offer for sale";
  const t = f + o;
  return `fresh ${Math.round((f / t) * 100)}% · OFS ${Math.round((o / t) * 100)}%`;
}

export type Stage =
  | { key: "upcoming"; label: string }
  | { key: "tomorrow"; label: string }
  | { key: "open"; label: string }
  | { key: "lastday"; label: string }
  | { key: "closed"; label: string }
  | { key: "listed"; label: string };

export function stageOf(
  open: string | null,
  close: string | null,
  listing: string | null,
  today: string,
): Stage {
  if (listing && today >= listing) return { key: "listed", label: `Listed ${fmtDate(listing)}` };
  if (!open || !close) return { key: "upcoming", label: "Dates awaited" };
  if (today < addDays(open, -1)) return { key: "upcoming", label: `Opens ${fmtDate(open)}` };
  if (today === addDays(open, -1)) return { key: "tomorrow", label: "Opens tomorrow" };
  if (today <= close) {
    const total = workdays(open, close);
    if (today === close) return { key: "lastday", label: "Last day" };
    let d = today;
    while (!isWeekday(d)) d = addDays(d, 1);
    const n = workdays(open, d);
    const suffix = d !== today ? ` · ${fmtDate(d, true).split(",")[0]}` : "";
    return n >= total
      ? { key: "lastday", label: `Last day${suffix}` }
      : { key: "open", label: `Day ${n} of ${total}${suffix}` };
  }
  if (listing && today >= listing) return { key: "listed", label: `Listed ${fmtDate(listing)}` };
  return { key: "closed", label: listing ? `Closed · lists ${fmtDate(listing)}` : "Closed" };
}

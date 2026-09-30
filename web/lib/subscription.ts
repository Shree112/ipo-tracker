import { revalidateTag } from "next/cache";
import { db, within } from "./db";

// Live subscription, fetched by the website itself.
//
// The Python pipeline on GitHub Actions also reads this report, but GitHub's
// scheduler drops most scheduled runs on a quiet repository, so on a closing
// day the numbers could sit hours old. Here it runs on demand (the Refresh
// button) and every 10 minutes during market hours (a Supabase cron calls
// /api/cron/subscription). One fetch of InvestorGain's live report covers every
// open issue. Same parsing and same table as sources/investorgain.py.

const HOST = "https://www.investorgain.com";
const REPORT_URL = process.env.IG_SUBSCRIPTION_URL || `${HOST}/report/ipo-subscription-live/333/`; // override only for tests
const SOURCE = "investorgain-subscription"; // scrape_run name, shared with the Python job
const COOLDOWN_S = 60; // one fetch serves everyone; taps inside this window reuse it

const CHUNK_RE = /self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g;
const NEXT_REDIRECT = /NEXT_REDIRECT;[a-z]+;(\/[^;"]+);30[1278]/;
const SUB_PATH = /\/subscription\/([a-z0-9-]+)\/(\d+)\//;
const COLS: Record<string, keyof SubRow> = {
  qib: "qib_x",
  shni: "shni_x",
  bhni: "bhni_x",
  nii: "nii_x",
  rii: "rii_x",
  total: "total_x",
  emp: "employee_x",
  employee: "employee_x",
  pe: "pe_ratio",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const IST_MS = 5.5 * 3_600_000;

export type SubRow = {
  ig_id: number;
  qib_x: number | null;
  shni_x: number | null;
  bhni_x: number | null;
  nii_x: number | null;
  rii_x: number | null;
  employee_x: number | null;
  total_x: number | null;
  pe_ratio: number | null;
  observed_at: Date | null;
  raw: Record<string, string>;
};

/** The Next.js server payload, rebuilt from its script chunks. */
export function flightPayload(html: string): string {
  const out: string[] = [];
  for (const m of html.matchAll(CHUNK_RE)) {
    try {
      out.push(JSON.parse(m[1]) as string);
    } catch {
      /* a chunk we can't decode isn't worth failing over */
    }
  }
  if (!out.length) throw new Error("no Next.js payload in the page (layout change or a block page)");
  return out.join("");
}

/** The JSON array that follows "key": in the payload. */
export function jsonArrayAfter(text: string, key: string): unknown[] | null {
  const i = text.indexOf(`"${key}":`);
  if (i < 0) return null;
  const start = text.indexOf("[", i);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let k = start; k < text.length; k++) {
    const c = text[k];
    if (inStr) {
      if (c === "\\") k++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        const val = JSON.parse(text.slice(start, k + 1));
        return Array.isArray(val) ? val : null;
      }
    }
  }
  return null;
}

const strip = (v: unknown) => String(v ?? "").replace(/<[^>]+>/g, " ");
const normKey = (k: string) => strip(k).toLowerCase().replace(/[^a-z]/g, "");

function cellNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const m = strip(v).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** "25th Sep 18:55" or "27-Sep 8:33" (IST, no year) -> the instant. */
export function siteTime(v: unknown, now = new Date()): Date | null {
  const m = strip(v).match(/(\d{1,2})(?:st|nd|rd|th)?[-\s]+([A-Za-z]{3,9})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  if (mon < 0) return null;
  const istNow = new Date(now.getTime() + IST_MS);
  for (const year of [istNow.getUTCFullYear(), istNow.getUTCFullYear() - 1]) {
    const t = Date.UTC(year, mon, Number(m[1]), Number(m[3]), Number(m[4])) - IST_MS;
    if (t <= now.getTime() + 2 * 86_400_000) return new Date(t);
  }
  return null;
}

/** One row per issue on the live report (SME rows included; they just won't match). */
export function parseSubscription(html: string, now = new Date()): SubRow[] {
  const rows = jsonArrayAfter(flightPayload(html), "reportTableData");
  if (!rows) throw new Error("reportTableData missing from the subscription report");
  const out: SubRow[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const m = JSON.stringify(row).match(SUB_PATH);
    if (!m) continue;
    const rec: SubRow = {
      ig_id: Number(m[2]),
      qib_x: null,
      shni_x: null,
      bhni_x: null,
      nii_x: null,
      rii_x: null,
      employee_x: null,
      total_x: null,
      pe_ratio: null,
      observed_at: null,
      raw: {},
    };
    for (const [k, v] of Object.entries(row)) {
      const nk = normKey(k);
      const col = COLS[nk];
      if (col) {
        (rec as Record<string, unknown>)[col] = cellNum(nk === "total" ? String(v).split(/<br/i)[0] : v);
        rec.raw[k] = strip(v).replace(/\s+/g, " ").trim();
      }
      if (nk === "total") rec.observed_at = siteTime(v, now); // "<b>0.51</b><br><small>25th Sep 18:55</small>"
    }
    if (rec.total_x === null && rec.rii_x === null) continue;
    out.push(rec);
  }
  return out;
}

async function fetchReport(): Promise<string> {
  const get = async (url: string) => {
    const r = await fetch(url, {
      headers: {
        "user-agent": process.env.SCRAPER_USER_AGENT || "ipo-tracker/0.1 (personal research project)",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-IN,en;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`InvestorGain answered ${r.status}`);
    return r.text();
  };
  let html = await get(REPORT_URL);
  // Next.js redirects arrive as a 200 with the target inside the payload
  const m = html.match(NEXT_REDIRECT);
  if (m && html.includes("__next_f") && `${HOST}${m[1]}`.replace(/\/$/, "") !== REPORT_URL.replace(/\/$/, "")) {
    html = await get(`${HOST}${m[1]}`);
  }
  return html;
}

export type RefreshResult = {
  status: "updated" | "unchanged" | "recent" | "error";
  written: number;
  matched: number;
  message?: string;
};

/** Fetch the live report and store any readings that moved. Skips the fetch
 *  when another one ran in the last minute (the numbers can't be staler than
 *  that). Always clears the page cache so the viewer sees what's stored. */
export async function refreshSubscription(trigger: "button" | "cron"): Promise<RefreshResult> {
  const sql = db();
  const [recent] = await within(
    sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM scrape_run
      WHERE source = ${SOURCE} AND started_at > now() - make_interval(secs => ${COOLDOWN_S})`,
    6000,
    "subscription cooldown",
  );
  if (recent.n > 0) {
    revalidateTag("issues");
    return { status: "recent", written: 0, matched: 0 };
  }
  const [run] = await within(
    sql<{ id: number }[]>`INSERT INTO scrape_run (source, message) VALUES (${SOURCE}, ${`web:${trigger}`}) RETURNING id`,
    6000,
    "subscription run",
  );
  let seen = 0;
  let written = 0;
  let matched = 0;
  try {
    const rows = parseSubscription(await fetchReport());
    seen = rows.length;
    const issues = await within(
      sql<{ id: number; investorgain_id: number }[]>`
        SELECT id, investorgain_id FROM issues WHERE investorgain_id = ANY(${rows.map((r) => r.ig_id)}::int[])`,
      6000,
      "subscription issues",
    );
    const issueOf = new Map(issues.map((r) => [Number(r.investorgain_id), Number(r.id)]));
    const fetchedAt = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    for (const s of rows) {
      const issueId = issueOf.get(s.ig_id);
      if (issueId === undefined) continue; // SME, or not on our calendar
      matched++;
      // One row per change: skip when the four headline numbers match the last reading.
      const res = await within(
        sql`
          WITH last AS (
            SELECT qib_x, nii_x, rii_x, total_x FROM subscription
            WHERE issue_id = ${issueId} AND source = 'investorgain' ORDER BY observed_at DESC LIMIT 1)
          INSERT INTO subscription (issue_id, observed_at, source, qib_x, nii_x, rii_x, employee_x, total_x, shni_x, bhni_x, raw)
          SELECT ${issueId}, ${s.observed_at ?? fetchedAt}, 'investorgain', ${s.qib_x}, ${s.nii_x}, ${s.rii_x},
                 ${s.employee_x}, ${s.total_x}, ${s.shni_x}, ${s.bhni_x}, ${sql.json({ ...s.raw, site_updated: null, via: "web" })}
          WHERE NOT EXISTS (
            SELECT 1 FROM last
            WHERE last.qib_x IS NOT DISTINCT FROM ${s.qib_x}::numeric AND last.nii_x IS NOT DISTINCT FROM ${s.nii_x}::numeric
              AND last.rii_x IS NOT DISTINCT FROM ${s.rii_x}::numeric AND last.total_x IS NOT DISTINCT FROM ${s.total_x}::numeric)
          ON CONFLICT (issue_id, source, observed_at) DO NOTHING`,
        6000,
        "subscription write",
      );
      written += res.count;
      if (s.pe_ratio !== null) {
        await within(sql`UPDATE issues SET pe_ratio = ${s.pe_ratio} WHERE id = ${issueId} AND pe_ratio IS DISTINCT FROM ${s.pe_ratio}::numeric`, 6000, "pe");
      }
    }
    await sql`
      UPDATE scrape_run SET finished_at = now(), status = ${matched ? "ok" : "empty"},
             rows_seen = ${seen}, rows_written = ${written},
             message = ${`web:${trigger}` + (matched ? "" : " - no mainboard issue on the report")}
      WHERE id = ${run.id}`.catch(() => undefined);
    revalidateTag("issues");
    return { status: written ? "updated" : "unchanged", written, matched };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sql`
      UPDATE scrape_run SET finished_at = now(), status = 'error', rows_seen = ${seen}, rows_written = ${written},
             message = ${`web:${trigger}: ${message}`.slice(0, 500)}
      WHERE id = ${run.id}`.catch(() => undefined);
    if (written) revalidateTag("issues");
    return { status: "error", written, matched, message };
  }
}

/** When the site last checked InvestorGain (any path: button, cron, Python). */
export async function lastSubscriptionCheck(): Promise<Date | null> {
  const [r] = await within(
    db()<{ at: Date | null }[]>`
      SELECT max(started_at) AS at FROM scrape_run WHERE source = ${SOURCE} AND status IN ('ok', 'empty')`,
    5000,
    "last check",
  ).catch(() => [{ at: null }]);
  return r?.at ?? null;
}

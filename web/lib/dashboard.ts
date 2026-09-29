import { db } from "./db";

// Everything the admin dashboard shows, in one parallel batch of small
// queries. Tables that arrive with later schema updates fall back to empty.

// postgres.js results are arrays with extra metadata; the fallbacks are plain arrays
const safe = <T,>(p: PromiseLike<T>, empty: unknown): Promise<T> => Promise.resolve(p).catch(() => empty as T);

export type Series = { day: string; n: number }[];

export async function dashboardData() {
  const sql = db();
  const [
    members,
    weekly,
    approveHours,
    presets,
    actives,
    dailyActive,
    digests,
    digestDaily,
    clicks,
    decisions,
    channels,
    picks,
    allot,
    sources,
    alerts,
    failures,
    chatter,
    rhpDocs,
  ] = await Promise.all([
    sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM app_users GROUP BY status`,
    sql<{ week: string; n: number }[]>`
      SELECT to_char(date_trunc('week', created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS week, count(*)::int AS n
      FROM app_users WHERE created_at > now() - interval '12 weeks' GROUP BY 1 ORDER BY 1`,
    sql<{ h: number | null }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM decided_at - created_at) / 3600)::float AS h
      FROM app_users WHERE status = 'approved' AND NOT is_admin AND decided_at IS NOT NULL`,
    safe(
      sql<{ preset: string; n: number }[]>`
        SELECT meta->>'preset' AS preset, count(DISTINCT user_id)::int AS n FROM app_event
        WHERE kind = 'preset' GROUP BY 1 ORDER BY 2 DESC`,
      [],
    ),
    safe(
      sql<{ d1: number; d7: number; d30: number }[]>`
        SELECT count(DISTINCT user_id) FILTER (WHERE day = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS d1,
               count(DISTINCT user_id) FILTER (WHERE day > (now() AT TIME ZONE 'Asia/Kolkata')::date - 7)::int AS d7,
               count(DISTINCT user_id)::int AS d30
        FROM app_visit WHERE day > (now() AT TIME ZONE 'Asia/Kolkata')::date - 30`,
      [{ d1: 0, d7: 0, d30: 0 }],
    ),
    safe(
      sql<Series>`
        SELECT to_char(d, 'YYYY-MM-DD') AS day, count(v.user_id)::int AS n
        FROM generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - 29, (now() AT TIME ZONE 'Asia/Kolkata')::date, '1 day') d
        LEFT JOIN app_visit v ON v.day = d::date GROUP BY d ORDER BY d`,
      [],
    ),
    sql<{ kind: string; n: number; people: number }[]>`
      SELECT kind, count(*)::int AS n, count(DISTINCT user_id)::int AS people FROM user_digest_run
      WHERE digest_date > (now() AT TIME ZONE 'Asia/Kolkata')::date - 30 GROUP BY kind`,
    sql<Series>`
      SELECT to_char(d, 'YYYY-MM-DD') AS day, count(r.user_id)::int AS n
      FROM generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - 29, (now() AT TIME ZONE 'Asia/Kolkata')::date, '1 day') d
      LEFT JOIN user_digest_run r ON r.digest_date = d::date GROUP BY d ORDER BY d`,
    safe(
      sql<{ kind: string; n: number }[]>`
        SELECT kind, count(*)::int AS n FROM app_event
        WHERE kind IN ('email_click', 'tg_click') AND at > now() - interval '30 days' GROUP BY kind`,
      [],
    ),
    safe(
      sql<{ what: string; source: string; n: number }[]>`
        SELECT COALESCE(meta->>'decision', meta->>'result') AS what, COALESCE(meta->>'source', 'site') AS source, count(*)::int AS n
        FROM app_event WHERE kind IN ('decision', 'allotment') AND at > now() - interval '30 days' GROUP BY 1, 2`,
      [],
    ),
    safe(
      sql<{ channel: string; paused: boolean; telegram: boolean; n: number }[]>`
        SELECT r.channel, r.paused, (u.telegram_chat_id IS NOT NULL) AS telegram, count(*)::int AS n
        FROM alert_rules r JOIN app_users u ON u.user_id = r.user_id AND u.status = 'approved'
        GROUP BY 1, 2, 3`,
      [],
    ),
    // IPOs that went out in at least one digest and have since listed
    sql<{ n: number; up: number | null; median: number | null }[]>`
      WITH picked AS (SELECT DISTINCT unnest(issue_ids) AS issue_id FROM user_digest_run WHERE kind = 'daily')
      SELECT count(*)::int AS n, 100.0 * avg((o.listing_gain_pct > 0)::int) AS up,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY o.listing_gain_pct) AS median
      FROM picked p JOIN listing_outcome o ON o.issue_id = p.issue_id AND o.price_basis = 'open'`,
    safe(
      sql<{ applied: number; allotted: number; not_allotted: number; gain: number | null }[]>`
        SELECT count(*)::int AS applied,
               count(*) FILTER (WHERE st.allotment = 'allotted')::int AS allotted,
               count(*) FILTER (WHERE st.allotment = 'not_allotted')::int AS not_allotted,
               avg(o.listing_gain_pct) FILTER (WHERE st.allotment = 'allotted') AS gain
        FROM user_issue_status st LEFT JOIN listing_outcome o ON o.issue_id = st.issue_id AND o.price_basis = 'open'
        WHERE st.status = 'applied'`,
      [{ applied: 0, allotted: 0, not_allotted: 0, gain: null }],
    ),
    sql<{ source: string; last_run: Date; last_status: string; last_ok: Date | null; runs: number; bad: number; msg: string | null }[]>`
      SELECT source,
             max(started_at) AS last_run,
             (array_agg(status ORDER BY started_at DESC))[1] AS last_status,
             max(started_at) FILTER (WHERE status = 'ok') AS last_ok,
             count(*) FILTER (WHERE started_at > now() - interval '24 hours')::int AS runs,
             count(*) FILTER (WHERE started_at > now() - interval '24 hours' AND status IN ('error', 'empty'))::int AS bad,
             (array_agg(message ORDER BY started_at DESC))[1] AS msg
      FROM scrape_run WHERE started_at > now() - interval '7 days'
      GROUP BY source ORDER BY source`,
    safe(sql<{ key: string; ok: boolean; since: Date; message: string | null }[]>`SELECT key, ok, since, message FROM health_alert ORDER BY ok, key`, []),
    safe(
      sql<{ n: number; last: string | null }[]>`
        SELECT count(*)::int AS n, (array_agg(meta->>'error' ORDER BY at DESC))[1] AS last FROM app_event
        WHERE kind = 'delivery_failed' AND at > now() - interval '7 days'`,
      [{ n: 0, last: null }],
    ),
    safe(
      sql<{ last: Date | null; summaries: number; profiles: number }[]>`
        SELECT (SELECT max(fetched_at) FROM issue_chatter) AS last,
               (SELECT count(*)::int FROM issue_chatter_summary WHERE summary IS NOT NULL) AS summaries,
               (SELECT count(*)::int FROM issue_detail WHERE about_summary IS NOT NULL) AS profiles`,
      [{ last: null, summaries: 0, profiles: 0 }],
    ),
    safe(sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM rhp_doc GROUP BY status`, []),
  ]);

  return {
    members, weekly, approveHours: approveHours[0]?.h ?? null, presets, actives: actives[0], dailyActive,
    digests, digestDaily, clicks, decisions, channels, picks: picks[0], allot: allot[0], sources, alerts,
    failures: failures[0], chatter: chatter[0], rhpDocs,
  };
}

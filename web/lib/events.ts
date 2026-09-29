import { after } from "next/server";
import { db, within } from "./db";

// Usage events for the admin dashboard. Written after the response has been
// sent (next/server `after`), so they never slow a page or a tap down, and a
// failed write is simply dropped - they're statistics, not records.

export type EventKind =
  | "email_click" // opened an issue page from a digest link
  | "tg_click" // ... from a Telegram button
  | "decision" // Applied / Skip / undo (meta.source: site | email)
  | "allotment" // Got shares / Not allotted
  | "preset" // starter alerts picked at first sign-in
  | "rhp_question"; // asked the prospectus

export function logEvent(kind: EventKind, userId: string | null, issueSlug?: string | null, meta?: Record<string, unknown>) {
  after(async () => {
    await within(db()`
      INSERT INTO app_event (kind, user_id, issue_id, meta)
      VALUES (${kind}, ${userId}::uuid,
              ${issueSlug ? db()`(SELECT id FROM issues WHERE slug = ${issueSlug})` : null},
              ${meta ? db().json(meta as never) : null})`, 5000, "event").catch(() => undefined);
  });
}

/** One row per member per day they open the site - daily/weekly actives. */
export function recordVisit(userId: string) {
  after(async () => {
    await within(
      db()`INSERT INTO app_visit (user_id, day) VALUES (${userId}::uuid, (now() AT TIME ZONE 'Asia/Kolkata')::date)
           ON CONFLICT DO NOTHING`,
      5000,
      "visit",
    ).catch(() => undefined);
  });
}

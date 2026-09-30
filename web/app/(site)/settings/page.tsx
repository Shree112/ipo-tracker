import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db, within } from "@/lib/db";
import { todayIST } from "@/lib/format";
import { describeRules, matchesFor, rulesFor, type Rules } from "@/lib/queries";
import { getViewer, requireApproved, viewerId } from "@/lib/viewer";
import { botUsername, newLinkCode, telegramReady } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const metadata = { title: "Alerts" };

const LIMITS: Record<string, [number, number]> = {
  gmp_pct_min: [-100, 1000],
  profit_per_lot_min: [0, 10_000_000],
  sub_total_min: [0, 10_000],
  sub_retail_min: [0, 10_000],
  sub_qib_min: [0, 10_000],
  anchor_mf_min: [0, 100],
  size_min_cr: [0, 1_000_000],
  size_max_cr: [0, 1_000_000],
};

function num(fd: FormData, key: string): number | null {
  const raw = String(fd.get(key) ?? "").replace(/[,₹%x\s]/gi, "");
  if (raw === "") return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  const [lo, hi] = LIMITS[key];
  return Math.min(hi, Math.max(lo, v));
}

async function save(fd: FormData) {
  "use server";
  const v = await getViewer();
  if (!v || v.status !== "approved") redirect("/signin");
  const emailTo = String(fd.get("email_to") ?? "").trim();
  const hour = Math.min(22, Math.max(5, Number(fd.get("digest_hour")) || 8));
  let sizeMin = num(fd, "size_min_cr");
  let sizeMax = num(fd, "size_max_cr");
  if (sizeMin !== null && sizeMax !== null && sizeMin > sizeMax) [sizeMin, sizeMax] = [sizeMax, sizeMin];
  const r = {
    gmp_pct_min: num(fd, "gmp_pct_min"),
    profit_per_lot_min: num(fd, "profit_per_lot_min"),
    sub_total_min: num(fd, "sub_total_min"),
    sub_retail_min: num(fd, "sub_retail_min"),
    sub_qib_min: num(fd, "sub_qib_min"),
    anchor_mf_min: num(fd, "anchor_mf_min"),
    size_min_cr: sizeMin,
    size_max_cr: sizeMax,
    match_mode: fd.get("match_mode") === "any" ? "any" : "all",
    digest_hour: hour,
    digest_days: fd.get("digest_days") === "weekdays" ? "weekdays" : "daily",
    start_at: fd.get("start_at") === "open" ? "open" : "t_minus_1",
    last_day_reminder: fd.get("last_day_reminder") === "on",
    email_to: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTo) && emailTo.toLowerCase() !== v.email.toLowerCase() ? emailTo : null,
    paused: fd.get("paused") === "on",
  };
  await db()`
    INSERT INTO alert_rules ${db()({ user_id: v.id, ...r })}
    ON CONFLICT (user_id) DO UPDATE SET
      gmp_pct_min = EXCLUDED.gmp_pct_min, profit_per_lot_min = EXCLUDED.profit_per_lot_min,
      sub_total_min = EXCLUDED.sub_total_min, sub_retail_min = EXCLUDED.sub_retail_min,
      sub_qib_min = EXCLUDED.sub_qib_min, anchor_mf_min = EXCLUDED.anchor_mf_min,
      size_min_cr = EXCLUDED.size_min_cr, size_max_cr = EXCLUDED.size_max_cr,
      match_mode = EXCLUDED.match_mode, digest_hour = EXCLUDED.digest_hour,
      digest_days = EXCLUDED.digest_days, start_at = EXCLUDED.start_at,
      last_day_reminder = EXCLUDED.last_day_reminder, email_to = EXCLUDED.email_to,
      paused = EXCLUDED.paused, updated_at = now()`;
  await db()`UPDATE alert_rules SET onboarded_at = COALESCE(onboarded_at, now()) WHERE user_id = ${v.id}::uuid`.catch(() => undefined);
  const wanted = String(fd.get("channel") ?? "email");
  if (["email", "telegram", "both"].includes(wanted)) {
    // Telegram only once this member has linked it; otherwise alerts would go nowhere
    await db()`
      UPDATE alert_rules SET channel = CASE
        WHEN ${wanted} = 'email' THEN 'email'
        WHEN (SELECT telegram_chat_id FROM app_users WHERE user_id = ${v.id}::uuid) IS NOT NULL THEN ${wanted}
        ELSE 'email' END
      WHERE user_id = ${v.id}::uuid`;
  }
  revalidatePath("/settings");
  redirect("/settings?saved=1");
}

async function connectTelegram() {
  "use server";
  const v = await getViewer();
  if (!v || v.status !== "approved" || !telegramReady()) redirect("/settings");
  const code = await newLinkCode(v.id);
  redirect(`https://t.me/${botUsername()}?start=${code}`);
}

async function disconnectTelegram() {
  "use server";
  const v = await getViewer();
  if (!v || v.status !== "approved") redirect("/signin");
  await db()`UPDATE app_users SET telegram_chat_id = NULL WHERE user_id = ${v.id}::uuid`;
  await db()`UPDATE alert_rules SET channel = 'email' WHERE user_id = ${v.id}::uuid`.catch(() => undefined);
  revalidatePath("/settings");
}

const hourLabel = (h: number) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? "am" : "pm"}`;
const val = (x: number | null | undefined) => (x === null || x === undefined ? "" : String(x));

function Threshold({
  name,
  label,
  hint,
  unit,
  prefix,
  value,
  step = "any",
}: {
  name: keyof Rules;
  label: string;
  hint?: string;
  unit?: string;
  prefix?: string;
  value: number | null;
  step?: string;
}) {
  return (
    <div className="field-row">
      <label htmlFor={name}>
        <span>{label}</span>
        {hint ? <span className="hint">{hint}</span> : null}
      </label>
      <div className="affix">
        {prefix ? <span>{prefix}</span> : null}
        <input id={name} name={name} className="input" inputMode="decimal" type="number" step={step} defaultValue={val(value)} placeholder="off" />
        {unit ? <span>{unit}</span> : null}
      </div>
    </div>
  );
}

export default async function Settings({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const { saved } = await searchParams;
  const today = todayIST();
  const uid = await viewerId();
  const [viewer, rules, matches, tgRow] = await within(Promise.all([
    requireApproved(),
    rulesFor(uid),
    matchesFor(uid, today),
    uid
      ? db()<{ chat: string | null; channel: string | null }[]>`
          SELECT u.telegram_chat_id::text AS chat, r.channel FROM app_users u LEFT JOIN alert_rules r ON r.user_id = u.user_id
          WHERE u.user_id = ${uid}::uuid`.catch(() => [])
      : Promise.resolve([]),
  ]), 9000, "alert settings");
  const tgReady = telegramReady();
  const tgLinked = tgReady && Boolean(tgRow[0]?.chat);
  const channel = tgRow[0]?.channel ?? "email";
  const r: Rules = rules ?? {
    gmp_pct_min: 10,
    profit_per_lot_min: null,
    sub_total_min: null,
    sub_retail_min: null,
    sub_qib_min: null,
    anchor_mf_min: null,
    size_min_cr: null,
    size_max_cr: null,
    match_mode: "all",
    digest_hour: 8,
    digest_days: "daily",
    start_at: "t_minus_1",
    last_day_reminder: false,
    email_to: null,
    paused: false,
  };
  const names = [...matches.entries()].map(([id, m]) => ({ id, slug: m.slug ?? "", name: m.name ?? "" }));
  const ruleText = describeRules(r);

  return (
    <>
      <main className="wrap narrow">
        <div className="page-head">
          <div>
            <h1>Alerts</h1>
            <p>What puts an IPO in your digest, and when the digest arrives.</p>
          </div>
        </div>

        {saved ? <div className="saved-line">Saved. The next digest uses these settings.</div> : null}

        <form action={save} className="settings">
          <section className="card section">
            <div className="card-head">
              <h2>What puts an IPO on your radar</h2>
            </div>
            <p className="small muted" style={{ marginBottom: 14 }}>
              Leave a box empty to ignore that rule. Once an IPO is in your digest it stays there until you mark it
              applied or skipped, or bidding closes.
            </p>

            <fieldset className="seg" aria-label="How rules combine">
              <label>
                <input type="radio" name="match_mode" value="all" defaultChecked={r.match_mode === "all"} />
                <span>All rules must pass</span>
              </label>
              <label>
                <input type="radio" name="match_mode" value="any" defaultChecked={r.match_mode === "any"} />
                <span>Any one is enough</span>
              </label>
            </fieldset>

            <div className="field-group">
              <div className="group-label">Grey market</div>
              <Threshold name="gmp_pct_min" label="GMP at least" hint="% of the upper price band" unit="%" value={r.gmp_pct_min} />
              <Threshold name="profit_per_lot_min" label="Expected profit per lot" hint="GMP × lot size" prefix="₹" value={r.profit_per_lot_min} step="1" />
            </div>

            <div className="field-group">
              <div className="group-label">Subscription</div>
              <Threshold name="sub_total_min" label="Total at least" unit="x" value={r.sub_total_min} />
              <Threshold name="sub_retail_min" label="Retail at least" unit="x" value={r.sub_retail_min} />
              <Threshold name="sub_qib_min" label="QIB at least" hint="QIBs mostly bid on the last day" unit="x" value={r.sub_qib_min} />
              <p className="xs muted">
                Subscription is only known once bidding opens. With &ldquo;all rules must pass&rdquo;, a subscription rule
                holds an issue back until then.
              </p>
            </div>

            <div className="field-group">
              <div className="group-label">Anchor book and size</div>
              <Threshold name="anchor_mf_min" label="Mutual funds took at least" hint="share of the anchor book" unit="%" value={r.anchor_mf_min} />
              <div className="field-row">
                <label htmlFor="size_min_cr">
                  <span>Issue size between</span>
                  <span className="hint">₹ crore</span>
                </label>
                <div className="range">
                  <div className="affix">
                    <span>₹</span>
                    <input id="size_min_cr" name="size_min_cr" className="input" type="number" step="any" inputMode="decimal" defaultValue={val(r.size_min_cr)} placeholder="any" />
                  </div>
                  <span className="muted small">and</span>
                  <div className="affix">
                    <span>₹</span>
                    <input name="size_max_cr" aria-label="Issue size at most" className="input" type="number" step="any" inputMode="decimal" defaultValue={val(r.size_max_cr)} placeholder="any" />
                    <span>Cr</span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="card section">
            <div className="card-head">
              <h2>Digest</h2>
            </div>
            <div className="field-row">
              <label htmlFor="digest_hour">
                <span>Send at</span>
                <span className="hint">IST, give or take a few minutes</span>
              </label>
              <select id="digest_hour" name="digest_hour" className="input" defaultValue={String(r.digest_hour)}>
                {Array.from({ length: 18 }, (_, k) => k + 5).map((h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-row">
              <label htmlFor="digest_days">
                <span>Days</span>
              </label>
              <select id="digest_days" name="digest_days" className="input" defaultValue={r.digest_days}>
                <option value="daily">Every day</option>
                <option value="weekdays">Weekdays only</option>
              </select>
            </div>
            <div className="field-row">
              <label htmlFor="start_at">
                <span>Start watching an IPO</span>
              </label>
              <select id="start_at" name="start_at" className="input" defaultValue={r.start_at}>
                <option value="t_minus_1">The day before it opens</option>
                <option value="open">The day it opens</option>
              </select>
            </div>
            <div className="field-row">
              <label htmlFor="email_to">
                <span>Send to</span>
                <span className="hint">Leave empty to use {viewer.email}</span>
              </label>
              <input id="email_to" name="email_to" type="email" className="input" defaultValue={r.email_to ?? ""} placeholder={viewer.email} />
            </div>
            <div className="field-row">
              <label htmlFor="channel">
                <span>Deliver by</span>
                <span className="hint">
                  {!tgReady
                    ? "Email only for now - Telegram isn't switched on for this site yet"
                    : tgLinked
                      ? "Telegram is connected"
                      : "Tap Connect Telegram below first, then pick Telegram here"}
                </span>
              </label>
              <select id="channel" name="channel" className="input" defaultValue={tgLinked ? channel : "email"}>
                <option value="email">Email</option>
                {tgReady ? (
                  <>
                    <option value="telegram" disabled={!tgLinked}>
                      Telegram{tgLinked ? "" : " (connect first)"}
                    </option>
                    <option value="both" disabled={!tgLinked}>
                      Email and Telegram{tgLinked ? "" : " (connect first)"}
                    </option>
                  </>
                ) : null}
              </select>
            </div>
            <label className="check">
              <input type="checkbox" name="last_day_reminder" defaultChecked={r.last_day_reminder} />
              <span>
                <b>Last-day reminder at 1 pm</b>
                <span className="hint">For radar IPOs closing that day that you haven&apos;t marked yet</span>
              </span>
            </label>
            <label className="check">
              <input type="checkbox" name="paused" defaultChecked={r.paused} />
              <span>
                <b>Pause emails</b>
                <span className="hint">The site keeps working; no digests until you turn this off</span>
              </span>
            </label>
          </section>

          <div className="form-actions">
            <button className="btn primary" type="submit">
              Save
            </button>
            <Link href="/" className="btn ghost">
              Cancel
            </Link>
          </div>
        </form>

        {!tgReady && viewer.isAdmin ? (
          <section className="card section tg-card">
            <div className="grow">
              <h2>Telegram (admin)</h2>
              <p className="small muted" style={{ marginTop: 6 }}>
                Not set up yet, so members only see Email. Add TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and
                TELEGRAM_WEBHOOK_SECRET on Vercel, redeploy, then press Connect webhook on the admin dashboard.
              </p>
            </div>
          </section>
        ) : null}

        {tgReady ? (
          <section className="card section tg-card">
            <div className="grow">
              <h2>Telegram</h2>
              <p className="small muted" style={{ marginTop: 6 }}>
                {tgLinked
                  ? "Connected. Digests, last-day reminders and listing-day notes arrive in Telegram too, as instant notifications."
                  : "Get alerts as instant phone notifications. Tap connect, then press Start in Telegram. Takes 10 seconds."}
              </p>
            </div>
            {tgLinked ? (
              <form action={disconnectTelegram}>
                <button className="btn ghost" type="submit">Disconnect</button>
              </form>
            ) : (
              <form action={connectTelegram}>
                <button className="btn primary" type="submit">Connect Telegram</button>
              </form>
            )}
          </section>
        ) : null}

        <section className="card section">
          <div className="card-head">
            <h2>On your radar today</h2>
            <span className="sub">{ruleText}</span>
          </div>
          {ruleText === "no alerts set" ? (
            <p className="small muted">No rules set, so nothing will reach your radar. Add at least one above.</p>
          ) : names.length ? (
            <ul className="radar-list">
              {names.map((n) => {
                const m = matches.get(Number(n.id))!;
                return (
                  <li key={n.id}>
                    <Link href={`/issue/${n.slug}`}>{n.name.replace(/ (Ltd|Limited)\.?$/i, "")}</Link>
                    <span className="small muted">{m.reasons.length ? m.reasons.join(" · ") : "kept from an earlier digest"}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="small muted">Nothing matches today. Saved changes show up here straight away.</p>
          )}
        </section>
      </main>
    </>
  );
}

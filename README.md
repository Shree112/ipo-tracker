# IPO Tracker

Personal decision layer for Indian mainboard IPOs, retail category.
Milestone 1: the data spine and the historical backfill. No interface yet -
you inspect it with SQL.

---

## Important: run this from PowerShell, not from a Claude shell

Both the cloud sandbox and the sandboxed shell Claude gets on this machine
sit behind an egress proxy that refuses chittorgarh.com, nseindia.com,
investorgain.com and supabase.co. Your own PowerShell window has your real
internet connection, so that is where these scripts run. Claude can still
read, write and edit every file in this folder.

(The eventual scheduled job runs on GitHub Actions, which has open egress,
so this is a development-time constraint only.)

---

## Setup

From this folder in PowerShell:

```
py -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

Then open `.env` and fill in two values:

**`DATABASE_URL`** - Supabase Dashboard -> **Connect** -> copy the string
verbatim. Start with the **Session pooler** option (port 5432, username
`postgres.wvxahfuyxrqpdaokyxub`). The direct `db.*.supabase.co` string needs
IPv6, which most home connections in India don't have. `[YOUR-PASSWORD]` is
the database password from project creation, not the service_role key - reset
it under Settings -> Database if you don't have it. Percent-encode
`@ : / ? # %` if your password contains them.

**`SUPABASE_SERVICE_ROLE_KEY`** - Settings -> API. The `service_role` one, not
`anon`; the backfill writes and needs to bypass row-level security. Not used
yet in milestone 1, but it belongs in `.env` now rather than later.

`.env` is gitignored. Keep it that way.

---

## Run, in order

```
python scripts\apply_schema.py
python scripts\probe_chittorgarh.py
```

`apply_schema.py` is idempotent - re-run it whenever the schema changes.

Then the backfill:

```
python scripts\\backfill_listings.py            :: years from .env
python scripts\\backfill_listings.py 2019 2026  :: explicit range
python scripts\\backfill_listings.py --use-cache :: re-parse saved HTML, no fetching
```

`probe_chittorgarh.py` was reconnaissance and has done its job; it is kept
because it is still the quickest way to see whether the site has changed
shape. (Its `pandas.read_html` calls fail on this pandas version - it wants
`io.StringIO(html)`, not a bare string - but that path turned out to be a
dead end anyway, see below.)

---

## How the Chittorgarh scrape actually works

The performance tracker renders its table client-side: the served HTML shows
"No Record Found". But the page is Next.js, and the server payload is
embedded in `self.__next_f.push([1,"...")` script chunks. Concatenating those
reconstructs a stream containing a `performancesDetails` array with far more
per issue than the rendered table shows - including two fields that changed
the plan:

**`ildt_open_price`** - the listing-day *open*. The build plan assumed the
backfill would be close-only and that the open would have to come from an
exchange OHLC source. It doesn't. Every backfilled row can carry both, with
`price_basis='open'`.

**`qib` / `nii` / `rii` / `total`** - final subscription by category. So the
*signal* side backfills too, not just the outcome side. Subscription against
listing gain is testable on years of history right now, rather than after six
months of live GMP collection.

Validated on the two cached years: 185 IPOs parsed, and our recomputed
close-basis gain matches the site's own published figure on 185/185. The
open-vs-close gap is 5 percentage points or more on 105 of those 185 issues -
which is the concrete reason `price_basis` exists.

---

## Schema notes

Three things in `schema.sql` are deliberate and worth not undoing.

**`gmp_history` and `signal_snapshot` are append-only.** A trigger raises on
UPDATE and DELETE. The time series is the entire basis for slope and for the
calibration curve later, and it cannot be reconstructed once overwritten. To
repair rows on purpose:

```sql
ALTER TABLE gmp_history DISABLE TRIGGER gmp_history_append_only;
-- fix
ALTER TABLE gmp_history ENABLE TRIGGER gmp_history_append_only;
```

**`listing_outcome.price_basis`** records whether the headline price is the
listing-day `open` or `close`. The tracker publishes full listing-day OHLC, so
the backfill is open-based (467 of 468 rows); `close` is only the fallback when
an open is missing. The two differ by 5+ points on 295 of 468 issues, so
regressing across both compares two different quantities and will read as
noise, or worse, as a signal that isn't there. The `calibration` view
carries `price_basis` through so you can't accidentally pool them.

**`scrape_run`** distinguishes `empty` from `ok`. A scraper that silently
returns zero rows is the failure that quietly rots the dataset; this makes it
visible in a query rather than in six months of missing history.

The schema was applied twice against a real Postgres 16 before landing here,
and the append-only triggers, the generated gain columns, the `price_basis`
constraint and the COALESCE upsert were each tested to actually behave.

---

## Layout

```
config.py                      env loading, paths, politeness settings
db.py                          psycopg helpers, upsert_issue, RunLog
schema.sql                     full schema, idempotent
sources/base.py                polite fetcher with caching + retry, slugify
sources/chittorgarh.py         tracker adapter (RSC payload -> normalised rows)
scripts/backfill_listings.py   load tracker years into issues/listing_outcome
sources/ipowatch.py            IPO Watch adapter (day-wise GMP pages)
scripts/backfill_gmp.py        GMP history -> gmp_history + t_minus_1 snapshots
scripts/probe_gmp.py           reconnaissance for the GMP sources
sources/investorgain.py        InvestorGain adapter (live calendar + GMP)
scripts/run_live.py            the daily live job
scripts/send_digest.py         the morning digest email
scripts/mark.py                mark an issue applied / skipped
.github/workflows/live.yml     07:35 IST refresh + digest, 19:15 IST refresh
scripts/apply_schema.py        create/update tables
scripts/probe_chittorgarh.py   reconnaissance
data/raw/                      cached HTML, gitignored
```

`sources/base.get(url, use_cache=True)` reads a saved copy if one exists -
use it while iterating on a parser so you aren't re-hitting the site on every
run. Leave it `False` in scheduled jobs.

Politeness settings live in `.env`: 2.5s between requests to the same host,
one pass per source per run. Don't lower them.

---

## GMP backfill

```bat
python scripts\apply_schema.py            :: adds capture_mode / observed_precision / ipowatch_url
python scripts\backfill_gmp.py --limit 10 :: trial
python scripts\backfill_gmp.py            :: all ~325 issues, ~15 min first time
```

Source is **IPO Watch**, not InvestorGain. InvestorGain (and Chittorgarh's GMP
tab, which is the same data) shows only the last three GMP readings per issue
publicly; the full history is behind IPOMatrix. We don't scrape around that.
IPO Watch publishes the whole day-wise table and is an independent operator,
so it doubles as a cross-check once live InvestorGain scraping starts.

Rules the loader enforces:
- every backfilled row is `capture_mode='backfill'`, `observed_precision='day'`
  - never confusable with a reading we took live
- the T-1 GMP is the last quoted row dated **before** the open date, and is
  skipped if that row is more than 7 days old
- GMP % is against the upper price band, which is what's known at T-1
- issues are matched on issue price + listing date, name only breaks ties;
  two guards print at the end (final GMP vs table, listing price vs our open)

---

## Daily live job

```bat
python scripts\apply_schema.py          :: adds the calendar columns
python scripts\run_live.py --dry-run    :: fetch + print today's board, writes nothing
python scripts\run_live.py              :: the real thing
```

1. **InvestorGain** live report -> each mainboard issue's page -> `issues`
   (dates, price band, lot, amount at one lot, anchor date, RHP and anchor
   report links) + `gmp_history` (source `investorgain`). InvestorGain's
   `cor_id` is Chittorgarh's ipo id, so live issues join onto backfilled ones
   rather than duplicating them. Readings are keyed on the site's own update
   time: rerunning writes nothing new unless the GMP moved.
2. **IPO Watch** live mainboard table -> `gmp_history` (source `ipowatch`),
   matched on subscription window plus name or price.
3. **T-1 freeze** - for issues that opened in the last 3 days with no
   `t_minus_1` snapshot: the latest GMP observed before the open date,
   InvestorGain first. Same rule as the backfill.

It ends by printing the board: every live mainboard issue, its stage (opens
tomorrow / open / closes today / closed) and whether today's digest would
include it (GMP >10% from T-1). The email itself is milestone 2.

**Scheduling** is `.github/workflows/live.yml`: push this folder to a
*private* GitHub repo and add `DATABASE_URL` as an Actions secret. `.env` is
gitignored and must stay that way.

---

## Morning digest

```bat
python scripts\send_digest.py --dry-run     :: build it, save data\digest-preview.html, send nothing
python scripts\send_digest.py               :: send (once per day; reruns do nothing)
python scripts\mark.py "moneyview" applied  :: leaves tomorrow's digest (also: skipped, undo)
python scripts\mark.py --list               :: live issues and their status
```

Membership: **entry** GMP >10% on either source from T-1 onwards; **sticky**
once it has been in a digest; **exit** when marked applied/skipped or closed.
Blocks: Closes today / Open now / Opens tomorrow. No eligible issues, no email.

Email goes through Resend. Sign up at resend.com **with the DIGEST_TO
address** - without a verified domain, the test sender can only deliver to
the account's own address. Put `RESEND_API_KEY` in `.env` and in the Actions
secrets (with `DIGEST_TO`).

---

## Live subscription + close-day snapshot

`run_live.py` also reads InvestorGain's live subscription report (one page,
every open issue): QIB / SHNI / BHNI / NII / retail / total, times subscribed,
plus P/E. Rows join on `issues.investorgain_id`; SME rows are ignored. A new
`subscription` row is written only when a number moved.

For issues that closed in the last 3 days, the job freezes a `close_day`
snapshot: the last subscription reading taken **on the close date**, the last
GMP before the close, and your decision (applied / skipped / none). Together
with the T-1 snapshot that is the calibration log's input side.

The digest shows the latest subscription on each card, and P/E beside the
price band.

---

## Web page (`web/`, Next.js on Vercel)

- `/` - live mainboard IPOs grouped: on your radar (the digest's rule), open &
  upcoming, closed awaiting listing, recently listed.
- `/issue/<slug>` - GMP, size + fresh/OFS split, 1-lot amount, subscription by
  category, P/E, dates, GMP history chart (both sources, 10% line, bidding
  window), documents, what history says for this GMP band, the frozen
  calibration snapshots, and **Applied / Skip / Undo** buttons (POST only).
- One password (`SITE_PASSWORD`), remembered for 90 days per browser.

Deploy once: Vercel -> Add New Project -> import the GitHub repo -> **Root
Directory `web`** -> environment variables `DATABASE_URL` (Supabase **Transaction
pooler**, port 6543) and `SITE_PASSWORD` -> Deploy. Every later `git push`
redeploys by itself. Then put the Vercel address in the `SITE_URL` Actions
secret so digest cards link to the page.

---

## Refresh schedule

| When | What | Workflow |
|---|---|---|
| 07:35 IST | full run (every issue page: calendar, anchor book, financials) + digest | `live.yml` |
| 19:15 IST | full run | `live.yml` |
| every hour | light run: GMP + subscription from 3 pages | `refresh.yml` |
| every 5 min, 09:10-17:25 IST, weekdays | light run, **only on days a mainboard issue closes** | `refresh.yml` |

```bat
python scripts\run_live.py --mode light                                   :: one light pass
python scripts\run_live.py --mode light --only-if-closing-today --loop-every 5 --until 17:25
```

Light runs key GMP readings on the site's own update time and subscription on
the report's own timestamp, so repeating them never duplicates data. The repo
is public, so Actions minutes are free; GitHub pauses scheduled workflows on a
repo with no commits for 60 days - any push re-enables them.


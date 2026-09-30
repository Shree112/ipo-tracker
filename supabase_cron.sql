-- IPO Copilot: the schedule, run by Supabase instead of GitHub.
--
-- GitHub skips most scheduled runs on a quiet repository (9 of ~48 hourly
-- runs fired in two days), so digests and closing-day subscription updates
-- went missing. Supabase's pg_cron is dependable: it calls the website, which
-- either fetches subscription itself or starts the GitHub workflow.
--
-- Run this ONCE in Supabase -> SQL Editor, after:
--   1. replacing PASTE_THE_SAME_SECRET_HERE below with the CRON_SECRET you
--      added on Vercel (same value in both places), and
--   2. the new website version is deployed.
-- Don't commit the file with the real secret in it - this repo is public.
-- Safe to run again (it updates the jobs instead of duplicating them).
-- Times are UTC: IST = UTC + 5:30.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- the shared secret, kept in Supabase Vault (encrypted), not in the job text
do $$
declare sid uuid;
begin
  select id into sid from vault.secrets where name = 'ipo_cron_secret';
  if sid is null then
    perform vault.create_secret('PASTE_THE_SAME_SECRET_HERE', 'ipo_cron_secret', 'CRON_SECRET for the IPO Copilot site');
  else
    perform vault.update_secret(sid, 'PASTE_THE_SAME_SECRET_HERE');
  end if;
end $$;

-- one helper so every job is a one-liner
create or replace function public.ipo_cron_call(job text) returns bigint
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := 'https://ipo-tracker-teal.vercel.app/api/cron/' || job,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ipo_cron_secret'),
      'Content-Type', 'application/json'),
    timeout_milliseconds := 55000);
$$;
revoke all on function public.ipo_cron_call(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.ipo_cron_call(text) from anon, authenticated;
  end if;
end $$;

-- live subscription: every 10 minutes, 08:30-18:20 IST on weekdays
-- (the site only fetches between 09:00 and 17:45 and when an IPO is open)
select cron.schedule('ipo-subscription', '*/10 3-12 * * 1-5', $$ select public.ipo_cron_call('subscription') $$);
-- hourly GMP refresh + digests, at :50 IST (digests for the coming hour)
select cron.schedule('ipo-refresh', '20 * * * *', $$ select public.ipo_cron_call('refresh') $$);
-- full calendar refresh: 07:35 and 19:15 IST
select cron.schedule('ipo-live-am', '5 2 * * *', $$ select public.ipo_cron_call('live') $$);
select cron.schedule('ipo-live-pm', '45 13 * * *', $$ select public.ipo_cron_call('live') $$);
-- comment + prospectus job: 06:50 and 18:40 IST
select cron.schedule('ipo-chatter-am', '20 1 * * *', $$ select public.ipo_cron_call('chatter') $$);
select cron.schedule('ipo-chatter-pm', '10 13 * * *', $$ select public.ipo_cron_call('chatter') $$);

-- Check it (run these any time):
--   select jobname, schedule, active from cron.job order by jobname;
--   select start_time, status, return_message from cron.job_run_details order by start_time desc limit 10;
--   select created, status_code, left(content, 200) from net._http_response order by created desc limit 10;

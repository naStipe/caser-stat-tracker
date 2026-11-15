-- Pulse monitor: compare results with what is normal for the situation, not only with the shown odds.
--
-- 1. Session phase. A player's session starts after 20 minutes without a row. Upgrades early in a session
--    win more often than the shown chance says, and high chances always win less often, so an index against
--    the shown chance mostly measures where players are in their sessions. monitor_rows.phase holds it:
--    0 = the session starts at the player's first row we have (real start unknown), 1 = first 5 minutes,
--    2 = 5-15 minutes, 3 = 15-60 minutes, 4 = later.
-- 2. Discovery. Players are found through the live feed right after a big win. Their rows from 2 hours
--    before to 30 minutes after that moment are not typical (a streak before it, a dip after it: on the
--    data of 2026-11-14, upgrades won 1.09-1.18 times the normal rate from 2 hours to 10 minutes before,
--    0.85-0.89 in the 30 minutes after, and 1.00 more than 2 hours before), so
--    monitor_rows.near marks them and the report leaves them out. A player's discovery is taken from their
--    rows: the newest row read as history, else the first new one.
-- 3. Normal. monitor_cal holds, per chance band and phase, the last 7 days' wins against the shown chances.
--    The report's "ea" is the expected wins at that real rate (shrunk towards the shown chance with 10
--    pseudo-wins), so an index on ea of 1 = normal for this mix of upgrades.
-- 4. Arrival lag. Rows arrive minutes to hours after they happen (revisits, history pages), so the newest
--    windows are incomplete. monitor_rows.added is when a row was first stored, and the report's "lag" says
--    how late rows arrive, so the page can mark windows that are still filling.
--
-- phase and near are filled by monitor_derive(), a pg_cron job every minute, for rows that have no phase
-- yet (and the rows after them, whose phase a late row can change). The monitor does not send them.
-- The report (20261115000001) keeps every field of 20261114000006, so a page
-- of an older version keeps working.

alter table public.monitor_rows add column if not exists added bigint;
-- Set after the column exists, so rows stored before this stay null instead of getting today's time.
alter table public.monitor_rows alter column added set default ((extract(epoch from clock_timestamp()) * 1000)::bigint);
alter table public.monitor_rows add column if not exists phase smallint;
alter table public.monitor_rows add column if not exists near boolean;
create index if not exists monitor_rows_u_ts on public.monitor_rows (u, ts);
create index if not exists monitor_rows_underived on public.monitor_rows (u) where phase is null;

create table if not exists public.monitor_cal (
  band text not null,
  phase smallint not null,
  n bigint not null,
  w bigint not null,
  ew double precision not null,
  primary key (band, phase)
);
create table if not exists public.monitor_derive_state (
  id integer primary key default 1 check (id = 1),
  cal_at timestamptz not null
);
alter table public.monitor_cal enable row level security;
alter table public.monitor_derive_state enable row level security;
revoke all on public.monitor_cal, public.monitor_derive_state from anon, authenticated;

-- Shown-chance bands of "upgrades by shown chance" (codes a to g, see monitor/dashboard/view.js).
create or replace function public.monitor_band(chance double precision) returns text
language sql immutable
set search_path = ''
as $$
  select case when chance is null or chance <= 0 then null
              when chance < 10 then 'a' when chance < 15 then 'b' when chance < 25 then 'c' when chance < 35 then 'd'
              when chance < 55 then 'e' when chance < 70 then 'f' else 'g' end
$$;

/** Fills phase and near for up to 500 players with rows that have none, and refreshes monitor_cal every 30 minutes. */
create or replace function public.monitor_derive(force_cal boolean default false) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  near_before constant bigint := 2::bigint * 3600000;
  near_after constant bigint := 30::bigint * 60000;
  session_gap constant bigint := 20::bigint * 60000;
  -- Rows this long before the first underived row are read too, for the gaps and session starts.
  lead_in constant bigint := 3::bigint * 3600000;
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  done integer;
begin
  with t as (
    select p.u, min(p.ts) as from_ts from public.monitor_rows p where p.phase is null group by p.u order by min(p.ts) limit 500
  ), pl as (
    select t.u, t.from_ts,
      (select min(m.ts) from public.monitor_rows m where m.u = t.u) as first_ts,
      (select coalesce(max(m.ts) filter (where m.back), min(m.ts) filter (where not m.back)) from public.monitor_rows m where m.u = t.u) as anchor
    from t
  ), w as (
    select p.id, p.u, p.ts, pl.from_ts, pl.first_ts, pl.anchor,
      p.ts - lag(p.ts) over (partition by p.u order by p.ts, p.id) as gap
    from public.monitor_rows p join pl on pl.u = p.u
    where p.ts >= pl.from_ts - lead_in
  ), s as (
    select w.*, sum(case when w.gap is null or w.gap > session_gap then 1 else 0 end) over (partition by w.u order by w.ts, w.id) as sid
    from w
  ), f as (
    -- A session that starts inside the lead-in but before an updated row is either its real start (the gap
    -- before it is over 20 minutes) or more than an hour before that row, so the phase comes out right.
    select s.id, s.ts, s.from_ts, s.anchor,
      case when bool_or(s.ts = s.first_ts) over (partition by s.u, s.sid) then 0
           else case when s.ts - min(s.ts) over (partition by s.u, s.sid) < 300000 then 1
                     when s.ts - min(s.ts) over (partition by s.u, s.sid) < 900000 then 2
                     when s.ts - min(s.ts) over (partition by s.u, s.sid) < 3600000 then 3
                     else 4 end end as phase
    from s
  )
  update public.monitor_rows m
  set phase = f.phase,
      near = (f.anchor is not null and f.ts >= f.anchor - near_before and f.ts < f.anchor + near_after)
  from f
  where m.id = f.id and f.ts >= f.from_ts
    -- Rows after a late one are read again but mostly keep their values; only changes are written.
    and (m.phase is null or m.phase is distinct from f.phase
         or m.near is distinct from (f.anchor is not null and f.ts >= f.anchor - near_before and f.ts < f.anchor + near_after));
  get diagnostics done = row_count;

  if force_cal or not exists (select 1 from public.monitor_derive_state d where d.cal_at > now() - interval '30 minutes') then
    delete from public.monitor_cal;
    insert into public.monitor_cal (band, phase, n, w, ew)
    select public.monitor_band(p.chance), p.phase, count(*), sum(coalesce(p.won, p.returned > 0)::int), sum(p.chance / 100.0)
    from public.monitor_rows p
    where p.kind = 'upgrade' and p.chance > 0 and p.chance <= 100 and p.stake > 0 and p.phase is not null and not coalesce(p.near, false)
      and p.ts >= now_ms - 7::bigint * 86400000
    group by 1, 2;
    insert into public.monitor_derive_state (id, cal_at) values (1, now()) on conflict (id) do update set cal_at = excluded.cal_at;
  end if;
  return done;
end
$$;
revoke all on function public.monitor_derive(boolean), public.monitor_band(double precision) from public, anon, authenticated;

-- The job fills the rows stored so far within its first few runs (500 players each), then keeps up.
select cron.schedule('monitor-derive', '* * * * *', 'select public.monitor_derive()');


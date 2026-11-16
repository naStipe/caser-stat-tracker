-- Pulse monitor: less work per minute, so page reads stop hitting the 8 s statement timeout.
--
-- Why. The page showed "canceling statement due to statement timeout" a few times an hour. The reports take
-- 1-2 s on their own, but the database's CPU is small and shared: when monitor_derive() runs long, or the page
-- sends its reads together, a 2 s report takes over 8 s. Three things did more work than needed:
--
-- 1. Every 30 minutes monitor_derive() rebuilt monitor_cal from 7 days of raw rows: runs of 6-13 s instead of
--    about 1 s. monitor_hourly holds the same sums (wins, shown chances, per band and phase, rows next to a
--    discovery left out), so monitor_cal now comes from there. Checked on 2026-11-15: the same counts, apart
--    from the rows that arrived since the last refresh.
-- 2. monitor_derive() found each player's discovery by reading all of the player's rows. It now reads one row:
--    the newest history row, else the oldest new one, through the (u, ts) index.
-- 3. The raw-row reports (windows under 30 minutes: the 7-hour comparison, the 24-hour range, the 5-20 minute
--    checks) read 7 days of raw case rows for each case's normal hit rate, about 0.5 s a call. They now read the
--    half-hour totals. The 7 days then start at a half hour: at most 30 minutes less history.

create index if not exists monitor_hourly_kind_slot on public.monitor_hourly (kind, slot);

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
      -- The discovery: the newest row read as history, else the first new one.
      coalesce((select max(m.ts) from public.monitor_rows m where m.u = t.u and m.back),
               (select min(m.ts) from public.monitor_rows m where m.u = t.u and not m.back)) as anchor
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
    -- From the half-hour totals: nw counts upgrades with a shown chance in (0, 100], phase -1 is not derived yet.
    insert into public.monitor_cal (band, phase, n, w, ew)
    select h.band, h.phase, sum(h.nw), sum(h.w), sum(h.pe)
    from public.monitor_hourly h
    where h.kind = 'upgrade' and h.band <> '' and h.phase >= 0 and h.slot >= now_ms - 7::bigint * 86400000
    group by 1, 2
    having sum(h.nw) > 0;
    insert into public.monitor_derive_state (id, cal_at) values (1, now()) on conflict (id) do update set cal_at = excluded.cal_at;
  end if;
  return done;
end
$$;
revoke all on function public.monitor_derive(boolean) from public, anon, authenticated;

-- The raw-row reports: each case's normal hit rate from the half-hour totals. The rest of each function stays as
-- it is, so its current definition is edited in place; the migration stops if the text is not found.
do $$
declare
  fn text;
  def text;
  changed text;
begin
  foreach fn in array array['public.monitor_report_raw(bigint, bigint, bigint, integer)', 'public.monitor_window_sums_raw(bigint, bigint, bigint)'] loop
    def := pg_get_functiondef(fn::regprocedure);
    changed := regexp_replace(def,
      'select p\.slug, count\(\*\) as (c?n), sum\(\(p\.returned >= p\.stake\)::int\) as (c?h)\s+from public\.monitor_rows p\s+where p\.kind = ''case'' and p\.slug is not null and p\.ts >= base_from and p\.ts < to_ms and p\.stake > 0 and not coalesce\(p\.near, false\)\s+group by p\.slug',
      E'select h.slug, sum(h.n) as \\1, sum(h.hits) as \\2\n    from public.monitor_hourly h\n    where h.kind = ''case'' and h.slug <> '''' and h.slot >= base_from and h.slot < to_ms\n    group by h.slug');
    if changed = def then raise exception 'case baseline not found in %', fn; end if;
    execute changed;
  end loop;
end
$$;

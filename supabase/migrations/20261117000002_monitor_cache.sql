-- Pulse monitor: the page reads its heavy reports from a cache that a cron job keeps fresh.
--
-- Why. The page still showed "canceling statement due to statement timeout" and took many seconds to load or
-- update. Measured on 2026-11-17 (pg_stat_statements): monitor_report averaged 2.3 s a call (up to 8 s), and the
-- page sent three of them every minute, next to monitor_window_sums (4.2 s, 10 s for 10-minute windows over 7
-- days), monitor_shared (4.9 s) and the per-minute monitor_derive(). The database's CPU is small and shared, so
-- reads sent together slow each other past the 8 s timeout of signed-in users.
--
-- What. monitor_cached(name, args, roll_ms, lead_ms) answers from public.monitor_cache:
-- - fresh enough: returned at once;
-- - older: returned at once as well (at most twice its refresh time plus a minute old); the cron job refreshes it;
-- - missing or very old: computed now, as before. A computation that hits the timeout is not lost: the request is
--   kept, the cron job computes it within a minute, and meanwhile the caller gets the newest data of the same
--   series (the same report for an earlier window), or {"pending": true} when there is none.
-- monitor_cache_warm(), every minute: for every series asked for in the last 15 minutes, computes the report for
-- the current window when its cached copy is older than its refresh time, and, in the last 75 seconds before a
-- window boundary, the report for the next window too, so the page finds it ready when it moves on. It stops
-- after 40 seconds. A series is the same report with its range moving with time: args without from_ms and to_ms,
-- the span (to_ms - from_ms) and how the page aligns to_ms (to_ms = floor(now / roll_ms) * roll_ms + lead_ms).
-- Each computation runs as the viewer who last asked for it, so monitor_is_viewer() still guards every report.

create table if not exists public.monitor_cache (
  key text primary key,
  name text not null,
  args jsonb not null,
  span bigint not null,
  roll bigint not null,
  lead bigint not null,
  series text not null,
  asked_by uuid,
  asked_at timestamptz not null default now(),
  at timestamptz,
  ms integer,
  data jsonb
);
create index if not exists monitor_cache_series on public.monitor_cache (series, at desc);
alter table public.monitor_cache enable row level security;
revoke all on public.monitor_cache from anon, authenticated;

-- How long a cached report counts as fresh. The cron job runs every minute, so the shortest is just under that.
create or replace function public.monitor_cache_ttl(name text, span bigint) returns interval
language sql immutable
set search_path = ''
as $$
  select case
    when name = 'monitor_report' and span <= 8::bigint * 3600000 then interval '50 seconds'
    when name = 'monitor_report' and span <= 25::bigint * 3600000 then interval '110 seconds'
    when name = 'monitor_report' then interval '290 seconds'
    else interval '590 seconds'
  end
$$;

create or replace function public.monitor_cache_compute(name text, args jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  f bigint := (args->>'from_ms')::bigint;
  t bigint := (args->>'to_ms')::bigint;
  b bigint := (args->>'bucket_ms')::bigint;
begin
  case name
    when 'monitor_report' then
      return public.monitor_report(f, t, b, coalesce((args->>'tz_offset_min')::integer, 0));
    when 'monitor_window_sums' then
      return coalesce((select jsonb_agg(to_jsonb(s) order by s.bucket, s.kind) from public.monitor_window_sums(f, t, b) s), '[]'::jsonb);
    when 'monitor_shared' then
      return public.monitor_shared(f, t, b);
    else
      raise exception 'not a cached report: %', name;
  end case;
end
$$;
revoke all on function public.monitor_cache_compute(text, jsonb) from public, anon, authenticated;

create or replace function public.monitor_cached(name text, args jsonb, roll_ms bigint, lead_ms bigint) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  from_ms bigint := (args->>'from_ms')::bigint;
  to_ms bigint := (args->>'to_ms')::bigint;
  span bigint;
  k text;
  ser text;
  c public.monitor_cache;
  t0 timestamptz;
  out jsonb;
begin
  if not public.monitor_is_viewer() then raise exception 'not allowed' using errcode = '42501'; end if;
  if name not in ('monitor_report', 'monitor_window_sums', 'monitor_shared') then raise exception 'not a cached report: %', name; end if;
  if from_ms is null or to_ms is null or to_ms <= from_ms or roll_ms is null or roll_ms < 60000
     or lead_ms is null or lead_ms < 0 or lead_ms > roll_ms or (to_ms - lead_ms) % roll_ms <> 0 then
    raise exception 'bad cache arguments';
  end if;
  span := to_ms - from_ms;
  k := name || ' ' || args::text;
  ser := name || ' ' || (args - 'from_ms' - 'to_ms')::text || ' ' || span || '/' || roll_ms || '/' || lead_ms;

  select * into c from public.monitor_cache m where m.key = k;
  if found then
    update public.monitor_cache m set asked_at = now(), asked_by = auth.uid() where m.key = k;
    if c.data is not null and c.at > now() - 2 * public.monitor_cache_ttl(name, span) - interval '60 seconds' then
      return c.data;
    end if;
  end if;

  begin
    t0 := clock_timestamp();
    out := public.monitor_cache_compute(name, args);
    insert into public.monitor_cache as m (key, name, args, span, roll, lead, series, asked_by, asked_at, at, ms, data)
    values (k, name, args, span, roll_ms, lead_ms, ser, auth.uid(), now(), clock_timestamp(),
            (extract(epoch from clock_timestamp() - t0) * 1000)::integer, out)
    on conflict (key) do update set asked_by = excluded.asked_by, asked_at = excluded.asked_at, at = excluded.at,
      ms = excluded.ms, data = excluded.data;
    return out;
  exception when query_canceled then
    -- Too slow for now: keep the request so the cron job computes it, and answer with what there is.
    insert into public.monitor_cache as m (key, name, args, span, roll, lead, series, asked_by, asked_at)
    values (k, name, args, span, roll_ms, lead_ms, ser, auth.uid(), now())
    on conflict (key) do update set asked_by = excluded.asked_by, asked_at = excluded.asked_at;
    select m.data into out from public.monitor_cache m where m.series = ser and m.data is not null order by m.at desc limit 1;
    return coalesce(out, jsonb_build_object('pending', true));
  end;
end
$$;
revoke all on function public.monitor_cached(text, jsonb, bigint, bigint) from public, anon;
grant execute on function public.monitor_cached(text, jsonb, bigint, bigint) to authenticated;

create or replace function public.monitor_cache_warm() returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  started timestamptz := clock_timestamp();
  s record;
  now_ms bigint;
  cur_to bigint;
  tos bigint[];
  t bigint;
  a jsonb;
  k text;
  t0 timestamptz;
  d jsonb;
  done integer := 0;
begin
  delete from public.monitor_cache m where m.asked_at < now() - interval '3 hours';
  for s in
    select * from (
      select distinct on (m.series) m.name, m.args, m.span, m.roll, m.lead, m.series, m.asked_by, m.asked_at
      from public.monitor_cache m
      where m.asked_at > now() - interval '15 minutes' and m.asked_by is not null
      order by m.series, m.asked_at desc
    ) x order by x.asked_at desc
  loop
    now_ms := (extract(epoch from clock_timestamp()) * 1000)::bigint;
    cur_to := (now_ms / s.roll) * s.roll + s.lead;
    tos := array[cur_to];
    if s.roll >= 300000 and (now_ms / s.roll) * s.roll + s.roll - now_ms <= 75000 then tos := tos || (cur_to + s.roll); end if;
    foreach t in array tos loop
      exit when clock_timestamp() - started > interval '40 seconds';
      a := s.args || jsonb_build_object('from_ms', t - s.span, 'to_ms', t);
      k := s.name || ' ' || a::text;
      continue when exists (select 1 from public.monitor_cache m
                            where m.key = k and m.at > clock_timestamp() - public.monitor_cache_ttl(s.name, s.span));
      perform set_config('request.jwt.claims', jsonb_build_object('sub', s.asked_by, 'role', 'authenticated')::text, true);
      begin
        t0 := clock_timestamp();
        d := public.monitor_cache_compute(s.name, a);
        insert into public.monitor_cache as m (key, name, args, span, roll, lead, series, asked_by, asked_at, at, ms, data)
        values (k, s.name, a, s.span, s.roll, s.lead, s.series, s.asked_by, s.asked_at, clock_timestamp(),
                (extract(epoch from clock_timestamp() - t0) * 1000)::integer, d)
        on conflict (key) do update set at = excluded.at, ms = excluded.ms, data = excluded.data,
          asked_at = greatest(m.asked_at, excluded.asked_at);
        done := done + 1;
      exception when others then
        raise warning 'monitor_cache_warm: % failed: %', k, sqlerrm;
      end;
    end loop;
    exit when clock_timestamp() - started > interval '40 seconds';
  end loop;
  perform set_config('request.jwt.claims', '', true);
  return done;
end
$$;
revoke all on function public.monitor_cache_warm() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'monitor-cache';
select cron.schedule('monitor-cache', '* * * * *', 'select public.monitor_cache_warm()');

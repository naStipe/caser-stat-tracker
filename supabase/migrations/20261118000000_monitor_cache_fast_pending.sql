-- Pulse monitor: faster answers while a report is being prepared, and reads ahead that the cron job ignores.
--
-- Why. Picking a range or window the page had not shown lately could take a minute: the report was computed on
-- request (about 2 s, up to 8 s, sometimes past the 8 s timeout), and a timed-out report came back as
-- {"pending": true}. The page then asked again, and every ask started the same slow computation once more.
--
-- What.
-- - monitor_cached answers {"pending": true} (or the newest data of the same series) at once when the same report
--   was asked for in the last 90 seconds and has no data yet: the cron job is preparing it. The page now asks again
--   every 3 seconds, which costs a lookup, not a computation.
-- - A fifth argument, warm (default true). The page reads a view's report ahead when the pointer rests on its
--   button, with warm = false: the answer is cached as usual, but the read does not mark the series as wanted, so
--   the cron job does not keep refreshing views nobody opened. A normal read of the same report marks it.

drop function if exists public.monitor_cached(text, jsonb, bigint, bigint);

create or replace function public.monitor_cached(name text, args jsonb, roll_ms bigint, lead_ms bigint, warm boolean default true)
returns jsonb
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
  who uuid := case when warm then auth.uid() else null end;
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
    if warm then
      update public.monitor_cache m set asked_at = now(), asked_by = auth.uid() where m.key = k;
    end if;
    if c.data is not null and c.at > now() - 2 * public.monitor_cache_ttl(name, span) - interval '60 seconds' then
      return c.data;
    end if;
    -- Asked for a moment ago and still without data: the cron job is computing it. Do not start it again.
    if c.data is null and c.asked_at > now() - interval '90 seconds' then
      select m.data into out from public.monitor_cache m where m.series = ser and m.data is not null order by m.at desc limit 1;
      return coalesce(out, jsonb_build_object('pending', true));
    end if;
  end if;

  begin
    t0 := clock_timestamp();
    out := public.monitor_cache_compute(name, args);
    insert into public.monitor_cache as m (key, name, args, span, roll, lead, series, asked_by, asked_at, at, ms, data)
    values (k, name, args, span, roll_ms, lead_ms, ser, who, now(), clock_timestamp(),
            (extract(epoch from clock_timestamp() - t0) * 1000)::integer, out)
    on conflict (key) do update set asked_by = coalesce(excluded.asked_by, m.asked_by),
      asked_at = case when excluded.asked_by is not null then excluded.asked_at else m.asked_at end,
      at = excluded.at, ms = excluded.ms, data = excluded.data;
    return out;
  exception when query_canceled then
    -- Too slow for now: keep the request so the cron job computes it, and answer with what there is. A read ahead
    -- (warm = false) is kept too, but the job only computes it once a normal read asks for it.
    insert into public.monitor_cache as m (key, name, args, span, roll, lead, series, asked_by, asked_at)
    values (k, name, args, span, roll_ms, lead_ms, ser, who, now())
    on conflict (key) do update set asked_by = coalesce(excluded.asked_by, m.asked_by), asked_at = excluded.asked_at;
    select m.data into out from public.monitor_cache m where m.series = ser and m.data is not null order by m.at desc limit 1;
    return coalesce(out, jsonb_build_object('pending', true));
  end;
end
$$;
revoke all on function public.monitor_cached(text, jsonb, bigint, bigint, boolean) from public, anon;
grant execute on function public.monitor_cached(text, jsonb, bigint, bigint, boolean) to authenticated;

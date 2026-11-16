-- Pulse monitor: how complete is a window that is still filling?
--
-- Rows arrive minutes to days after they happen (most come from reading newly found players' history), so the
-- "Right now" card judges an hour that holds only part of the rows it will end up with. This measures, over the
-- last 3 days, what share of a window's rows had arrived at the same age as the window the card shows:
-- windows of window_ms ending at to_ms - k * window_ms (k >= 1), and per window the rows stored by
-- end + age_ms (present) against the rows stored by end + 12 hours and by end + 24 hours (final). Only windows
-- whose 12 or 24 hours have passed count. present / final is the share an hour of this age usually has; p10 and
-- p90 are that share's spread between single windows, which is wide (one hour can be 25%, the next 90%).
--
-- monitor_rows.added only exists for rows stored since 2026-11-15 00:04 UTC (1794701049789), and rows that
-- happened before that and were read later would look days late, so windows starting earlier are left out.
-- The same rows as the report: stake above 0, not next to a player's discovery.

create or replace function public.monitor_arrival(to_ms bigint, window_ms bigint, age_ms bigint)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  since_ms bigint := greatest(1794701049789, to_ms - 3::bigint * 86400000);
  out jsonb;
begin
  if not public.monitor_is_viewer() then raise exception 'not allowed' using errcode = '42501'; end if;
  if window_ms < 300000 or window_ms > 6 * 3600000 or age_ms < 0 or age_ms > 12 * 3600000 or to_ms > now_ms + 3600000 then
    raise exception 'window or age out of bounds';
  end if;

  with r as (
    select p.kind,
      to_ms + floor((p.ts - to_ms)::numeric / window_ms)::bigint * window_ms + window_ms as e,
      p.added
    from public.monitor_rows p
    where p.ts >= since_ms and p.ts < to_ms - window_ms and p.added is not null
      and p.stake > 0 and not coalesce(p.near, false)
  ), w as (
    select r.kind, r.e, f.hours,
      count(*) filter (where r.added <= r.e + age_ms) as present,
      count(*) filter (where r.added <= r.e + f.hours::bigint * 3600000) as final
    from r cross join (values (12), (24)) f(hours)
    where r.e - window_ms >= since_ms and r.e + f.hours::bigint * 3600000 <= now_ms
    group by r.kind, r.e, f.hours
  ), k as (
    select w.kind, w.hours, count(*) filter (where w.final > 0) as windows, sum(w.present) as present, sum(w.final) as final,
      percentile_cont(0.1) within group (order by w.present::double precision / nullif(w.final, 0)) filter (where w.final > 0) as p10,
      percentile_cont(0.9) within group (order by w.present::double precision / nullif(w.final, 0)) filter (where w.final > 0) as p90
    from w group by w.kind, w.hours
  )
  select coalesce(jsonb_object_agg(k.kind || '_' || k.hours, jsonb_build_object('windows', k.windows, 'present', k.present, 'final', k.final, 'p10', k.p10, 'p90', k.p90)), '{}'::jsonb)
  into out from k;
  return out;
end
$$;
alter function public.monitor_arrival(bigint, bigint, bigint) set plan_cache_mode = 'force_custom_plan';
revoke all on function public.monitor_arrival(bigint, bigint, bigint) from public, anon;
grant execute on function public.monitor_arrival(bigint, bigint, bigint) to authenticated;

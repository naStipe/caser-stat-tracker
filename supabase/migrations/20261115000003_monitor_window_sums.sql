-- Pulse monitor: per-window sums for the dashboard's "does one window predict the next?" check at short window
-- sizes (5 to 60 minutes over 7 days). monitor_report would send far more than needed for 2,000 windows, so this
-- returns only what the check uses, per window and kind:
--   upgrades: n, obs = wins, exp = wins the normal rate predicts ("ea" in monitor_report), v = its variance;
--   cases:    n, obs = hits, exp = hits each case's 7-day rate predicts, v = its variance.
-- The same rows as monitor_report: rows next to a player's discovery are left out.

create or replace function public.monitor_window_sums(from_ms bigint, to_ms bigint, bucket_ms bigint)
returns table (bucket bigint, kind text, n bigint, obs bigint, exp double precision, v double precision)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  base_from bigint := least(from_ms, to_ms - 7::bigint * 86400000);
begin
  if not public.monitor_is_viewer() then raise exception 'not allowed' using errcode = '42501'; end if;
  if bucket_ms < 60000 or to_ms - from_ms > 31::bigint * 86400000 or (to_ms - from_ms) / bucket_ms > 10000 then
    raise exception 'range or bucket out of bounds';
  end if;

  return query
  with cb as (
    select p.slug, count(*) as cn, sum((p.returned >= p.stake)::int) as ch
    from public.monitor_rows p
    where p.kind = 'case' and p.slug is not null and p.ts >= base_from and p.ts < to_ms and p.stake > 0 and not coalesce(p.near, false)
    group by p.slug
  ), g as (
    select coalesce(sum(cb.ch)::double precision / nullif(sum(cb.cn), 0), 0.35) as rate from cb
  ), q as (
    select cb.slug, (cb.ch + 20 * g.rate) / (cb.cn + 20) as q from cb, g
  ), cal as (
    select c.band, c.phase, (c.w + 10)::double precision / (c.ew + 10) as f from public.monitor_cal c
  ), r as (
    select
      from_ms + ((p.ts - from_ms) / bucket_ms) * bucket_ms as b,
      p.kind as k,
      case when p.kind = 'upgrade' then coalesce(p.won, p.returned > 0)::int else (p.returned >= p.stake)::int end as o,
      case when p.kind = 'upgrade' then least(0.99, p.chance / 100.0 * coalesce(c.f, 1)) else q.q end as e
    from public.monitor_rows p
    left join q on p.kind = 'case' and q.slug = p.slug
    left join cal c on p.kind = 'upgrade' and c.band = public.monitor_band(p.chance) and c.phase = p.phase
    where p.ts >= from_ms and p.ts < to_ms and p.stake > 0 and not coalesce(p.near, false)
      and ((p.kind = 'upgrade' and p.chance > 0 and p.chance <= 100) or (p.kind = 'case' and q.q is not null))
  )
  select r.b, r.k, count(*), sum(r.o)::bigint, round(sum(r.e)::numeric, 3)::double precision, round(sum(r.e * (1 - r.e))::numeric, 3)::double precision
  from r group by r.b, r.k order by r.b, r.k;
end
$$;

revoke all on function public.monitor_window_sums(bigint, bigint, bigint) from public, anon;
grant execute on function public.monitor_window_sums(bigint, bigint, bigint) to authenticated;

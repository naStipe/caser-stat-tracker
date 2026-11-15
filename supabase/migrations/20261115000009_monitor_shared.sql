-- Pulse monitor: does the whole site shift together, and does the site's state before a deposit say anything
-- about the boost after it?
--
-- 1. Shared shift. If the site raised or lowered the odds for everyone at times, players in the same window would
--    be lucky or unlucky together. Per window and player this returns the residual (wins or hits minus the normal
--    expectation) and its variance; per window the sums the dashboard needs to split the window's extra spread
--    into a part shared across players and a part inside each player:
--      xc = (sum of residuals)^2 - sum of squared per-player residuals   (only products of different players)
--      xe = (sum of expectations)^2 - sum of squared per-player expectations
--    With no shared shift xc averages 0. With a relative shift of standard deviation tau common to all players in a
--    window, xc averages tau^2 * xe, so tau^2 = sum(xc) / sum(xe). ww is the sum of squared per-player residuals:
--    against v it shows how much players cluster on their own. house is staked minus returned in the window.
--    Upgrades use the normal rate (shown chance times the band and phase factor), cases each case's 7-day hit rate,
--    the same as monitor_window_sums_rolled. It reads the running totals, so it works for any range they cover.
--
-- 2. Own deposits. For each completed deposit in sync_events (the owner's own synced history) in the range: the
--    owner's normal upgrades (no mystery, no super drop) in the 5 minutes after it (until the next deposit),
--    the other players' upgrade wins against normal in the half hour before it, and the drop-line colours the
--    monitor saw in the 15 minutes before it. Only counts leave the function.

create or replace function public.monitor_shared(from_ms bigint, to_ms bigint, bucket_ms bigint)
returns jsonb
language plpgsql stable security definer
set search_path = ''
set work_mem = '64MB'
as $$
declare
  base_from bigint := least(from_ms, to_ms - 7::bigint * 86400000);
  out jsonb;
begin
  if not public.monitor_is_viewer() then raise exception 'not allowed' using errcode = '42501'; end if;
  if bucket_ms < 1800000 or bucket_ms % 1800000 <> 0 or from_ms % 1800000 <> 0 or to_ms - from_ms > 31::bigint * 86400000
     or (to_ms - from_ms) / bucket_ms > 3000 then
    raise exception 'range or bucket out of bounds';
  end if;

  with cb as (
    select h.slug, sum(h.n) as cn, sum(h.hits) as ch
    from public.monitor_hourly h
    where h.kind = 'case' and h.slug <> '' and h.slot >= base_from and h.slot < to_ms
    group by h.slug
  ), g as (
    select coalesce(sum(cb.ch)::double precision / nullif(sum(cb.cn), 0), 0.35) as rate from cb
  ), q as (
    select cb.slug, (cb.ch + 20 * g.rate) / (cb.cn + 20) as q from cb, g
  ), cal as (
    select c.band, c.phase, (c.w + 10)::double precision / (c.ew + 10) as f from public.monitor_cal c
  ), pw as (
    select from_ms + ((h.slot - from_ms) / bucket_ms) * bucket_ms as b, h.kind as k, h.u,
      sum(case when h.kind = 'upgrade' then h.nw else h.n end) as n,
      sum(case when h.kind = 'upgrade' then h.w else h.hits end) as o,
      sum(case when h.kind = 'upgrade' then coalesce(c.f, 1) * h.pe else q.q * h.n end) as e,
      sum(case when h.kind = 'upgrade' then coalesce(c.f, 1) * h.pe - coalesce(c.f, 1) * coalesce(c.f, 1) * h.pe2 else q.q * (1 - q.q) * h.n end) as v,
      sum(h.x) as x, sum(h.y) as y
    from public.monitor_hourly h
    left join q on h.kind = 'case' and q.slug = h.slug
    left join cal c on h.kind = 'upgrade' and c.band = h.band and c.phase = h.phase
    where h.slot >= from_ms and h.slot < to_ms
      and ((h.kind = 'upgrade' and h.nw > 0) or (h.kind = 'case' and q.q is not null and h.n > 0))
    group by 1, 2, 3
  ), w as (
    select pw.b, pw.k, sum(pw.n) as n, count(*) as players, sum(pw.o) as o, sum(pw.e) as e, sum(pw.v) as v,
      sum(pw.o - pw.e) * sum(pw.o - pw.e) - sum((pw.o - pw.e) * (pw.o - pw.e)) as xc,
      sum(pw.e) * sum(pw.e) - sum(pw.e * pw.e) as xe,
      sum((pw.o - pw.e) * (pw.o - pw.e)) as ww,
      sum(pw.x) as x, sum(pw.y) as y
    from pw group by 1, 2
  )
  select jsonb_build_object('windows', coalesce((
    select jsonb_agg(jsonb_build_object('bucket', w.b, 'kind', w.k, 'n', w.n, 'players', w.players, 'obs', w.o,
      'exp', round(w.e::numeric, 4), 'v', round(w.v::numeric, 4), 'xc', round(w.xc::numeric, 4), 'xe', round(w.xe::numeric, 4),
      'ww', round(w.ww::numeric, 4), 'x', round(w.x::numeric, 2), 'y', round(w.y::numeric, 2)) order by w.b, w.k)
    from w), '[]'::jsonb))
  into out;

  out := out || jsonb_build_object('deposits', coalesce((
    -- One ordered pass per account: each upgrade belongs to the latest deposit before it (a deposit sorts before an
    -- upgrade with the same time), so a later deposit ends the earlier one's window. A join of deposits against
    -- upgrades made the planner rescan the history once per deposit (45 s over 30 days).
    with ev as materialized (
      select coalesce(e.data->>'userId', e.account) as acc, (e.data->>'kind' = 'upgrade') as isup, (e.data->>'ts')::bigint as ts,
             coalesce((e.data->>'won')::boolean, false)::int as won, coalesce((e.data->>'chanceShown')::double precision / 100, 0) as p
      from public.sync_events e
      where not e.deleted and (e.data->>'ts')::bigint >= from_ms and (e.data->>'ts')::bigint < to_ms + 300000
        and ((e.data->>'kind' = 'deposit' and e.data->>'status' = 'completed' and (e.data->>'ts')::bigint < to_ms)
          or (e.data->>'kind' = 'upgrade' and e.data->>'status' in ('won', 'lost')
              and not coalesce((e.data->>'mystery')::boolean, false)
              and not coalesce((e.data->'superDrop'->>'shown')::boolean, false)
              and (e.data->>'chanceShown')::double precision > 0 and (e.data->>'chanceShown')::double precision <= 100))
    ), seq as (
      select ev.*, max(case when not ev.isup then ev.ts end) over (partition by ev.acc order by ev.ts, ev.isup rows unbounded preceding) as dts
      from ev
    ), own as materialized (
      select seq.acc, seq.dts as ts, count(*) as n, sum(seq.won) as w, sum(seq.p) as e, sum(seq.p * (1 - seq.p)) as v
      from seq where seq.isup and seq.dts is not null and seq.ts < seq.dts + 300000
      group by seq.acc, seq.dts
    ), site as (
      select own.ts, sum(h.w) as w, sum(coalesce((c.w + 10)::double precision / (c.ew + 10), 1) * h.pe) as e
      from own
      join public.monitor_hourly h on h.kind = 'upgrade' and h.nw > 0
        and h.slot >= (own.ts / 1800000) * 1800000 - 1800000 and h.slot < (own.ts / 1800000) * 1800000
      left join public.monitor_cal c on c.band = h.band and c.phase = h.phase
      group by own.ts
    ), feed as (
      select own.ts, sum(f.seen) as seen, sum(f.gold) as gold
      from own join public.monitor_feed f on f.ts >= own.ts - 900000 and f.ts < own.ts
      group by own.ts
    )
    select jsonb_agg(jsonb_build_object('ts', own.ts, 'n', own.n, 'w', own.w, 'e', round(own.e::numeric, 4), 'v', round(own.v::numeric, 4),
      'siteW', site.w, 'siteE', round(site.e::numeric, 4), 'seen', feed.seen, 'gold', feed.gold) order by own.ts)
    from own left join site on site.ts = own.ts left join feed on feed.ts = own.ts
    where own.n > 0
  ), '[]'::jsonb));
  return out;
end
$$;
-- After a few calls PL/pgSQL switches to a generic plan, which does not know the range and took 12 to 35 s here
-- (0.5 s with a plan made for each call's own values).
alter function public.monitor_shared(bigint, bigint, bigint) set plan_cache_mode = 'force_custom_plan';
revoke all on function public.monitor_shared(bigint, bigint, bigint) from public, anon;
grant execute on function public.monitor_shared(bigint, bigint, bigint) to authenticated;

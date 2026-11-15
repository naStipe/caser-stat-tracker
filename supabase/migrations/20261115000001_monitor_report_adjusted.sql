-- Pulse monitor: monitor_report against the normal rate (see 20261115000000_monitor_derive.sql), without the
-- rows next to each player's discovery, with session phases and the rows' arrival lag. Every field of
-- 20261114000006 stays (w/ew/vw are still against the shown chance), so a page of an older version keeps working.

create or replace function public.monitor_report(from_ms bigint, to_ms bigint, bucket_ms bigint, tz_offset_min integer default 0)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  base_from bigint := least(from_ms, to_ms - 7::bigint * 86400000);
  off_ms bigint := tz_offset_min::bigint * 60000;
  out jsonb;
begin
  if not public.monitor_is_viewer() then raise exception 'not allowed' using errcode = '42501'; end if;
  if bucket_ms < 60000 or to_ms - from_ms > 92::bigint * 86400000 or (to_ms - from_ms) / bucket_ms > 6000 or abs(tz_offset_min) > 900 then
    raise exception 'range or bucket out of bounds';
  end if;

  with cb as (
    select p.slug, count(*) as n, sum((p.returned >= p.stake)::int) as h
    from public.monitor_rows p
    where p.kind = 'case' and p.slug is not null and p.ts >= base_from and p.ts < to_ms and p.stake > 0 and not coalesce(p.near, false)
    group by p.slug
  ), g as (
    select coalesce(sum(cb.h)::double precision / nullif(sum(cb.n), 0), 0.35) as rate from cb
  ), q as (
    select cb.slug, (cb.h + 20 * g.rate) / (cb.n + 20) as q from cb, g
  ), cal as (
    select c.band, c.phase, (c.w + 10)::double precision / (c.ew + 10) as f from public.monitor_cal c
  ), r as (
    select
      from_ms + ((p.ts - from_ms) / bucket_ms) * bucket_ms as b,
      p.kind, p.u, p.slug, p.stake as x, p.returned as y, p.phase,
      extract(isodow from to_timestamp((p.ts + off_ms) / 1000.0) at time zone 'UTC')::int as dow,
      extract(hour from to_timestamp((p.ts + off_ms) / 1000.0) at time zone 'UTC')::int as hr,
      case when p.kind = 'upgrade' and p.chance > 0 and p.chance <= 100 then p.chance / 100.0 end as pe,
      case when p.kind = 'upgrade' and p.chance > 0 and p.chance <= 100 then coalesce(p.won, p.returned > 0)::int end as w,
      -- Rows the cron job has not reached yet (the last minute or so) are expected at the shown chance.
      case when p.kind = 'upgrade' and p.chance > 0 and p.chance <= 100 then least(0.99, p.chance / 100.0 * coalesce(c.f, 1)) end as ea,
      case when p.kind = 'case' then q.q end as qe,
      case when p.kind = 'case' and q.q is not null then (p.returned >= p.stake)::int end as hit,
      case when p.kind = 'upgrade' then public.monitor_band(p.chance) end as band,
      case when p.kind = 'upgrade' and p.chance > 0 and p.chance <= 100 then
        case when p.chance < 15 then 1 when p.chance < 35 then 2 else 3 end end as cg,
      case when p.stake < 100 then 1 when p.stake < 1000 then 2 when p.stake < 10000 then 3 else 4 end as sb
    from public.monitor_rows p
    left join q on p.kind = 'case' and q.slug = p.slug
    left join cal c on p.kind = 'upgrade' and c.band = public.monitor_band(p.chance) and c.phase = p.phase
    where p.ts >= from_ms and p.ts < to_ms and p.stake > 0 and not coalesce(p.near, false)
  ), pb as (
    -- per player per window: for the clustered error and for players in profit
    select r.b, r.kind, r.u, sum(r.x) as x, sum(r.y) as y from r group by r.b, r.kind, r.u
  ), series as (
    select r.b, r.kind, count(*) as n, sum(r.x) as sx, sum(r.y) as sy,
           count(r.pe) as nw, sum(r.w) as w, sum(r.pe) as ew, sum(r.pe * (1 - r.pe)) as vw,
           sum(r.ea) as ea, sum(r.ea * (1 - r.ea)) as va,
           count(r.qe) as nh, sum(r.hit) as h, sum(r.qe) as eh, sum(r.qe * (1 - r.qe)) as vh
    from r group by r.b, r.kind
  ), pbs as (
    select pb.b, pb.kind, count(*) as players, sum((pb.y > pb.x)::int) as up,
           sum(pb.x * pb.x) as gxx, sum(pb.y * pb.y) as gyy, sum(pb.x * pb.y) as gxy
    from pb group by pb.b, pb.kind
  )
  select jsonb_build_object(
    'series', coalesce((
      select jsonb_agg(jsonb_build_object(
        'bucket', s.b, 'kind', s.kind, 'n', s.n, 'players', t.players, 'up', t.up,
        'sx', s.sx, 'sy', s.sy, 'gxx', t.gxx, 'gyy', t.gyy, 'gxy', t.gxy,
        'nw', s.nw, 'w', s.w, 'ew', s.ew, 'vw', s.vw, 'ea', s.ea, 'va', s.va,
        'nh', s.nh, 'h', s.h, 'eh', s.eh, 'vh', s.vh
      ) order by s.b, s.kind)
      from series s join pbs t on t.b = s.b and t.kind = s.kind), '[]'::jsonb),
    'heat', coalesce((
      select jsonb_agg(jsonb_build_object(
        'dow', h.dow, 'hour', h.hr, 'kind', h.kind, 'n', h.n, 'sx', h.sx, 'sy', h.sy,
        'nw', h.nw, 'w', h.w, 'ew', h.ew, 'vw', h.vw, 'ea', h.ea, 'va', h.va, 'nh', h.nh, 'h', h.h, 'eh', h.eh, 'vh', h.vh))
      from (
        select r.dow, r.hr, r.kind, count(*) as n, sum(r.x) as sx, sum(r.y) as sy,
               count(r.pe) as nw, sum(r.w) as w, sum(r.pe) as ew, sum(r.pe * (1 - r.pe)) as vw,
               sum(r.ea) as ea, sum(r.ea * (1 - r.ea)) as va,
               count(r.qe) as nh, sum(r.hit) as h, sum(r.qe) as eh, sum(r.qe * (1 - r.qe)) as vh
        from r group by r.dow, r.hr, r.kind
      ) h), '[]'::jsonb),
    'bands', coalesce((
      select jsonb_agg(jsonb_build_object(
        'band', d.band, 'n', d.n, 'players', d.players, 'sx', d.sx, 'sy', d.sy, 'w', d.w, 'ew', d.ew, 'vw', d.vw, 'ea', d.ea, 'va', d.va) order by d.band)
      from (
        select r.band, count(*) as n, count(distinct r.u) as players, sum(r.x) as sx, sum(r.y) as sy,
               sum(r.w) as w, sum(r.pe) as ew, sum(r.pe * (1 - r.pe)) as vw, sum(r.ea) as ea, sum(r.ea * (1 - r.ea)) as va
        from r where r.band is not null group by r.band
      ) d), '[]'::jsonb),
    -- Upgrades by session phase and chance group (1: under 15%, 2: 15-35%, 3: 35% and up), in the range...
    'phases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'phase', d.phase, 'cg', d.cg, 'n', d.n, 'players', d.players, 'sx', d.sx, 'sy', d.sy,
        'w', d.w, 'ew', d.ew, 'vw', d.vw, 'ea', d.ea, 'va', d.va) order by d.phase, d.cg)
      from (
        select r.phase, r.cg, count(*) as n, count(distinct r.u) as players, sum(r.x) as sx, sum(r.y) as sy,
               sum(r.w) as w, sum(r.pe) as ew, sum(r.pe * (1 - r.pe)) as vw, sum(r.ea) as ea, sum(r.ea * (1 - r.ea)) as va
        from r where r.pe is not null and r.phase is not null group by r.phase, r.cg
      ) d), '[]'::jsonb),
    -- ...and over the last 7 days (the normal "ea" comes from).
    'phases_norm', coalesce((
      select jsonb_agg(jsonb_build_object('phase', d.phase, 'cg', d.cg, 'n', d.n, 'w', d.w, 'ew', d.ew) order by d.phase, d.cg)
      from (
        select c.phase, case when c.band in ('a', 'b') then 1 when c.band in ('c', 'd') then 2 else 3 end as cg,
               sum(c.n) as n, sum(c.w) as w, sum(c.ew) as ew
        from public.monitor_cal c group by 1, 2
      ) d), '[]'::jsonb),
    'cases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'slug', c.slug, 'n', c.n, 'players', c.players, 'sx', c.sx, 'sy', c.sy, 'h', c.h, 'eh', c.eh, 'vh', c.vh, 'price', c.price) order by c.n desc)
      from (
        select r.slug, count(*) as n, count(distinct r.u) as players, sum(r.x) as sx, sum(r.y) as sy,
               sum(r.hit) as h, sum(r.qe) as eh, sum(r.qe * (1 - r.qe)) as vh, max(r.x) as price
        from r where r.kind = 'case' and r.slug is not null group by r.slug
        order by count(*) desc limit 60
      ) c), '[]'::jsonb),
    'stakes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', k.kind, 'sb', k.sb, 'n', k.n, 'players', k.players, 'sx', k.sx, 'sy', k.sy,
        'nw', k.nw, 'w', k.w, 'ew', k.ew, 'vw', k.vw, 'ea', k.ea, 'va', k.va, 'nh', k.nh, 'h', k.h, 'eh', k.eh, 'vh', k.vh) order by k.kind, k.sb)
      from (
        select r.kind, r.sb, count(*) as n, count(distinct r.u) as players, sum(r.x) as sx, sum(r.y) as sy,
               count(r.pe) as nw, sum(r.w) as w, sum(r.pe) as ew, sum(r.pe * (1 - r.pe)) as vw,
               sum(r.ea) as ea, sum(r.ea * (1 - r.ea)) as va,
               count(r.qe) as nh, sum(r.hit) as h, sum(r.qe) as eh, sum(r.qe * (1 - r.qe)) as vh
        from r group by r.kind, r.sb
      ) k), '[]'::jsonb),
    'totals', coalesce((
      select jsonb_agg(jsonb_build_object('kind', z.kind, 'players', z.players, 'up', z.up) order by z.kind)
      from (
        select pt.kind, count(*) as players, sum((pt.y > pt.x)::int) as up
        from (select r.kind, r.u, sum(r.x) as x, sum(r.y) as y from r group by r.kind, r.u) pt
        group by pt.kind
      ) z), '[]'::jsonb),
    -- Rows in the range left out because they sit next to the player's discovery.
    'excluded', coalesce((
      select jsonb_agg(jsonb_build_object('kind', e.kind, 'n', e.n))
      from (
        select p.kind, count(*) as n from public.monitor_rows p
        where p.ts >= from_ms and p.ts < to_ms and p.stake > 0 and p.near group by p.kind
      ) e), '[]'::jsonb),
    -- How long after they happen rows arrive, from rows 6 to 24 hours old (late ones counted up to 6 hours).
    'lag', (
      select jsonb_build_object('rows', count(*),
        'p50', percentile_cont(0.5) within group (order by l.lag),
        'p80', percentile_cont(0.8) within group (order by l.lag),
        'p90', percentile_cont(0.9) within group (order by l.lag))
      from (
        select greatest(0, m.added - m.ts) as lag
        from public.monitor_rows m
        where m.added is not null and m.ts >= to_ms - 24::bigint * 3600000 and m.ts < to_ms - 6::bigint * 3600000
          and m.added - m.ts <= 6::bigint * 3600000
      ) l)
  ) into out;
  return out;
end
$$;

revoke all on function public.monitor_report(bigint, bigint, bigint, integer) from public, anon;
grant execute on function public.monitor_report(bigint, bigint, bigint, integer) to authenticated;

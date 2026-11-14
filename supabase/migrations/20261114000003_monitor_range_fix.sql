-- The range checks in monitor_agg and monitor_volume_agg overflowed a 32-bit integer (92 * 86400000).

create or replace function public.monitor_agg(from_ms bigint, to_ms bigint, bucket_ms bigint)
returns table (bucket bigint, kind text, n bigint, players bigint,
               sx double precision, sy double precision, sxx double precision, syy double precision, sxy double precision,
               gxx double precision, gyy double precision, gxy double precision)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not public.monitor_is_viewer() then raise exception 'not allowed' using errcode = '42501'; end if;
  if bucket_ms < 60000 or to_ms - from_ms > 92::bigint * 86400000 or (to_ms - from_ms) / bucket_ms > 5000 then
    raise exception 'range or bucket out of bounds';
  end if;
  return query
  with r as (
    select from_ms + ((p.ts - from_ms) / bucket_ms) * bucket_ms as b, p.kind as k, p.u, p.stake as x, p.returned as y
    from public.monitor_rows p
    where p.ts >= from_ms and p.ts < to_ms and p.stake > 0
  ), g as (
    select r.b, r.k, r.u, sum(r.x) as x, sum(r.y) as y from r group by r.b, r.k, r.u
  ), rs as (
    select r.b, r.k, count(*) as n, sum(r.x) as sx, sum(r.y) as sy, sum(r.x * r.x) as sxx, sum(r.y * r.y) as syy, sum(r.x * r.y) as sxy
    from r group by r.b, r.k
  ), gs as (
    select g.b, g.k, count(*) as players, sum(g.x * g.x) as gxx, sum(g.y * g.y) as gyy, sum(g.x * g.y) as gxy
    from g group by g.b, g.k
  )
  select rs.b, rs.k, rs.n, gs.players, rs.sx, rs.sy, rs.sxx, rs.syy, rs.sxy, gs.gxx, gs.gyy, gs.gxy
  from rs join gs on gs.b = rs.b and gs.k = rs.k
  order by rs.b, rs.k;
end
$$;

-- Site-wide activity per time bucket from the counter samples: growth per minute and average online.
create or replace function public.monitor_volume_agg(from_ms bigint, to_ms bigint, bucket_ms bigint)
returns table (bucket bigint, samples bigint, cases_per_min double precision, upgrades_per_min double precision, online double precision)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not public.monitor_is_viewer() then raise exception 'not allowed' using errcode = '42501'; end if;
  if bucket_ms < 60000 or to_ms - from_ms > 92::bigint * 86400000 or (to_ms - from_ms) / bucket_ms > 5000 then
    raise exception 'range or bucket out of bounds';
  end if;
  return query
  with v as (
    select from_ms + ((m.ts - from_ms) / bucket_ms) * bucket_ms as b, m.ts, m.cases, m.upgrades, m.online
    from public.monitor_volume m
    where m.ts >= from_ms and m.ts < to_ms
  ), e as (
    select v.b, count(*) as samples, min(v.ts) as t0, max(v.ts) as t1,
           (array_agg(v.cases order by v.ts))[1] as c0, (array_agg(v.cases order by v.ts desc))[1] as c1,
           (array_agg(v.upgrades order by v.ts))[1] as u0, (array_agg(v.upgrades order by v.ts desc))[1] as u1,
           avg(v.online)::double precision as online
    from v group by v.b
  )
  select e.b, e.samples,
         case when e.t1 > e.t0 and e.c1 >= e.c0 then (e.c1 - e.c0)::double precision / ((e.t1 - e.t0) / 60000.0) end,
         case when e.t1 > e.t0 and e.u1 >= e.u0 then (e.u1 - e.u0)::double precision / ((e.t1 - e.t0) / 60000.0) end,
         e.online
  from e order by e.b;
end
$$;

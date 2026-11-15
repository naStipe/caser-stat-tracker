-- Pulse monitor: keep running totals, and keep raw rows for 9 days only.
--
-- Why. The monitor stores about 275,000 rows a day. Every page load recomputed everything from them, one row at
-- a time: the 7-day report took 2.6 s on 340,000 rows and would take about 15 s at a full week, past Supabase's
-- 8 s limit, and 30 days of rows would be about 2.5 GB.
--
-- What. monitor_hourly holds sums per half hour ("slot"), player, kind, chance band, session phase, stake size
-- and case: about 13,000 cells a day, 20 times fewer than rows. It has everything the reports use (counts, staked,
-- returned, wins, the shown chances and their squares, case hits), and the player in each cell, so per-player
-- errors, distinct players and "players up" stay exact for any window of whole half hours.
-- monitor_hourly_near counts the rows left out next to a player's discovery.
--
-- How it stays right. Statement triggers on monitor_rows add every inserted row and, on update, take the old
-- version out and put the new one in. So rows that arrive late, rows read again, and the phase and discovery
-- marks that monitor_derive() fills in a minute later all land in the totals; nothing waits for a batch job.
-- There is no delete trigger: deleting old raw rows leaves the totals as they are.
--
-- Reports. monitor_report and monitor_window_sums read the totals when the range and windows are whole half
-- hours (the 7-day report, 3 days and longer, 30 and 60-minute checks), and the raw rows otherwise (5 to 20-minute
-- windows over at most a day). One difference: from the totals, the normal rate is the shown chance times the
-- band and phase factor without the 99% cap per row, which only moves upgrades shown above about 95%.
--
-- Ranges over 8 days read monitor_6h and monitor_6h_u instead: the same sums per 6 hours without the player
-- split, and per player alone, about 2,000 rows a day.
--
-- Retention. monitor_prune() runs every hour and deletes raw rows older than 9 days: the reports' 7-day baseline
-- and the monitor's 7-day history reads stay inside them. The totals are kept.

create table if not exists public.monitor_hourly (
  slot bigint not null,          -- start of the half hour, ms since 1970
  kind text not null,
  u text not null,
  band text not null,            -- upgrades: chance band a-g, '' without a usable chance; cases: ''
  phase smallint not null,       -- upgrades: session phase 0-4, -1 not derived yet; cases: -1
  sb smallint not null,          -- stake size 1-4
  slug text not null,            -- cases: the case, '' unknown; upgrades: ''
  n bigint not null default 0,
  x double precision not null default 0,     -- staked
  y double precision not null default 0,     -- returned
  smax double precision not null default 0,  -- largest stake (the case price)
  nw bigint not null default 0,              -- upgrades with a shown chance in (0, 100]
  w bigint not null default 0,               -- their wins
  pe double precision not null default 0,    -- sum of their shown chances (0-1)
  pe2 double precision not null default 0,   -- sum of the squares
  hits bigint not null default 0,            -- cases worth at least the price
  primary key (slot, kind, u, band, phase, sb, slug)
);
create table if not exists public.monitor_hourly_near (
  slot bigint not null,
  kind text not null,
  n bigint not null default 0,
  primary key (slot, kind)
);
-- The same sums per 6 hours, without the player (monitor_6h), and per 6 hours and player (monitor_6h_u), for
-- ranges over 8 days: about 2,000 rows a day instead of 13,000, so 30 days stay fast.
create table if not exists public.monitor_6h (
  slot bigint not null,
  kind text not null,
  band text not null,
  phase smallint not null,
  sb smallint not null,
  slug text not null,
  n bigint not null default 0,
  x double precision not null default 0,
  y double precision not null default 0,
  smax double precision not null default 0,
  nw bigint not null default 0,
  w bigint not null default 0,
  pe double precision not null default 0,
  pe2 double precision not null default 0,
  hits bigint not null default 0,
  primary key (slot, kind, band, phase, sb, slug)
);
create table if not exists public.monitor_6h_u (
  slot bigint not null,
  kind text not null,
  u text not null,
  x double precision not null default 0,
  y double precision not null default 0,
  primary key (slot, kind, u)
);
alter table public.monitor_hourly enable row level security;
alter table public.monitor_hourly_near enable row level security;
alter table public.monitor_6h enable row level security;
alter table public.monitor_6h_u enable row level security;
revoke all on public.monitor_hourly, public.monitor_hourly_near, public.monitor_6h, public.monitor_6h_u from anon, authenticated;

-- One statement's rows in or out of the totals: src is a query of (sg, monitor_rows columns...), sg 1 to add, -1 to
-- take out. The trigger passes its transition tables by name; EXECUTE sees them.
create or replace function public.monitor_hourly_apply() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  src text := case when tg_op = 'INSERT' then 'select 1 as sg, t.* from nt t'
                   else 'select -1 as sg, t.* from ot t union all select 1 as sg, t.* from nt t' end;
begin
  execute format($q$
    insert into public.monitor_hourly as m (slot, kind, u, band, phase, sb, slug, n, x, y, smax, nw, w, pe, pe2, hits)
    select k.slot, k.kind, k.u, k.band, k.phase, k.sb, k.slug,
           sum(k.sg), sum(k.sg * k.stake), sum(k.sg * k.returned), max(k.stake),
           sum(k.sg * k.valid), sum(k.sg * k.win), sum(k.sg * k.p), sum(k.sg * k.p * k.p), sum(k.sg * k.hit)
    from (
      select d.sg, (d.ts / 1800000) * 1800000 as slot, d.kind, d.u,
        case when d.kind = 'upgrade' then coalesce(public.monitor_band(d.chance), '') else '' end as band,
        (case when d.kind = 'upgrade' then coalesce(d.phase, -1) else -1 end)::smallint as phase,
        (case when d.stake < 100 then 1 when d.stake < 1000 then 2 when d.stake < 10000 then 3 else 4 end)::smallint as sb,
        case when d.kind = 'case' then coalesce(d.slug, '') else '' end as slug,
        d.stake, d.returned,
        coalesce(d.kind = 'upgrade' and d.chance > 0 and d.chance <= 100, false)::int as valid,
        case when d.kind = 'upgrade' and d.chance > 0 and d.chance <= 100 then coalesce(d.won, d.returned > 0)::int else 0 end as win,
        case when d.kind = 'upgrade' and d.chance > 0 and d.chance <= 100 then d.chance / 100.0 else 0 end as p,
        coalesce(d.kind = 'case' and d.returned >= d.stake, false)::int as hit
      from (%1$s) d
      where d.stake > 0 and not coalesce(d.near, false)
    ) k
    group by 1, 2, 3, 4, 5, 6, 7
    order by 1, 2, 3, 4, 5, 6, 7
    on conflict (slot, kind, u, band, phase, sb, slug) do update set
      n = m.n + excluded.n, x = m.x + excluded.x, y = m.y + excluded.y, smax = greatest(m.smax, excluded.smax),
      nw = m.nw + excluded.nw, w = m.w + excluded.w, pe = m.pe + excluded.pe, pe2 = m.pe2 + excluded.pe2, hits = m.hits + excluded.hits
  $q$, src);

  execute format($q$
    insert into public.monitor_6h as m (slot, kind, band, phase, sb, slug, n, x, y, smax, nw, w, pe, pe2, hits)
    select k.slot, k.kind, k.band, k.phase, k.sb, k.slug,
           sum(k.sg), sum(k.sg * k.stake), sum(k.sg * k.returned), max(k.stake),
           sum(k.sg * k.valid), sum(k.sg * k.win), sum(k.sg * k.p), sum(k.sg * k.p * k.p), sum(k.sg * k.hit)
    from (
      select d.sg, (d.ts / 21600000) * 21600000 as slot, d.kind,
        case when d.kind = 'upgrade' then coalesce(public.monitor_band(d.chance), '') else '' end as band,
        (case when d.kind = 'upgrade' then coalesce(d.phase, -1) else -1 end)::smallint as phase,
        (case when d.stake < 100 then 1 when d.stake < 1000 then 2 when d.stake < 10000 then 3 else 4 end)::smallint as sb,
        case when d.kind = 'case' then coalesce(d.slug, '') else '' end as slug,
        d.stake, d.returned,
        coalesce(d.kind = 'upgrade' and d.chance > 0 and d.chance <= 100, false)::int as valid,
        case when d.kind = 'upgrade' and d.chance > 0 and d.chance <= 100 then coalesce(d.won, d.returned > 0)::int else 0 end as win,
        case when d.kind = 'upgrade' and d.chance > 0 and d.chance <= 100 then d.chance / 100.0 else 0 end as p,
        coalesce(d.kind = 'case' and d.returned >= d.stake, false)::int as hit
      from (%1$s) d
      where d.stake > 0 and not coalesce(d.near, false)
    ) k
    group by 1, 2, 3, 4, 5, 6
    order by 1, 2, 3, 4, 5, 6
    on conflict (slot, kind, band, phase, sb, slug) do update set
      n = m.n + excluded.n, x = m.x + excluded.x, y = m.y + excluded.y, smax = greatest(m.smax, excluded.smax),
      nw = m.nw + excluded.nw, w = m.w + excluded.w, pe = m.pe + excluded.pe, pe2 = m.pe2 + excluded.pe2, hits = m.hits + excluded.hits
  $q$, src);

  execute format($q$
    insert into public.monitor_6h_u as m (slot, kind, u, x, y)
    select (d.ts / 21600000) * 21600000, d.kind, d.u, sum(d.sg * d.stake), sum(d.sg * d.returned)
    from (%1$s) d
    where d.stake > 0 and not coalesce(d.near, false)
    group by 1, 2, 3 order by 1, 2, 3
    on conflict (slot, kind, u) do update set x = m.x + excluded.x, y = m.y + excluded.y
  $q$, src);

  execute format($q$
    insert into public.monitor_hourly_near as m (slot, kind, n)
    select (d.ts / 1800000) * 1800000, d.kind, sum(d.sg)
    from (%1$s) d
    where d.stake > 0 and coalesce(d.near, false)
    group by 1, 2 order by 1, 2
    on conflict (slot, kind) do update set n = m.n + excluded.n
  $q$, src);
  return null;
end
$$;
revoke all on function public.monitor_hourly_apply() from public, anon, authenticated;

-- Fill the totals from the rows already stored, with writes held off so nothing is counted twice or missed.
lock table public.monitor_rows in share row exclusive mode;
delete from public.monitor_hourly;
delete from public.monitor_hourly_near;

insert into public.monitor_hourly (slot, kind, u, band, phase, sb, slug, n, x, y, smax, nw, w, pe, pe2, hits)
select k.slot, k.kind, k.u, k.band, k.phase, k.sb, k.slug,
       count(*), sum(k.stake), sum(k.returned), max(k.stake), sum(k.valid), sum(k.win), sum(k.p), sum(k.p * k.p), sum(k.hit)
from (
  select (d.ts / 1800000) * 1800000 as slot, d.kind, d.u,
    case when d.kind = 'upgrade' then coalesce(public.monitor_band(d.chance), '') else '' end as band,
    (case when d.kind = 'upgrade' then coalesce(d.phase, -1) else -1 end)::smallint as phase,
    (case when d.stake < 100 then 1 when d.stake < 1000 then 2 when d.stake < 10000 then 3 else 4 end)::smallint as sb,
    case when d.kind = 'case' then coalesce(d.slug, '') else '' end as slug,
    d.stake, d.returned,
    coalesce(d.kind = 'upgrade' and d.chance > 0 and d.chance <= 100, false)::int as valid,
    case when d.kind = 'upgrade' and d.chance > 0 and d.chance <= 100 then coalesce(d.won, d.returned > 0)::int else 0 end as win,
    case when d.kind = 'upgrade' and d.chance > 0 and d.chance <= 100 then d.chance / 100.0 else 0 end as p,
    coalesce(d.kind = 'case' and d.returned >= d.stake, false)::int as hit
  from public.monitor_rows d
  where d.stake > 0 and not coalesce(d.near, false)
) k
group by 1, 2, 3, 4, 5, 6, 7;

insert into public.monitor_hourly_near (slot, kind, n)
select (d.ts / 1800000) * 1800000, d.kind, count(*)
from public.monitor_rows d where d.stake > 0 and coalesce(d.near, false) group by 1, 2;

delete from public.monitor_6h;
delete from public.monitor_6h_u;
insert into public.monitor_6h (slot, kind, band, phase, sb, slug, n, x, y, smax, nw, w, pe, pe2, hits)
select (h.slot / 21600000) * 21600000, h.kind, h.band, h.phase, h.sb, h.slug,
       sum(h.n), sum(h.x), sum(h.y), max(h.smax), sum(h.nw), sum(h.w), sum(h.pe), sum(h.pe2), sum(h.hits)
from public.monitor_hourly h group by 1, 2, 3, 4, 5, 6;
insert into public.monitor_6h_u (slot, kind, u, x, y)
select (h.slot / 21600000) * 21600000, h.kind, h.u, sum(h.x), sum(h.y)
from public.monitor_hourly h group by 1, 2, 3;

drop trigger if exists monitor_hourly_ins on public.monitor_rows;
drop trigger if exists monitor_hourly_upd on public.monitor_rows;
create trigger monitor_hourly_ins after insert on public.monitor_rows
  referencing new table as nt for each statement execute function public.monitor_hourly_apply();
create trigger monitor_hourly_upd after update on public.monitor_rows
  referencing old table as ot new table as nt for each statement execute function public.monitor_hourly_apply();

-- The raw-row reports keep their code under new names; monitor_report and monitor_window_sums now choose.
alter function public.monitor_report(bigint, bigint, bigint, integer) rename to monitor_report_raw;
alter function public.monitor_window_sums(bigint, bigint, bigint) rename to monitor_window_sums_raw;
revoke all on function public.monitor_report_raw(bigint, bigint, bigint, integer), public.monitor_window_sums_raw(bigint, bigint, bigint) from public, anon, authenticated;

-- monitor_report from the totals: the same fields as monitor_report_raw (20261115000005).
create or replace function public.monitor_report_rolled(from_ms bigint, to_ms bigint, bucket_ms bigint, tz_offset_min integer default 0)
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
  if bucket_ms < 60000 or to_ms - from_ms > 400::bigint * 86400000 or (to_ms - from_ms) / bucket_ms > 6000 or abs(tz_offset_min) > 900 then
    raise exception 'range or bucket out of bounds';
  end if;

  with cb as (
    select h.slug, sum(h.n) as n, sum(h.hits) as h
    from public.monitor_hourly h
    where h.kind = 'case' and h.slug <> '' and h.slot >= base_from and h.slot < to_ms
    group by h.slug
  ), g as (
    select coalesce(sum(cb.h)::double precision / nullif(sum(cb.n), 0), 0.35) as rate from cb
  ), q as (
    select cb.slug, (cb.h + 20 * g.rate) / (cb.n + 20) as q from cb, g
  ), cal as (
    select c.band, c.phase, (c.w + 10)::double precision / (c.ew + 10) as f from public.monitor_cal c
  ), r as (
    select
      from_ms + ((h.slot - from_ms) / bucket_ms) * bucket_ms as b,
      h.kind, h.u, nullif(h.slug, '') as slug, nullif(h.band, '') as band,
      case when h.kind = 'upgrade' and h.phase >= 0 then h.phase end as phase, h.sb,
      h.n as cnt, h.x, h.y, h.smax, h.nw, h.w, h.pe, h.pe2,
      coalesce(c.f, 1) * h.pe as ea,
      coalesce(c.f, 1) * h.pe - coalesce(c.f, 1) * coalesce(c.f, 1) * h.pe2 as va,
      case when q.q is not null then h.n else 0 end as nh,
      case when q.q is not null then h.hits else 0 end as hit,
      coalesce(q.q * h.n, 0) as eh,
      coalesce(q.q * (1 - q.q) * h.n, 0) as vh,
      ((h.slot + off_ms) / 86400000) * 86400000 - off_ms as day,
      (((h.slot + off_ms) / 86400000 + 3) % 7 + 1)::int as dow,
      (((h.slot + off_ms) % 86400000) / 3600000)::int as hr,
      case when h.band in ('a', 'b') then 1 when h.band in ('c', 'd') then 2 when h.band in ('e', 'f', 'g') then 3 end as cg
    from public.monitor_hourly h
    left join q on h.kind = 'case' and q.slug = h.slug
    left join cal c on h.kind = 'upgrade' and c.band = h.band and c.phase = h.phase
    where h.slot >= from_ms and h.slot < to_ms and h.n > 0
  ), pb as (
    select r.b, r.kind, r.u, sum(r.x) as x, sum(r.y) as y from r group by r.b, r.kind, r.u
  ), series as (
    select r.b, r.kind, sum(r.cnt) as n, sum(r.x) as sx, sum(r.y) as sy,
           sum(r.nw) as nw, sum(r.w) as w, sum(r.pe) as ew, sum(r.pe) - sum(r.pe2) as vw,
           sum(r.ea) as ea, sum(r.va) as va,
           sum(r.nh) as nh, sum(r.hit) as h, sum(r.eh) as eh, sum(r.vh) as vh
    from r group by r.b, r.kind
  ), pbs as (
    select pb.b, pb.kind, count(*) as players, sum((pb.y > pb.x)::int) as up,
           sum(pb.x * pb.x) as gxx, sum(pb.y * pb.y) as gyy, sum(pb.x * pb.y) as gxy
    from pb group by pb.b, pb.kind
  ), pu as (
    -- Distinct players per group, counted by hashing (player, group) pairs: much faster than count(distinct).
    select r.kind, r.u, r.band, r.phase, r.cg, r.slug, r.sb, sum(r.nw) as nw from r group by r.kind, r.u, r.band, r.phase, r.cg, r.slug, r.sb
  ), p_band as (
    select x.band, count(*) as players from (select distinct pu.band, pu.u from pu where pu.band is not null) x group by x.band
  ), p_phase as (
    select x.phase, x.cg, count(*) as players from (select distinct pu.phase, pu.cg, pu.u from pu where pu.nw > 0 and pu.phase is not null and pu.cg is not null) x group by x.phase, x.cg
  ), p_case as (
    select x.slug, count(*) as players from (select distinct pu.slug, pu.u from pu where pu.kind = 'case' and pu.slug is not null) x group by x.slug
  ), p_stake as (
    select x.kind, x.sb, count(*) as players from (select distinct pu.kind, pu.sb, pu.u from pu) x group by x.kind, x.sb
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
        select r.dow, r.hr, r.kind, sum(r.cnt) as n, sum(r.x) as sx, sum(r.y) as sy,
               sum(r.nw) as nw, sum(r.w) as w, sum(r.pe) as ew, sum(r.pe) - sum(r.pe2) as vw,
               sum(r.ea) as ea, sum(r.va) as va,
               sum(r.nh) as nh, sum(r.hit) as h, sum(r.eh) as eh, sum(r.vh) as vh
        from r group by r.dow, r.hr, r.kind
      ) h), '[]'::jsonb),
    'bands', coalesce((
      select jsonb_agg(jsonb_build_object(
        'band', d.band, 'n', d.n, 'players', d.players, 'sx', d.sx, 'sy', d.sy, 'w', d.w, 'ew', d.ew, 'vw', d.vw, 'ea', d.ea, 'va', d.va) order by d.band)
      from (
        select a.*, pp.players from (
          select r.band, sum(r.cnt) as n, sum(r.x) as sx, sum(r.y) as sy,
                 sum(r.w) as w, sum(r.pe) as ew, sum(r.pe) - sum(r.pe2) as vw, sum(r.ea) as ea, sum(r.va) as va
          from r where r.band is not null group by r.band
        ) a join p_band pp on pp.band = a.band
      ) d), '[]'::jsonb),
    'phases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'phase', d.phase, 'cg', d.cg, 'n', d.n, 'players', d.players, 'sx', d.sx, 'sy', d.sy,
        'w', d.w, 'ew', d.ew, 'vw', d.vw, 'ea', d.ea, 'va', d.va) order by d.phase, d.cg)
      from (
        select a.*, pp.players from (
          select r.phase, r.cg, sum(r.nw) as n, sum(r.x) as sx, sum(r.y) as sy,
                 sum(r.w) as w, sum(r.pe) as ew, sum(r.pe) - sum(r.pe2) as vw, sum(r.ea) as ea, sum(r.va) as va
          from r where r.nw > 0 and r.phase is not null and r.cg is not null group by r.phase, r.cg
        ) a join p_phase pp on pp.phase = a.phase and pp.cg = a.cg
      ) d), '[]'::jsonb),
    'phases_norm', coalesce((
      select jsonb_agg(jsonb_build_object('phase', d.phase, 'cg', d.cg, 'n', d.n, 'w', d.w, 'ew', d.ew) order by d.phase, d.cg)
      from (
        select c.phase, case when c.band in ('a', 'b') then 1 when c.band in ('c', 'd') then 2 else 3 end as cg,
               sum(c.n) as n, sum(c.w) as w, sum(c.ew) as ew
        from public.monitor_cal c group by 1, 2
      ) d), '[]'::jsonb),
    'situations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'band', d.band, 'phase', d.phase, 'n', d.n, 'players', d.players, 'sx', d.sx, 'sy', d.sy,
        'w', d.w, 'ew', d.ew, 'vw', d.vw, 'ea', d.ea, 'gxx', d.gxx, 'gyy', d.gyy, 'gxy', d.gxy) order by d.band, d.phase)
      from (
        select pc.band, pc.phase, sum(pc.n) as n, count(*) as players, sum(pc.x) as sx, sum(pc.y) as sy,
               sum(pc.w) as w, sum(pc.ew) as ew, sum(pc.vw) as vw, sum(pc.ea) as ea,
               sum(pc.x * pc.x) as gxx, sum(pc.y * pc.y) as gyy, sum(pc.x * pc.y) as gxy
        from (
          select r.band, r.phase, r.u, sum(r.nw) as n, sum(r.x) as x, sum(r.y) as y,
                 sum(r.w) as w, sum(r.pe) as ew, sum(r.pe) - sum(r.pe2) as vw, sum(r.ea) as ea
          from r where r.nw > 0 and r.phase is not null group by r.band, r.phase, r.u
        ) pc
        group by pc.band, pc.phase
      ) d), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object('day', d.day, 'phase', d.phase, 'cg', d.cg, 'n', d.n, 'w', d.w, 'ew', d.ew, 'vw', d.vw, 'sx', d.sx, 'sy', d.sy) order by d.day, d.phase, d.cg)
      from (
        select r.day, r.phase, r.cg, sum(r.nw) as n, sum(r.w) as w, sum(r.pe) as ew, sum(r.pe) - sum(r.pe2) as vw, sum(r.x) as sx, sum(r.y) as sy
        from r where r.nw > 0 and r.phase is not null and r.cg is not null group by r.day, r.phase, r.cg
      ) d), '[]'::jsonb),
    'cases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'slug', c.slug, 'n', c.n, 'players', c.players, 'sx', c.sx, 'sy', c.sy, 'h', c.h, 'eh', c.eh, 'vh', c.vh, 'price', c.price) order by c.n desc)
      from (
        select a.*, pp.players from (
          select r.slug, sum(r.cnt) as n, sum(r.x) as sx, sum(r.y) as sy,
                 sum(r.hit) as h, sum(r.eh) as eh, sum(r.vh) as vh, max(r.smax) as price
          from r where r.kind = 'case' and r.slug is not null group by r.slug
          order by sum(r.cnt) desc limit 60
        ) a join p_case pp on pp.slug = a.slug
      ) c), '[]'::jsonb),
    'stakes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', k.kind, 'sb', k.sb, 'n', k.n, 'players', k.players, 'sx', k.sx, 'sy', k.sy,
        'nw', k.nw, 'w', k.w, 'ew', k.ew, 'vw', k.vw, 'ea', k.ea, 'va', k.va, 'nh', k.nh, 'h', k.h, 'eh', k.eh, 'vh', k.vh) order by k.kind, k.sb)
      from (
        select a.*, pp.players from (
          select r.kind, r.sb, sum(r.cnt) as n, sum(r.x) as sx, sum(r.y) as sy,
                 sum(r.nw) as nw, sum(r.w) as w, sum(r.pe) as ew, sum(r.pe) - sum(r.pe2) as vw,
                 sum(r.ea) as ea, sum(r.va) as va,
                 sum(r.nh) as nh, sum(r.hit) as h, sum(r.eh) as eh, sum(r.vh) as vh
          from r group by r.kind, r.sb
        ) a join p_stake pp on pp.kind = a.kind and pp.sb = a.sb
      ) k), '[]'::jsonb),
    'totals', coalesce((
      select jsonb_agg(jsonb_build_object('kind', z.kind, 'players', z.players, 'up', z.up) order by z.kind)
      from (
        select pt.kind, count(*) as players, sum((pt.y > pt.x)::int) as up
        from (select r.kind, r.u, sum(r.x) as x, sum(r.y) as y from r group by r.kind, r.u) pt
        group by pt.kind
      ) z), '[]'::jsonb),
    'excluded', coalesce((
      select jsonb_agg(jsonb_build_object('kind', e.kind, 'n', e.n))
      from (
        select h.kind, sum(h.n) as n from public.monitor_hourly_near h
        where h.slot >= from_ms and h.slot < to_ms group by h.kind
      ) e), '[]'::jsonb),
    -- Arrival lag from the raw rows, as in monitor_report_raw.
    'lag', (
      select jsonb_build_object('rows', count(*),
        'p50', percentile_cont(0.5) within group (order by l.lag),
        'p80', percentile_cont(0.8) within group (order by l.lag),
        'p90', percentile_cont(0.9) within group (order by l.lag))
      from (
        select least(greatest(0, m.added - m.ts), 3::bigint * 3600000) as lag
        from public.monitor_rows m
        where m.added is not null and m.ts >= greatest(to_ms - 24::bigint * 3600000, 1794701049000)
          and m.ts < to_ms - 3::bigint * 3600000 and not coalesce(m.near, false)
      ) l)
  ) into out;
  return out;
end
$$;
revoke all on function public.monitor_report_rolled(bigint, bigint, bigint, integer) from public, anon, authenticated;

-- monitor_window_sums from the totals, the same fields as monitor_window_sums_raw.
create or replace function public.monitor_window_sums_rolled(from_ms bigint, to_ms bigint, bucket_ms bigint)
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
  ), r as (
    select from_ms + ((h.slot - from_ms) / bucket_ms) * bucket_ms as b, h.kind as k,
      case when h.kind = 'upgrade' then h.nw else h.n end as cnt,
      case when h.kind = 'upgrade' then h.w else h.hits end as o,
      case when h.kind = 'upgrade' then coalesce(c.f, 1) * h.pe else q.q * h.n end as e,
      case when h.kind = 'upgrade' then coalesce(c.f, 1) * h.pe - coalesce(c.f, 1) * coalesce(c.f, 1) * h.pe2 else q.q * (1 - q.q) * h.n end as ve
    from public.monitor_hourly h
    left join q on h.kind = 'case' and q.slug = h.slug
    left join cal c on h.kind = 'upgrade' and c.band = h.band and c.phase = h.phase
    where h.slot >= from_ms and h.slot < to_ms
      and ((h.kind = 'upgrade' and h.nw > 0) or (h.kind = 'case' and q.q is not null and h.n > 0))
  )
  select r.b, r.k, sum(r.cnt)::bigint, sum(r.o)::bigint, round(sum(r.e)::numeric, 3)::double precision, round(sum(r.ve)::numeric, 3)::double precision
  from r group by r.b, r.k order by r.b, r.k;
end
$$;
revoke all on function public.monitor_window_sums_rolled(bigint, bigint, bigint) from public, anon, authenticated;

-- monitor_report for ranges over 8 days, from the 6-hour sums: windows of whole 6 hours. The same fields, except:
-- players per chance band, phase, case and stake size are null (the 6-hour sums do not keep the player there),
-- and situations and daily are empty (the page takes them from its 7-day report). The heat map comes from the
-- half-hour totals, in one pass.
create or replace function public.monitor_report_long(from_ms bigint, to_ms bigint, bucket_ms bigint, tz_offset_min integer default 0)
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
  if bucket_ms < 21600000 or to_ms - from_ms > 400::bigint * 86400000 or (to_ms - from_ms) / bucket_ms > 6000 or abs(tz_offset_min) > 900 then
    raise exception 'range or bucket out of bounds';
  end if;

  with cb as (
    select h.slug, sum(h.n) as n, sum(h.hits) as h
    from public.monitor_6h h
    where h.kind = 'case' and h.slug <> '' and h.slot >= base_from and h.slot < to_ms
    group by h.slug
  ), g as (
    select coalesce(sum(cb.h)::double precision / nullif(sum(cb.n), 0), 0.35) as rate from cb
  ), q as (
    select cb.slug, (cb.h + 20 * g.rate) / (cb.n + 20) as q from cb, g
  ), cal as (
    select c.band, c.phase, (c.w + 10)::double precision / (c.ew + 10) as f from public.monitor_cal c
  ), r as (
    select
      from_ms + ((h.slot - from_ms) / bucket_ms) * bucket_ms as b,
      h.kind, nullif(h.slug, '') as slug, nullif(h.band, '') as band,
      case when h.kind = 'upgrade' and h.phase >= 0 then h.phase end as phase, h.sb,
      h.n as cnt, h.x, h.y, h.smax, h.nw, h.w, h.pe, h.pe2,
      coalesce(c.f, 1) * h.pe as ea,
      coalesce(c.f, 1) * h.pe - coalesce(c.f, 1) * coalesce(c.f, 1) * h.pe2 as va,
      case when q.q is not null then h.n else 0 end as nh,
      case when q.q is not null then h.hits else 0 end as hit,
      coalesce(q.q * h.n, 0) as eh,
      coalesce(q.q * (1 - q.q) * h.n, 0) as vh,
      case when h.band in ('a', 'b') then 1 when h.band in ('c', 'd') then 2 when h.band in ('e', 'f', 'g') then 3 end as cg
    from public.monitor_6h h
    left join q on h.kind = 'case' and q.slug = h.slug
    left join cal c on h.kind = 'upgrade' and c.band = h.band and c.phase = h.phase
    where h.slot >= from_ms and h.slot < to_ms and h.n > 0
  ), pb as (
    select from_ms + ((p.slot - from_ms) / bucket_ms) * bucket_ms as b, p.kind, p.u, sum(p.x) as x, sum(p.y) as y
    from public.monitor_6h_u p where p.slot >= from_ms and p.slot < to_ms and p.x > 0.000001 group by 1, 2, 3
  ), series as (
    select r.b, r.kind, sum(r.cnt) as n, sum(r.x) as sx, sum(r.y) as sy,
           sum(r.nw) as nw, sum(r.w) as w, sum(r.pe) as ew, sum(r.pe) - sum(r.pe2) as vw,
           sum(r.ea) as ea, sum(r.va) as va,
           sum(r.nh) as nh, sum(r.hit) as h, sum(r.eh) as eh, sum(r.vh) as vh
    from r group by r.b, r.kind
  ), pbs as (
    select pb.b, pb.kind, count(*) as players, sum((pb.y > pb.x)::int) as up,
           sum(pb.x * pb.x) as gxx, sum(pb.y * pb.y) as gyy, sum(pb.x * pb.y) as gxy
    from pb group by pb.b, pb.kind
  ), heat as (
    select (((h.slot + off_ms) / 86400000 + 3) % 7 + 1)::int as dow, (((h.slot + off_ms) % 86400000) / 3600000)::int as hr, h.kind,
           sum(h.n) as n, sum(h.x) as sx, sum(h.y) as sy, sum(h.nw) as nw, sum(h.w) as w, sum(h.pe) as ew, sum(h.pe) - sum(h.pe2) as vw,
           sum(coalesce(c.f, 1) * h.pe) as ea, sum(coalesce(c.f, 1) * h.pe - coalesce(c.f, 1) * coalesce(c.f, 1) * h.pe2) as va,
           sum(case when q.q is not null then h.n else 0 end) as nh, sum(case when q.q is not null then h.hits else 0 end) as h,
           sum(coalesce(q.q * h.n, 0)) as eh, sum(coalesce(q.q * (1 - q.q) * h.n, 0)) as vh
    from public.monitor_hourly h
    left join q on h.kind = 'case' and q.slug = h.slug
    left join cal c on h.kind = 'upgrade' and c.band = h.band and c.phase = h.phase
    where h.slot >= from_ms and h.slot < to_ms and h.n > 0
    group by 1, 2, 3
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
      from heat h), '[]'::jsonb),
    'bands', coalesce((
      select jsonb_agg(jsonb_build_object(
        'band', d.band, 'n', d.n, 'players', null, 'sx', d.sx, 'sy', d.sy, 'w', d.w, 'ew', d.ew, 'vw', d.vw, 'ea', d.ea, 'va', d.va) order by d.band)
      from (
        select r.band, sum(r.cnt) as n, sum(r.x) as sx, sum(r.y) as sy,
               sum(r.w) as w, sum(r.pe) as ew, sum(r.pe) - sum(r.pe2) as vw, sum(r.ea) as ea, sum(r.va) as va
        from r where r.band is not null group by r.band
      ) d), '[]'::jsonb),
    'phases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'phase', d.phase, 'cg', d.cg, 'n', d.n, 'players', null, 'sx', d.sx, 'sy', d.sy,
        'w', d.w, 'ew', d.ew, 'vw', d.vw, 'ea', d.ea, 'va', d.va) order by d.phase, d.cg)
      from (
        select r.phase, r.cg, sum(r.nw) as n, sum(r.x) as sx, sum(r.y) as sy,
               sum(r.w) as w, sum(r.pe) as ew, sum(r.pe) - sum(r.pe2) as vw, sum(r.ea) as ea, sum(r.va) as va
        from r where r.nw > 0 and r.phase is not null and r.cg is not null group by r.phase, r.cg
      ) d), '[]'::jsonb),
    'phases_norm', coalesce((
      select jsonb_agg(jsonb_build_object('phase', d.phase, 'cg', d.cg, 'n', d.n, 'w', d.w, 'ew', d.ew) order by d.phase, d.cg)
      from (
        select c.phase, case when c.band in ('a', 'b') then 1 when c.band in ('c', 'd') then 2 else 3 end as cg,
               sum(c.n) as n, sum(c.w) as w, sum(c.ew) as ew
        from public.monitor_cal c group by 1, 2
      ) d), '[]'::jsonb),
    'situations', '[]'::jsonb,
    'daily', '[]'::jsonb,
    'cases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'slug', c.slug, 'n', c.n, 'players', null, 'sx', c.sx, 'sy', c.sy, 'h', c.h, 'eh', c.eh, 'vh', c.vh, 'price', c.price) order by c.n desc)
      from (
        select r.slug, sum(r.cnt) as n, sum(r.x) as sx, sum(r.y) as sy,
               sum(r.hit) as h, sum(r.eh) as eh, sum(r.vh) as vh, max(r.smax) as price
        from r where r.kind = 'case' and r.slug is not null group by r.slug
        order by sum(r.cnt) desc limit 60
      ) c), '[]'::jsonb),
    'stakes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', k.kind, 'sb', k.sb, 'n', k.n, 'players', null, 'sx', k.sx, 'sy', k.sy,
        'nw', k.nw, 'w', k.w, 'ew', k.ew, 'vw', k.vw, 'ea', k.ea, 'va', k.va, 'nh', k.nh, 'h', k.h, 'eh', k.eh, 'vh', k.vh) order by k.kind, k.sb)
      from (
        select r.kind, r.sb, sum(r.cnt) as n, sum(r.x) as sx, sum(r.y) as sy,
               sum(r.nw) as nw, sum(r.w) as w, sum(r.pe) as ew, sum(r.pe) - sum(r.pe2) as vw,
               sum(r.ea) as ea, sum(r.va) as va,
               sum(r.nh) as nh, sum(r.hit) as h, sum(r.eh) as eh, sum(r.vh) as vh
        from r group by r.kind, r.sb
      ) k), '[]'::jsonb),
    'totals', coalesce((
      select jsonb_agg(jsonb_build_object('kind', z.kind, 'players', z.players, 'up', z.up) order by z.kind)
      from (
        select pt.kind, count(*) as players, sum((pt.y > pt.x)::int) as up
        from (select p.kind, p.u, sum(p.x) as x, sum(p.y) as y from public.monitor_6h_u p
              where p.slot >= from_ms and p.slot < to_ms and p.x > 0.000001 group by p.kind, p.u) pt
        group by pt.kind
      ) z), '[]'::jsonb),
    'excluded', coalesce((
      select jsonb_agg(jsonb_build_object('kind', e.kind, 'n', e.n))
      from (
        select h.kind, sum(h.n) as n from public.monitor_hourly_near h
        where h.slot >= from_ms and h.slot < to_ms group by h.kind
      ) e), '[]'::jsonb),
    'lag', (
      select jsonb_build_object('rows', count(*),
        'p50', percentile_cont(0.5) within group (order by l.lag),
        'p80', percentile_cont(0.8) within group (order by l.lag),
        'p90', percentile_cont(0.9) within group (order by l.lag))
      from (
        select least(greatest(0, m.added - m.ts), 3::bigint * 3600000) as lag
        from public.monitor_rows m
        where m.added is not null and m.ts >= greatest(to_ms - 24::bigint * 3600000, 1794701049000)
          and m.ts < to_ms - 3::bigint * 3600000 and not coalesce(m.near, false)
      ) l)
  ) into out;
  return out;
end
$$;
revoke all on function public.monitor_report_long(bigint, bigint, bigint, integer) from public, anon, authenticated;

-- The functions the page calls: over 8 days in whole 6 hours read the 6-hour sums, whole half hours the
-- half-hour totals, anything finer the raw rows.
create or replace function public.monitor_report(from_ms bigint, to_ms bigint, bucket_ms bigint, tz_offset_min integer default 0)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if to_ms - from_ms > 8::bigint * 86400000 and bucket_ms % 21600000 = 0 and from_ms % 21600000 = 0 and to_ms % 21600000 = 0 then
    return public.monitor_report_long(from_ms, to_ms, bucket_ms, tz_offset_min);
  end if;
  if bucket_ms % 1800000 = 0 and from_ms % 1800000 = 0 and to_ms % 1800000 = 0 then
    return public.monitor_report_rolled(from_ms, to_ms, bucket_ms, tz_offset_min);
  end if;
  return public.monitor_report_raw(from_ms, to_ms, bucket_ms, tz_offset_min);
end
$$;
revoke all on function public.monitor_report(bigint, bigint, bigint, integer) from public, anon;
grant execute on function public.monitor_report(bigint, bigint, bigint, integer) to authenticated;

create or replace function public.monitor_window_sums(from_ms bigint, to_ms bigint, bucket_ms bigint)
returns table (bucket bigint, kind text, n bigint, obs bigint, exp double precision, v double precision)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if bucket_ms % 1800000 = 0 and from_ms % 1800000 = 0 and to_ms % 1800000 = 0 then
    return query select * from public.monitor_window_sums_rolled(from_ms, to_ms, bucket_ms);
  else
    return query select * from public.monitor_window_sums_raw(from_ms, to_ms, bucket_ms);
  end if;
end
$$;
revoke all on function public.monitor_window_sums(bigint, bigint, bigint) from public, anon;
grant execute on function public.monitor_window_sums(bigint, bigint, bigint) to authenticated;

-- Raw rows older than 9 days go; the totals stay. Empty cells (rows moved to another cell) are dropped.
create or replace function public.monitor_prune() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  cut bigint := (extract(epoch from now()) * 1000)::bigint - 9::bigint * 86400000;
  done integer;
begin
  delete from public.monitor_rows where ts < cut;
  get diagnostics done = row_count;
  delete from public.monitor_hourly where n = 0;
  delete from public.monitor_hourly_near where n = 0;
  delete from public.monitor_6h where n = 0;
  delete from public.monitor_6h_u where abs(x) < 0.000001 and abs(y) < 0.000001;
  return done;
end
$$;
revoke all on function public.monitor_prune() from public, anon, authenticated;
select cron.schedule('monitor-prune', '17 * * * *', 'select public.monitor_prune()');

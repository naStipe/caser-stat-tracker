-- Pulse monitor: case watch. Measures a case's real return from public counters instead of sampled players.
--
-- A watched case's page (custom cases: /api/game/custom-cases/{slug}) shows its price, each item's chance and the
-- case's total opens. The monitor reads it every 5 minutes (monitor_case_snap), so the difference between two reads
-- is the exact number of opens in between. Every drop worth at least the case price is a big win, and big wins show
-- on the public drop line, which the monitor reads anyway: each such drop of a watched case's items is kept once by
-- its drop number (monitor_case_hits). Opens and big drops together give the real drop rate of the valuable items
-- against the published chance, over every open of the case, not only the players the monitor follows.
-- The drop line does not say which case a drop came from, so the same item from another case counts too, and reads
-- miss some drops at busy times; monitor_feed's seen and span say how many, so the page can scale the count up.
--
-- monitor_case_watch: the watched slugs, set from the dashboard (monitor_case_watch_set), read by the monitor.
-- monitor_case_watch_report(slug, from, to, bucket): everything the lookup draws for one case.

create table if not exists public.monitor_case_watch (
  slug text primary key check (slug ~ '^[A-Za-z0-9_-]{1,200}$'),
  added_at timestamptz not null default now()
);
create table if not exists public.monitor_case_snap (
  slug text not null,
  ts bigint not null,
  opens bigint,                    -- the case's total opens (custom cases); null when the site does not show it
  price double precision not null,
  items jsonb not null default '[]'::jsonb, -- [{name, price, chance}], chance in percent (null for official cases)
  primary key (slug, ts)
);
create table if not exists public.monitor_case_hits (
  slug text not null,
  drop_id bigint not null,         -- the site's drop number, so a drop seen in two reads counts once
  ts bigint not null,              -- when the monitor read it (within about a minute of the drop)
  item text not null,
  price double precision not null,
  primary key (slug, drop_id)
);
create index if not exists monitor_case_hits_slug_ts on public.monitor_case_hits (slug, ts);

alter table public.monitor_case_watch enable row level security;
alter table public.monitor_case_snap enable row level security;
alter table public.monitor_case_hits enable row level security;
revoke all on public.monitor_case_watch, public.monitor_case_snap, public.monitor_case_hits from anon, authenticated;

create or replace function public.monitor_case_watch_set(case_slug text, watch boolean)
returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not public.monitor_is_viewer() then raise exception 'not allowed' using errcode = '42501'; end if;
  if case_slug is null or case_slug !~ '^[A-Za-z0-9_-]{1,200}$' then raise exception 'not a case slug'; end if;
  if watch then
    if (select count(*) from public.monitor_case_watch) >= 20 and not exists (select 1 from public.monitor_case_watch w where w.slug = case_slug) then
      raise exception 'at most 20 watched cases; stop watching one first';
    end if;
    insert into public.monitor_case_watch (slug) values (case_slug) on conflict (slug) do nothing;
  else
    delete from public.monitor_case_watch w where w.slug = case_slug;
  end if;
  return watch;
end
$$;

create or replace function public.monitor_case_watch_report(case_slug text, from_ms bigint, to_ms bigint, bucket_ms bigint)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  out jsonb;
begin
  if not public.monitor_is_viewer() then raise exception 'not allowed' using errcode = '42501'; end if;
  if case_slug is null or length(case_slug) = 0 or length(case_slug) > 200 then raise exception 'case slug missing or too long'; end if;
  if bucket_ms < 1800000 or bucket_ms % 1800000 <> 0 or from_ms % 1800000 <> 0 or to_ms <= from_ms
     or to_ms - from_ms > 400::bigint * 86400000 or (to_ms - from_ms) / bucket_ms > 3000 then
    raise exception 'range or bucket out of bounds';
  end if;

  select jsonb_build_object(
    'watched', exists (select 1 from public.monitor_case_watch w where w.slug = case_slug),
    'since', (select (extract(epoch from w.added_at) * 1000)::bigint from public.monitor_case_watch w where w.slug = case_slug),
    'watchCount', (select count(*) from public.monitor_case_watch),
    'latest', (select jsonb_build_object('ts', s.ts, 'opens', s.opens, 'price', s.price, 'items', s.items)
               from public.monitor_case_snap s where s.slug = case_slug order by s.ts desc limit 1),
    -- The last read before the range, so the first window's opens can be counted.
    'base', (select jsonb_build_object('ts', s.ts, 'opens', s.opens)
             from public.monitor_case_snap s where s.slug = case_slug and s.ts < from_ms and s.opens is not null order by s.ts desc limit 1),
    'snaps', coalesce((
      select jsonb_agg(jsonb_build_object('bucket', x.b, 'firstTs', x.first_ts, 'lastTs', x.last_ts, 'firstOpens', x.first_opens, 'lastOpens', x.last_opens, 'reads', x.reads) order by x.b)
      from (
        select from_ms + ((s.ts - from_ms) / bucket_ms) * bucket_ms as b, min(s.ts) as first_ts, max(s.ts) as last_ts,
          (array_agg(s.opens order by s.ts))[1] as first_opens, (array_agg(s.opens order by s.ts desc))[1] as last_opens, count(*) as reads
        from public.monitor_case_snap s
        where s.slug = case_slug and s.ts >= from_ms and s.ts < to_ms and s.opens is not null
        group by 1) x), '[]'::jsonb),
    'hits', coalesce((
      select jsonb_agg(jsonb_build_object('bucket', x.b, 'item', x.item, 'n', x.n, 'value', round(x.v::numeric, 2)) order by x.b, x.item)
      from (
        select from_ms + ((hh.ts - from_ms) / bucket_ms) * bucket_ms as b, hh.item, count(*) as n, sum(hh.price) as v
        from public.monitor_case_hits hh
        where hh.slug = case_slug and hh.ts >= from_ms and hh.ts < to_ms
        group by 1, 2) x), '[]'::jsonb),
    -- How much of the drop line the reads caught, per window: seen of the drops the site numbered.
    'feed', coalesce((
      select jsonb_agg(jsonb_build_object('bucket', x.b, 'seen', x.seen, 'span', x.span) order by x.b)
      from (
        select from_ms + ((f.ts - from_ms) / bucket_ms) * bucket_ms as b, sum(f.seen) as seen, sum(f.span) as span
        from public.monitor_feed f
        where f.ts >= from_ms and f.ts < to_ms and f.span is not null and f.span > 0
        group by 1) x), '[]'::jsonb),
    -- Opens of followed players that every total leaves out (next to the moment a player was found). Raw rows
    -- are kept 9 days, so this covers at most that.
    'nearOpens', (select count(*) from public.monitor_rows r
                  where r.kind = 'case' and r.slug = case_slug and r.near and r.ts >= from_ms and r.ts < to_ms)
  ) into out;
  return out;
end
$$;
alter function public.monitor_case_watch_report(text, bigint, bigint, bigint) set plan_cache_mode = 'force_custom_plan';
revoke all on function public.monitor_case_watch_set(text, boolean), public.monitor_case_watch_report(text, bigint, bigint, bigint) from public, anon;
grant execute on function public.monitor_case_watch_set(text, boolean), public.monitor_case_watch_report(text, bigint, bigint, bigint) to authenticated;

-- Pulse monitor: colours of the site's drop line (the live feed of big wins).
--
-- Each feed read of the monitor (every 30 to 90 s) stores one row: how many drops it saw that the read
-- before had not, split by the colour group the site draws under the item (gold = knives, gloves and Howl,
-- red, pink, purple = also every sticker, blue, light blue, grey), how many came from upgrades, and their
-- total price. The site numbers drops one after another, so `span` is how many drops it showed since the
-- previous read, even the ones the read was too late to see, and `elapsed` the time since that read. Both
-- are null for the first read after a restart. A read sees the newest 20 drops, so at busy times it misses
-- some; the colour shares then come from the drops it saw, which are a fair sample of the line.

create table if not exists public.monitor_feed (
  ts bigint primary key,
  seen integer not null,
  span integer,
  elapsed bigint,
  gold integer not null default 0,
  red integer not null default 0,
  pink integer not null default 0,
  purple integer not null default 0,
  blue integer not null default 0,
  light integer not null default 0,
  grey integer not null default 0,
  up integer not null default 0,
  value double precision not null default 0
);
alter table public.monitor_feed enable row level security;
create policy "viewers read feed" on public.monitor_feed for select to authenticated using ((select public.monitor_is_viewer()));
revoke all on public.monitor_feed from anon;
revoke insert, update, delete, truncate on public.monitor_feed from authenticated;
grant select on public.monitor_feed to authenticated;

-- Sums per time bucket: drops seen per colour, and the drop rate from the numbering (span / elapsed).
create or replace function public.monitor_feed_agg(from_ms bigint, to_ms bigint, bucket_ms bigint)
returns table (bucket bigint, reads bigint, seen bigint, span bigint, elapsed bigint,
               gold bigint, red bigint, pink bigint, purple bigint, blue bigint, light bigint, grey bigint,
               up bigint, value double precision)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not public.monitor_is_viewer() then raise exception 'not allowed' using errcode = '42501'; end if;
  if bucket_ms < 60000 or to_ms - from_ms > 92::bigint * 86400000 or (to_ms - from_ms) / bucket_ms > 10000 then
    raise exception 'range or bucket out of bounds';
  end if;
  return query
  select from_ms + ((f.ts - from_ms) / bucket_ms) * bucket_ms as b, count(*), sum(f.seen)::bigint,
         sum(f.span) filter (where f.span is not null)::bigint, sum(f.elapsed) filter (where f.span is not null)::bigint,
         sum(f.gold)::bigint, sum(f.red)::bigint, sum(f.pink)::bigint, sum(f.purple)::bigint, sum(f.blue)::bigint,
         sum(f.light)::bigint, sum(f.grey)::bigint, sum(f.up)::bigint, sum(f.value)
  from public.monitor_feed f
  where f.ts >= from_ms and f.ts < to_ms
  group by 1 order by 1;
end
$$;
revoke all on function public.monitor_feed_agg(bigint, bigint, bigint) from public, anon;
grant execute on function public.monitor_feed_agg(bigint, bigint, bigint) to authenticated;

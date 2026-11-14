-- Pulse monitor, second version: more detail per row, an event log, one report function for the
-- dashboard, and a watchdog that raises an alert when the monitor stops reporting.
-- Additive: the monitor before this version keeps working against it.

-- Per row: the case slug and the dropped item's rarity code (cases), and whether the upgrade was won.
alter table public.monitor_rows add column if not exists slug text;
alter table public.monitor_rows add column if not exists tier text;
alter table public.monitor_rows add column if not exists won boolean;
create index if not exists monitor_rows_kind_ts on public.monitor_rows (kind, ts);

-- What happened to the monitor: starts, stops, the site refusing the account, pauses, crashes.
create table if not exists public.monitor_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  level text not null check (level in ('info', 'warn', 'error')),
  code text not null,
  message text not null
);
create index if not exists monitor_events_at on public.monitor_events (at desc);
alter table public.monitor_events enable row level security;
create policy "viewers read events" on public.monitor_events for select to authenticated using ((select public.monitor_is_viewer()));
revoke all on public.monitor_events from anon;
revoke insert, update, delete, truncate on public.monitor_events from authenticated;
grant select on public.monitor_events to authenticated;

-- Settings only the monitor (secret key) and the database itself can see: the alert URL and the
-- watchdog's own state. No policies, so signed-in users and the public key read nothing.
create table if not exists public.monitor_private (
  key text primary key,
  value text
);
alter table public.monitor_private enable row level security;
revoke all on public.monitor_private from anon, authenticated;

-- Everything the dashboard shows for one time range, as one JSON object.
--   series  per window and kind: sums for return per 1 (with per-player sums for the error),
--           upgrade wins against the wins the shown chances predict, case hits (an open worth at
--           least its price) against the hits the case's normal hit rate predicts, players in profit
--   heat    the same, by local weekday (1 = Monday) and hour
--   bands   upgrades by shown chance
--   cases   per case
--   stakes  per stake size
-- A case's normal hit rate is its rate over the 7 days before to_ms (or the whole range when longer),
-- pulled towards the overall rate when the case has few opens.
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
    where p.kind = 'case' and p.slug is not null and p.ts >= base_from and p.ts < to_ms and p.stake > 0
    group by p.slug
  ), g as (
    select coalesce(sum(cb.h)::double precision / nullif(sum(cb.n), 0), 0.35) as rate from cb
  ), q as (
    select cb.slug, (cb.h + 20 * g.rate) / (cb.n + 20) as q from cb, g
  ), r as (
    select
      from_ms + ((p.ts - from_ms) / bucket_ms) * bucket_ms as b,
      p.kind, p.u, p.slug, p.stake as x, p.returned as y,
      extract(isodow from to_timestamp((p.ts + off_ms) / 1000.0) at time zone 'UTC')::int as dow,
      extract(hour from to_timestamp((p.ts + off_ms) / 1000.0) at time zone 'UTC')::int as hr,
      case when p.kind = 'upgrade' and p.chance > 0 and p.chance <= 100 then p.chance / 100.0 end as pe,
      case when p.kind = 'upgrade' and p.chance > 0 and p.chance <= 100 then coalesce(p.won, p.returned > 0)::int end as w,
      case when p.kind = 'case' then q.q end as qe,
      case when p.kind = 'case' and q.q is not null then (p.returned >= p.stake)::int end as hit,
      case when p.kind = 'upgrade' and p.chance > 0 then
        case when p.chance < 10 then 'a' when p.chance < 30 then 'b' when p.chance < 60 then 'c' else 'd' end end as band,
      case when p.stake < 100 then 1 when p.stake < 1000 then 2 when p.stake < 10000 then 3 else 4 end as sb
    from public.monitor_rows p
    left join q on q.slug = p.slug and p.kind = 'case'
    where p.ts >= from_ms and p.ts < to_ms and p.stake > 0
  ), pb as (
    -- per player per window: for the clustered error and for players in profit
    select r.b, r.kind, r.u, sum(r.x) as x, sum(r.y) as y from r group by r.b, r.kind, r.u
  ), series as (
    select r.b, r.kind, count(*) as n, sum(r.x) as sx, sum(r.y) as sy,
           count(r.pe) as nw, sum(r.w) as w, sum(r.pe) as ew, sum(r.pe * (1 - r.pe)) as vw,
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
        'nw', s.nw, 'w', s.w, 'ew', s.ew, 'vw', s.vw, 'nh', s.nh, 'h', s.h, 'eh', s.eh, 'vh', s.vh
      ) order by s.b, s.kind)
      from series s join pbs t on t.b = s.b and t.kind = s.kind), '[]'::jsonb),
    'heat', coalesce((
      select jsonb_agg(jsonb_build_object(
        'dow', h.dow, 'hour', h.hr, 'kind', h.kind, 'n', h.n, 'sx', h.sx, 'sy', h.sy,
        'nw', h.nw, 'w', h.w, 'ew', h.ew, 'vw', h.vw, 'nh', h.nh, 'h', h.h, 'eh', h.eh, 'vh', h.vh))
      from (
        select r.dow, r.hr, r.kind, count(*) as n, sum(r.x) as sx, sum(r.y) as sy,
               count(r.pe) as nw, sum(r.w) as w, sum(r.pe) as ew, sum(r.pe * (1 - r.pe)) as vw,
               count(r.qe) as nh, sum(r.hit) as h, sum(r.qe) as eh, sum(r.qe * (1 - r.qe)) as vh
        from r group by r.dow, r.hr, r.kind
      ) h), '[]'::jsonb),
    'bands', coalesce((
      select jsonb_agg(jsonb_build_object(
        'band', d.band, 'n', d.n, 'players', d.players, 'sx', d.sx, 'sy', d.sy, 'w', d.w, 'ew', d.ew, 'vw', d.vw) order by d.band)
      from (
        select r.band, count(*) as n, count(distinct r.u) as players, sum(r.x) as sx, sum(r.y) as sy,
               sum(r.w) as w, sum(r.pe) as ew, sum(r.pe * (1 - r.pe)) as vw
        from r where r.band is not null group by r.band
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
        'nw', k.nw, 'w', k.w, 'ew', k.ew, 'vw', k.vw, 'nh', k.nh, 'h', k.h, 'eh', k.eh, 'vh', k.vh) order by k.kind, k.sb)
      from (
        select r.kind, r.sb, count(*) as n, count(distinct r.u) as players, sum(r.x) as sx, sum(r.y) as sy,
               count(r.pe) as nw, sum(r.w) as w, sum(r.pe) as ew, sum(r.pe * (1 - r.pe)) as vw,
               count(r.qe) as nh, sum(r.hit) as h, sum(r.qe) as eh, sum(r.qe * (1 - r.qe)) as vh
        from r group by r.kind, r.sb
      ) k), '[]'::jsonb),
    'totals', coalesce((
      select jsonb_agg(jsonb_build_object('kind', z.kind, 'players', z.players, 'up', z.up) order by z.kind)
      from (
        select pt.kind, count(*) as players, sum((pt.y > pt.x)::int) as up
        from (select r.kind, r.u, sum(r.x) as x, sum(r.y) as y from r group by r.kind, r.u) pt
        group by pt.kind
      ) z), '[]'::jsonb)
  ) into out;
  return out;
end
$$;

revoke all on function public.monitor_report(bigint, bigint, bigint, integer) from public, anon;
grant execute on function public.monitor_report(bigint, bigint, bigint, integer) to authenticated;

-- Alert message to a webhook, in the format of the service the URL belongs to (see monitor/src/notify.js).
create or replace function public.monitor_send_alert(title text, message text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  url text := (select value from public.monitor_private where key = 'alert_url');
  text_all text := title || E'\n' || message;
  chat text;
begin
  if url is null or url = '' then return; end if;
  if url like 'https://discord.com/api/webhooks/%' or url like 'https://discordapp.com/api/webhooks/%' then
    perform net.http_post(url := url, body := jsonb_build_object('content', left(text_all, 1900)));
  elsif url like 'https://api.telegram.org/bot%' then
    chat := substring(url from 'chat_id=([^&]+)');
    perform net.http_post(url := split_part(url, '?', 1), body := jsonb_build_object('chat_id', chat, 'text', text_all));
  elsif url like 'https://ntfy.sh/%' or url like '%/ntfy/%' then
    -- ntfy takes JSON at the server root: {"topic", "title", "message"}
    perform net.http_post(
      url := regexp_replace(url, '/[^/]+/?$', '/'),
      body := jsonb_build_object('topic', regexp_replace(url, '^.*/([^/]+)/?$', '\1'), 'title', title, 'message', message, 'priority', 4));
  else
    perform net.http_post(url := url, body := jsonb_build_object('title', title, 'text', message));
  end if;
end
$$;
revoke all on function public.monitor_send_alert(text, text) from public, anon, authenticated;

-- Runs every 5 minutes (pg_cron): when the monitor has not reported for 10 minutes it has crashed,
-- been stopped, or lost its connection. Logs that and sends one alert; logs and alerts again when
-- reports come back.
create or replace function public.monitor_watchdog()
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  last_at timestamptz := (select updated_at from public.monitor_status where id = 1);
  st jsonb := (select status from public.monitor_status where id = 1);
  silent boolean;
  was_silent boolean := coalesce((select value from public.monitor_private where key = 'watchdog_silent'), 'no') = 'yes';
  mins integer;
begin
  if last_at is null then return; end if;
  -- A monitor that stopped on purpose (it reports running = false) is not silent, it said goodbye.
  silent := last_at < now() - interval '10 minutes' and coalesce((st->>'running')::boolean, true);
  mins := extract(epoch from now() - last_at)::integer / 60;
  if silent and not was_silent then
    insert into public.monitor_events (level, code, message)
    values ('error', 'silent', format('No report from the monitor for %s minutes. The container may have crashed or the server may be down.', mins));
    perform public.monitor_send_alert('Pulse monitor: no reports', format('No report from the monitor for %s minutes. The container may have crashed or the server may be down. Check: docker compose ps', mins));
    insert into public.monitor_private (key, value) values ('watchdog_silent', 'yes')
      on conflict (key) do update set value = excluded.value;
  elsif not silent and was_silent then
    insert into public.monitor_events (level, code, message) values ('info', 'back', 'The monitor is reporting again.');
    perform public.monitor_send_alert('Pulse monitor: back', 'The monitor is reporting again.');
    update public.monitor_private set value = 'no' where key = 'watchdog_silent';
  end if;
end
$$;
revoke all on function public.monitor_watchdog() from public, anon, authenticated;

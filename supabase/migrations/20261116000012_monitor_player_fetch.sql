-- Pulse monitor: read one player's case openings on request, for the dashboard's case lookup.
--
-- A viewer pastes a player's profile link next to a case: monitor_player_fetch_request queues it. The monitor
-- picks up the oldest queued request within a minute, reads that player's whole case list back to 9 days (the raw
-- rows' retention), up to 100 pages, and stores the rows like any other (only added, never replacing a stored
-- row). It writes its progress here. When it is done it keeps the salted hash of the player (u) and clears the
-- site id, so real ids do not stay in the database. monitor_player_case then gives that player's opens of the case
-- from the raw rows, including those next to the moment they were found (one player's own results, not a sample).

create table if not exists public.monitor_player_fetch (
  id bigserial primary key,
  player text check (player is null or player ~ '^[0-9]{1,20}$'), -- site id while queued or reading; null after
  slug text check (slug is null or slug ~ '^[A-Za-z0-9_-]{1,200}$'),
  status text not null default 'queued' check (status in ('queued', 'reading', 'done', 'failed')),
  u text,                          -- the player's salted hash, as in monitor_rows.u
  pages integer not null default 0,
  rows integer not null default 0, -- case opens read
  matched integer not null default 0, -- of them, opens of the requested case
  oldest bigint,                   -- oldest open read (ms)
  message text,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists monitor_player_fetch_open on public.monitor_player_fetch (id) where status in ('queued', 'reading');
alter table public.monitor_player_fetch enable row level security;
revoke all on public.monitor_player_fetch from anon, authenticated;
-- One player's rows are found through monitor_rows_u_ts (u, ts).

create or replace function public.monitor_player_fetch_request(player_id text, case_slug text)
returns bigint
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  new_id bigint;
begin
  if not public.monitor_is_viewer() then raise exception 'not allowed' using errcode = '42501'; end if;
  if player_id is null or player_id !~ '^[0-9]{1,20}$' then raise exception 'not a player id'; end if;
  if case_slug is not null and case_slug !~ '^[A-Za-z0-9_-]{1,200}$' then raise exception 'not a case slug'; end if;
  if (select count(*) from public.monitor_player_fetch f where f.status in ('queued', 'reading')) >= 5 then
    raise exception 'five players are already waiting to be read; try again in a few minutes';
  end if;
  insert into public.monitor_player_fetch (player, slug) values (player_id, case_slug) returning id into new_id;
  return new_id;
end
$$;

create or replace function public.monitor_player_fetch_status(fetch_id bigint)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not public.monitor_is_viewer() then raise exception 'not allowed' using errcode = '42501'; end if;
  return (select jsonb_build_object('id', f.id, 'slug', f.slug, 'status', f.status, 'u', f.u, 'pages', f.pages, 'rows', f.rows,
      'matched', f.matched, 'oldest', f.oldest, 'message', f.message,
      'requestedAt', (extract(epoch from f.requested_at) * 1000)::bigint, 'updatedAt', (extract(epoch from f.updated_at) * 1000)::bigint,
      'ahead', (select count(*) from public.monitor_player_fetch g where g.status in ('queued', 'reading') and g.id < f.id))
    from public.monitor_player_fetch f where f.id = fetch_id);
end
$$;

-- One player's opens of one case from the raw rows, in the shape monitor_case gives (each open counts as its own
-- sample for the range, since there is only one player).
create or replace function public.monitor_player_case(player_u text, case_slug text, from_ms bigint, to_ms bigint, bucket_ms bigint)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  out jsonb;
begin
  if not public.monitor_is_viewer() then raise exception 'not allowed' using errcode = '42501'; end if;
  if player_u is null or player_u !~ '^[0-9a-f]{16}$' then raise exception 'not a player hash'; end if;
  if case_slug is null or length(case_slug) = 0 or length(case_slug) > 200 then raise exception 'case slug missing or too long'; end if;
  if bucket_ms < 1800000 or bucket_ms % 1800000 <> 0 or from_ms % 1800000 <> 0 or to_ms <= from_ms
     or to_ms - from_ms > 400::bigint * 86400000 or (to_ms - from_ms) / bucket_ms > 3000 then
    raise exception 'range or bucket out of bounds';
  end if;
  with c as (
    select r.ts, r.stake as x, r.returned as y from public.monitor_rows r
    where r.kind = 'case' and r.u = player_u and r.slug = case_slug and r.ts >= from_ms and r.ts < to_ms and r.stake > 0
  ), w as (
    select from_ms + ((c.ts - from_ms) / bucket_ms) * bucket_ms as b, count(*) as n, sum(c.x) as x, sum(c.y) as y,
      count(*) filter (where c.y >= c.x) as hits
    from c group by 1
  )
  select jsonb_build_object(
    'slug', case_slug,
    'price', (select max(c.x) from c),
    'first', (select min(c.ts) from c),
    'last', (select max(c.ts) from c),
    'total', (select jsonb_build_object('n', count(*), 'players', count(*),
        'sx', round(coalesce(sum(c.x), 0)::numeric, 2), 'sy', round(coalesce(sum(c.y), 0)::numeric, 2),
        'hits', count(*) filter (where c.y >= c.x),
        'gxx', round(coalesce(sum(c.x * c.x), 0)::numeric, 2), 'gyy', round(coalesce(sum(c.y * c.y), 0)::numeric, 2),
        'gxy', round(coalesce(sum(c.x * c.y), 0)::numeric, 2)) from c),
    'windows', coalesce((select jsonb_agg(jsonb_build_object('bucket', w.b, 'n', w.n, 'players', 1,
        'x', round(w.x::numeric, 2), 'y', round(w.y::numeric, 2), 'hits', w.hits) order by w.b) from w), '[]'::jsonb),
    'otherCases', coalesce((select jsonb_agg(jsonb_build_object('slug', o.slug, 'n', o.n) order by o.n desc) from (
        select r.slug, count(*) as n from public.monitor_rows r
        where r.kind = 'case' and r.u = player_u and r.ts >= from_ms and r.ts < to_ms and r.slug is not null and r.slug <> case_slug
        group by r.slug order by n desc limit 8) o), '[]'::jsonb))
  into out;
  return out;
end
$$;
alter function public.monitor_player_case(text, text, bigint, bigint, bigint) set plan_cache_mode = 'force_custom_plan';
revoke all on function public.monitor_player_fetch_request(text, text), public.monitor_player_fetch_status(bigint),
  public.monitor_player_case(text, text, bigint, bigint, bigint) from public, anon;
grant execute on function public.monitor_player_fetch_request(text, text), public.monitor_player_fetch_status(bigint),
  public.monitor_player_case(text, text, bigint, bigint, bigint) to authenticated;

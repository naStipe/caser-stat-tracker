-- Cloud copy of the userscript's events. There are no user accounts: every browser that holds the
-- same random sync key (sent as the "x-sync-key" header, at least 32 characters) shares one history.
-- The anon role can only read its own rows; all writes go through the functions below.
-- Applied to project hafnhxumrqyaljmciqqq (caser-stat-tracker) on 2026-11-12.

create table public.sync_events (
  account text not null,
  id text not null,
  rank integer not null default 0,
  deleted boolean not null default false,
  data jsonb,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (account, id)
);
create index sync_events_pull on public.sync_events (account, updated_at, id);

create table public.sync_accounts (
  account text primary key,
  cleared_at timestamptz
);

alter table public.sync_events enable row level security;
alter table public.sync_accounts enable row level security;

create function public.sync_key() returns text
language sql stable
set search_path = ''
as $$
  select case when length(k) >= 32 and length(k) <= 128 then k end
  from (select coalesce(current_setting('request.headers', true)::json->>'x-sync-key', '') as k) s
$$;

create policy "read own events" on public.sync_events for select to anon using (account = public.sync_key());
create policy "read own account" on public.sync_accounts for select to anon using (account = public.sync_key());

-- Insert or improve events. A stored event is only replaced by one with a higher rank
-- (resolved beats pending, live beats imported), and deleted events stay deleted.
create function public.sync_push(rows jsonb) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  k text := public.sync_key();
  n integer;
begin
  if k is null then raise exception 'missing or short sync key'; end if;
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) > 1000 then raise exception 'send an array of at most 1000 rows'; end if;
  insert into public.sync_events as e (account, id, rank, data)
  select k, r->>'id', coalesce((r->>'rank')::integer, 0), r->'data'
  from jsonb_array_elements(rows) r
  where r->>'id' is not null and length(r->>'id') <= 200 and jsonb_typeof(r->'data') = 'object'
  on conflict (account, id) do update
    set rank = excluded.rank, data = excluded.data, updated_at = clock_timestamp()
    where excluded.rank > e.rank and not e.deleted;
  get diagnostics n = row_count;
  return n;
end
$$;

-- Mark events deleted so other browsers drop them too.
create function public.sync_delete(ids text[]) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  k text := public.sync_key();
  n integer;
begin
  if k is null then raise exception 'missing or short sync key'; end if;
  update public.sync_events set deleted = true, data = null, updated_at = clock_timestamp()
  where account = k and id = any(ids) and not deleted;
  get diagnostics n = row_count;
  return n;
end
$$;

-- Delete everything for this key and record when, so other browsers clear their copies.
create function public.sync_clear() returns timestamptz
language plpgsql security definer
set search_path = ''
as $$
declare
  k text := public.sync_key();
  at timestamptz := clock_timestamp();
begin
  if k is null then raise exception 'missing or short sync key'; end if;
  delete from public.sync_events where account = k;
  insert into public.sync_accounts (account, cleared_at) values (k, at)
  on conflict (account) do update set cleared_at = excluded.cleared_at;
  return at;
end
$$;

revoke all on function public.sync_push(jsonb), public.sync_delete(text[]), public.sync_clear() from public;
grant execute on function public.sync_push(jsonb), public.sync_delete(text[]), public.sync_clear() to anon;
revoke insert, update, delete, truncate on public.sync_events, public.sync_accounts from anon, authenticated;

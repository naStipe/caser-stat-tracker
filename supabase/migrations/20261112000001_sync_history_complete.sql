-- Which site-history streams (upgrades, inventory, payments) some browser has read to the end.
-- Another browser that gets the events from the cloud then only reads the newest history pages.
alter table public.sync_accounts add column history_complete text[] not null default '{}';

create function public.sync_mark_complete(stream text) returns text[]
language plpgsql security definer
set search_path = ''
as $$
declare
  k text := public.sync_key();
  out text[];
begin
  if k is null then raise exception 'missing or short sync key'; end if;
  if stream is null or stream !~ '^[a-z]{1,32}$' then raise exception 'bad stream name'; end if;
  insert into public.sync_accounts as a (account, history_complete) values (k, array[stream])
  on conflict (account) do update
    set history_complete = case when stream = any(a.history_complete) then a.history_complete else a.history_complete || stream end
  returning history_complete into out;
  return out;
end
$$;

create or replace function public.sync_clear() returns timestamptz
language plpgsql security definer
set search_path = ''
as $$
declare
  k text := public.sync_key();
  at timestamptz := clock_timestamp();
begin
  if k is null then raise exception 'missing or short sync key'; end if;
  delete from public.sync_events where account = k;
  insert into public.sync_accounts (account, cleared_at, history_complete) values (k, at, '{}')
  on conflict (account) do update set cleared_at = excluded.cleared_at, history_complete = '{}';
  return at;
end
$$;

revoke all on function public.sync_mark_complete(text) from public;
grant execute on function public.sync_mark_complete(text) to anon;

-- Nicknames of the site accounts under a sync key, so every browser shows names instead of ids.
-- A browser learns a nickname when that account signs in on it, and sends it here.
-- Stored as {"<site user id>": "<nickname>"}. "Clear all" keeps them: they are not events.
-- Applied to project hafnhxumrqyaljmciqqq (caser-stat-tracker) on 2026-11-13.

alter table public.sync_accounts add column account_names jsonb not null default '{}';

create function public.sync_set_name(user_id text, name text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  k text := public.sync_key();
  out jsonb;
begin
  if k is null then raise exception 'missing or short sync key'; end if;
  if user_id is null or user_id !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'bad user id'; end if;
  name := btrim(name);
  if name is null or length(name) < 1 or length(name) > 64 then raise exception 'name must be 1 to 64 characters'; end if;
  insert into public.sync_accounts as a (account, account_names) values (k, jsonb_build_object(user_id, name))
  on conflict (account) do update
    set account_names = case
      -- At most 200 names per key; a known id can always be renamed.
      when a.account_names ? user_id or (select count(*) from jsonb_object_keys(a.account_names)) < 200
        then a.account_names || jsonb_build_object(user_id, name)
      else a.account_names
    end
  returning account_names into out;
  return out;
end
$$;

revoke all on function public.sync_set_name(text, text) from public;
grant execute on function public.sync_set_name(text, text) to anon;

-- Multi-account support: "history read to the end" flags are now kept per site account,
-- as "<stream>:<site user id>" (for example "upgrades:12345"). Old flags without an account stay valid.

create or replace function public.sync_mark_complete(stream text) returns text[]
language plpgsql security definer
set search_path = ''
as $$
declare
  k text := public.sync_key();
  out text[];
begin
  if k is null then raise exception 'missing or short sync key'; end if;
  if stream is null or stream !~ '^[a-z]{1,32}(:[A-Za-z0-9_-]{1,64})?$' then raise exception 'bad stream name'; end if;
  insert into public.sync_accounts as a (account, history_complete) values (k, array[stream])
  on conflict (account) do update
    set history_complete = case when stream = any(a.history_complete) then a.history_complete else a.history_complete || stream end
  returning history_complete into out;
  return out;
end
$$;

revoke all on function public.sync_mark_complete(text) from public;
grant execute on function public.sync_mark_complete(text) to anon;

-- "Clear all" in batches. sync_clear deletes every row of a key in one statement, which runs past
-- the anon role's statement timeout for a large history (about 65k rows), so nothing is deleted.
-- sync_clear_batch deletes at most 5000 rows per call; the client calls it until nothing is left.
--
-- The first call (started null) records the clear time in sync_accounts, so other browsers drop
-- their queued copies, and returns it. Later calls pass that time back and delete only rows that
-- were last changed before it: events added after the clear started are kept.
-- sync_clear stays for older script versions.

create or replace function public.sync_clear_batch(started timestamptz default null) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  k text := public.sync_key();
  at timestamptz := coalesce(started, clock_timestamp());
  n integer;
begin
  if k is null then raise exception 'missing or short sync key'; end if;
  if started is null then
    insert into public.sync_accounts (account, cleared_at) values (k, at)
    on conflict (account) do update set cleared_at = excluded.cleared_at;
  end if;
  -- Row addresses are collected once, so the plan cannot turn into a nested loop over the key's rows.
  delete from public.sync_events
  where ctid = any(array(
    select ctid from public.sync_events where account = k and updated_at <= at limit 5000
  ));
  get diagnostics n = row_count;
  delete from public.stats_cache where account = k and n > 0;
  return jsonb_build_object('at', at, 'deleted', n, 'done', n < 5000);
end
$$;

revoke all on function public.sync_clear_batch(timestamptz) from public;
grant execute on function public.sync_clear_batch(timestamptz) to anon;

-- Statistics were stale after the bulk loads above, which gave the first version of this function a bad plan.
analyze public.sync_events;

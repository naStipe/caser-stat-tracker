-- Pulse rows read from a player's recent history when the collector found them ("backfill"),
-- as opposed to rows that appeared while the player was being followed.

alter table public.pulse_rows add column back boolean not null default false;

create or replace function public.pulse_push(rows jsonb, volume jsonb) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  k text := public.sync_key();
  n integer;
  cut bigint := (extract(epoch from now()) * 1000)::bigint - 14 * 86400000;
begin
  if k is null then raise exception 'missing or short sync key'; end if;
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) > 2000 then raise exception 'send an array of at most 2000 rows'; end if;
  if jsonb_typeof(volume) <> 'array' or jsonb_array_length(volume) > 500 then raise exception 'send an array of at most 500 volume samples'; end if;
  insert into public.pulse_rows (account, id, kind, ts, u, stake, returned, chance, back)
  select k, r->>'id', r->>'kind', (r->>'ts')::bigint, r->>'u', (r->>'stake')::double precision,
         (r->>'returned')::double precision, nullif(r->>'chance', '')::double precision,
         coalesce((r->>'back')::boolean, false)
  from jsonb_array_elements(rows) r
  where r->>'id' is not null and length(r->>'id') <= 200 and r->>'kind' in ('upgrade', 'case')
    and r->>'u' is not null and length(r->>'u') <= 64 and (r->>'ts')::bigint > cut
  on conflict (account, id) do nothing;
  get diagnostics n = row_count;
  insert into public.pulse_volume (account, ts, cases, upgrades, online)
  select k, (v->>'ts')::bigint, (v->>'cases')::bigint, (v->>'upgrades')::bigint, (v->>'online')::integer
  from jsonb_array_elements(volume) v
  where (v->>'ts')::bigint > cut
  on conflict (account, ts) do nothing;
  delete from public.pulse_rows where account = k and ts < cut;
  delete from public.pulse_volume where account = k and ts < cut;
  return n;
end
$$;

-- Site pulse: anonymous samples of other players' case opens and upgrades, collected by one
-- browser and read by every browser with the same sync key (see src/pulse/).
-- A row holds a salted hash of the player id, never a name. Rows older than 14 days are deleted
-- on every push. As with sync_events, the anon role only reads rows of its own key and writes
-- through functions.

create table public.pulse_rows (
  account text not null,
  id text not null,
  kind text not null check (kind in ('upgrade', 'case')),
  ts bigint not null,
  u text not null,
  stake double precision not null,
  returned double precision not null,
  chance double precision,
  primary key (account, id)
);
create index pulse_rows_ts on public.pulse_rows (account, ts);

create table public.pulse_volume (
  account text not null,
  ts bigint not null,
  cases bigint not null,
  upgrades bigint not null,
  online integer,
  primary key (account, ts)
);

alter table public.pulse_rows enable row level security;
alter table public.pulse_volume enable row level security;
create policy "read own pulse rows" on public.pulse_rows for select to anon using (account = public.sync_key());
create policy "read own pulse volume" on public.pulse_volume for select to anon using (account = public.sync_key());

-- Add rows and volume samples (existing ids are kept as they are) and drop data older than 14 days.
create function public.pulse_push(rows jsonb, volume jsonb) returns integer
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
  insert into public.pulse_rows (account, id, kind, ts, u, stake, returned, chance)
  select k, r->>'id', r->>'kind', (r->>'ts')::bigint, r->>'u', (r->>'stake')::double precision,
         (r->>'returned')::double precision, nullif(r->>'chance', '')::double precision
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

-- Sums per time bucket and kind, the same shape as aggregate() in src/pulse/stats.js.
-- g* are sums over per-player totals, for an error clustered by player.
create function public.pulse_agg(from_ms bigint, to_ms bigint, bucket_ms bigint)
returns table (bucket bigint, kind text, n bigint, players bigint,
               sx double precision, sy double precision, sxx double precision, syy double precision, sxy double precision,
               gxx double precision, gyy double precision, gxy double precision)
language sql stable
set search_path = ''
as $$
  with r as (
    select from_ms + ((p.ts - from_ms) / bucket_ms) * bucket_ms as b, p.kind, p.u, p.stake as x, p.returned as y
    from public.pulse_rows p
    where p.account = public.sync_key() and p.ts >= from_ms and p.ts < to_ms and p.stake > 0
      and bucket_ms >= 60000 and to_ms - from_ms <= 15 * 86400000
  ), g as (
    select b, kind, u, sum(x) as x, sum(y) as y from r group by b, kind, u
  ), rs as (
    select b, kind, count(*) as n, sum(x) as sx, sum(y) as sy, sum(x * x) as sxx, sum(y * y) as syy, sum(x * y) as sxy
    from r group by b, kind
  ), gs as (
    select b, kind, count(*) as players, sum(x * x) as gxx, sum(y * y) as gyy, sum(x * y) as gxy
    from g group by b, kind
  )
  select rs.b, rs.kind, rs.n, gs.players, rs.sx, rs.sy, rs.sxx, rs.syy, rs.sxy, gs.gxx, gs.gyy, gs.gxy
  from rs join gs using (b, kind)
  order by rs.b, rs.kind
$$;

revoke all on function public.pulse_push(jsonb, jsonb), public.pulse_agg(bigint, bigint, bigint) from public;
grant execute on function public.pulse_push(jsonb, jsonb), public.pulse_agg(bigint, bigint, bigint) to anon;
revoke insert, update, delete, truncate on public.pulse_rows, public.pulse_volume from anon, authenticated;

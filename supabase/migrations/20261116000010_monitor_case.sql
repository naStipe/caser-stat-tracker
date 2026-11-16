-- Pulse monitor: one case's results, for the dashboard's case lookup (paste a case link, see its return).
--
-- monitor_case(case_slug, from_ms, to_ms, bucket_ms) reads the running half-hour totals (monitor_hourly, kept for
-- good) for one case: per window the opens, players, staked, returned and hits (opens worth at least the price),
-- and over the whole range the same sums plus each player's staked and returned squared and multiplied, so the page
-- can put a range on return per 1 clustered by player (one lucky player is one sample, not hundreds of opens).
-- "first" and "last" are the case's first and last half hour anywhere in the totals. When the case has no opens
-- in the range, "matches" lists up to 8 cases whose slug contains the text, so a typo or a partial slug still finds
-- it. Rows next to a player's discovery are not in the totals, as in every other report.

create or replace function public.monitor_case(case_slug text, from_ms bigint, to_ms bigint, bucket_ms bigint)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  out jsonb;
begin
  if not public.monitor_is_viewer() then raise exception 'not allowed' using errcode = '42501'; end if;
  if case_slug is null or length(case_slug) = 0 or length(case_slug) > 200 then raise exception 'case slug missing or too long'; end if;
  if bucket_ms < 1800000 or bucket_ms % 1800000 <> 0 or from_ms % 1800000 <> 0 or to_ms <= from_ms
     or to_ms - from_ms > 400::bigint * 86400000 or (to_ms - from_ms) / bucket_ms > 3000 then
    raise exception 'range or bucket out of bounds';
  end if;

  with c as (
    select h.slot, h.u, h.n, h.x, h.y, h.hits, h.smax
    from public.monitor_hourly h
    where h.kind = 'case' and h.slug = case_slug and h.slot >= from_ms and h.slot < to_ms and h.n > 0
  ), w as (
    select from_ms + ((c.slot - from_ms) / bucket_ms) * bucket_ms as b, sum(c.n) as n, count(distinct c.u) as players,
      sum(c.x) as x, sum(c.y) as y, sum(c.hits) as hits
    from c group by 1
  ), pu as (
    select c.u, sum(c.x) as x, sum(c.y) as y from c group by c.u
  ), span as (
    select min(h.slot) as first, max(h.slot) as last
    from public.monitor_hourly h where h.kind = 'case' and h.slug = case_slug and h.n > 0
  )
  select jsonb_build_object(
    'slug', case_slug,
    'price', (select max(c.smax) from c),
    'first', (select span.first from span),
    'last', (select span.last from span),
    'total', (select jsonb_build_object('n', coalesce(sum(c.n), 0), 'players', (select count(*) from pu),
        'sx', round(coalesce(sum(c.x), 0)::numeric, 2), 'sy', round(coalesce(sum(c.y), 0)::numeric, 2), 'hits', coalesce(sum(c.hits), 0),
        'gxx', (select round(coalesce(sum(pu.x * pu.x), 0)::numeric, 2) from pu),
        'gyy', (select round(coalesce(sum(pu.y * pu.y), 0)::numeric, 2) from pu),
        'gxy', (select round(coalesce(sum(pu.x * pu.y), 0)::numeric, 2) from pu)) from c),
    'windows', coalesce((select jsonb_agg(jsonb_build_object('bucket', w.b, 'n', w.n, 'players', w.players,
        'x', round(w.x::numeric, 2), 'y', round(w.y::numeric, 2), 'hits', w.hits) order by w.b) from w), '[]'::jsonb))
  into out;

  if (out->'total'->>'n')::bigint = 0 then
    out := out || jsonb_build_object('matches', coalesce((
      select jsonb_agg(m.slug order by m.opens desc) from (
        select h.slug, sum(h.n) as opens
        from public.monitor_hourly h
        where h.kind = 'case' and h.slug <> '' and h.slot >= to_ms - 30::bigint * 86400000
          and strpos(lower(h.slug), lower(case_slug)) > 0
        group by h.slug order by opens desc limit 8) m), '[]'::jsonb));
  end if;
  return out;
end
$$;
alter function public.monitor_case(text, bigint, bigint, bigint) set plan_cache_mode = 'force_custom_plan';
revoke all on function public.monitor_case(text, bigint, bigint, bigint) from public, anon;
grant execute on function public.monitor_case(text, bigint, bigint, bigint) to authenticated;

-- Stats server: the "stats" Edge Function computes the dashboard's statistics from sync_events,
-- so the userscript no longer keeps or crunches the whole history in the browser.
--
-- sync_events.lite: the event without what the statistics never read (image URLs, the bet items'
-- names and images, compensation details), about half the size. It is what the function loads.
-- stats_cache: computed results per sync key and query, valid while the key's data version holds.
-- Only the function (as the database owner) reads and writes these; anon gets nothing new.

create function public.event_lite(d jsonb) returns jsonb
language sql immutable parallel safe
set search_path = ''
as $$
  select case when d is null then null else
    (d #- '{item,image}' #- '{target,image}' #- '{superDrop,item,image}')
    || case when jsonb_typeof(d->'betItems') = 'array' then jsonb_build_object('betItems',
         (select coalesce(jsonb_agg(jsonb_build_object('price', b->'price')), '[]'::jsonb) from jsonb_array_elements(d->'betItems') b))
       else '{}'::jsonb end
    || case when jsonb_typeof(d->'compensation') = 'array' then jsonb_build_object('compensation',
         (select coalesce(jsonb_agg(jsonb_build_object('price', c->'price')), '[]'::jsonb) from jsonb_array_elements(d->'compensation') c))
       else '{}'::jsonb end
  end
$$;

alter table public.sync_events add column lite jsonb generated always as (public.event_lite(data)) stored;

create table public.stats_cache (
  account text not null,
  query_hash text not null,
  version text not null,
  result jsonb not null,
  computed_at timestamptz not null default now(),
  primary key (account, query_hash)
);
alter table public.stats_cache enable row level security;
revoke all on public.stats_cache from anon, authenticated;

-- Changes whenever any event of the key is added, improved or deleted, or the key is cleared.
create function public.stats_version(k text) returns text
language sql stable
set search_path = ''
as $$
  select coalesce((select max(updated_at)::text from public.sync_events where account = k), '-')
    || '|' || coalesce((select cleared_at::text from public.sync_accounts where account = k), '-')
$$;
revoke all on function public.stats_version(text) from public, anon, authenticated;

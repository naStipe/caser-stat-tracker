-- Pulse monitor: give the raw-row reports enough memory for their sorts.
--
-- The 24-hour range with 15 or 20-minute windows reads the raw rows (windows that are not whole half hours cannot
-- come from the running totals). By 15 November a day held about 300,000 rows, and the report's many groupings
-- spilled to disk with the default work_mem of 2 MB: 18 s, past Supabase's 8 s statement timeout, so the page
-- showed "canceling statement due to statement timeout". With 64 MB the same report takes about 1.3 s.
-- The setting applies only while these functions run.

alter function public.monitor_report_raw(bigint, bigint, bigint, integer) set work_mem = '64MB';
alter function public.monitor_window_sums_raw(bigint, bigint, bigint) set work_mem = '64MB';

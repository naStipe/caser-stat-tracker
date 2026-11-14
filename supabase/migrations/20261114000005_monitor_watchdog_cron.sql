-- Run the monitor watchdog (see *_monitor_report.sql) every 5 minutes. pg_net sends its alerts.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
select cron.schedule('monitor-watchdog', '*/5 * * * *', 'select public.monitor_watchdog()');

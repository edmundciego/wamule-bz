BEGIN;
-- Replace the legacy global singleton with one settings row per tenant.
-- No settings values or business records are rewritten.
set local lock_timeout = '5s';
do $migration$
declare legacy_definition text;
begin
  if exists(select 1 from public.ai_settings where tenant_id is null) then
    raise exception 'AI settings need tenant ownership before this migration.';
  end if;
  if exists(select 1 from public.ai_settings group by tenant_id having count(*) > 1) then
    raise exception 'Multiple AI settings rows exist for a tenant; reconcile without deleting rows.';
  end if;
  select pg_get_indexdef(c.oid) into legacy_definition
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='uniq_single_ai_settings';
  if legacy_definition is not null and legacy_definition <>
    'CREATE UNIQUE INDEX uniq_single_ai_settings ON public.ai_settings USING btree ((true))' then
    raise exception 'Unexpected legacy AI settings index; no index was changed.';
  end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='ai_settings_one_per_tenant'
    and pg_get_indexdef(c.oid) <> 'CREATE UNIQUE INDEX ai_settings_one_per_tenant ON public.ai_settings USING btree (tenant_id)') then
    raise exception 'Unexpected tenant AI settings index; no index was changed.';
  end if;
end;
$migration$;
create unique index if not exists ai_settings_one_per_tenant on public.ai_settings(tenant_id);
drop index if exists public.uniq_single_ai_settings;
;
COMMIT;

begin;

-- Replace the former project-wide singleton with one AI settings row per tenant.
-- Existing rows and their settings are retained; duplicate tenant rows fail the
-- unique index creation instead of being silently removed or merged.
drop index if exists public.uniq_single_ai_settings;
create unique index if not exists ai_settings_one_per_tenant
  on public.ai_settings (tenant_id);

-- Hopkins has its own advisory AI configuration. Seed defaults only when its
-- tenant exists and no row is already present; preserve any existing settings.
insert into public.ai_settings (
  tenant_id,
  provider,
  model,
  is_enabled,
  daily_brief_enabled,
  application_summary_enabled,
  collections_assistant_enabled
)
select
  o.id,
  'Gemini',
  'gemini-3.1-flash-lite',
  true,
  true,
  true,
  true
from public.organizations o
where o.slug = 'hopkins-grove'
  and o.is_active
on conflict (tenant_id) do nothing;

commit;

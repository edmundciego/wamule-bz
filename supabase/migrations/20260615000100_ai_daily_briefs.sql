-- AI Daily Brief records for read-only operational guidance.

create table if not exists public.ai_daily_briefs (
  id bigint generated always as identity primary key,
  brief_date date not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  summary text not null,
  applications_summary text not null default '',
  lots_summary text not null default '',
  payments_summary text not null default '',
  contracts_summary text not null default '',
  collections_summary text not null default '',
  alerts jsonb not null default '[]'::jsonb,
  recommended_actions jsonb not null default '[]'::jsonb,
  model text not null,
  status text not null default 'Draft',
  generated_by uuid references auth.users(id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_daily_briefs_status_valid check (status in ('Draft', 'Generated', 'Sent', 'Failed')),
  constraint ai_daily_briefs_alerts_array check (jsonb_typeof(alerts) = 'array'),
  constraint ai_daily_briefs_actions_array check (jsonb_typeof(recommended_actions) = 'array'),
  constraint ai_daily_briefs_period_valid check (period_end > period_start)
);

create index if not exists idx_ai_daily_briefs_brief_date on public.ai_daily_briefs(brief_date desc);
create index if not exists idx_ai_daily_briefs_created_at on public.ai_daily_briefs(created_at desc);
create index if not exists idx_ai_daily_briefs_status on public.ai_daily_briefs(status);

drop trigger if exists trg_ai_daily_briefs_updated_at on public.ai_daily_briefs;
create trigger trg_ai_daily_briefs_updated_at
before update on public.ai_daily_briefs
for each row execute function public.set_updated_at();

alter table public.ai_daily_briefs enable row level security;

drop policy if exists "Internal can read AI daily briefs" on public.ai_daily_briefs;
create policy "Internal can read AI daily briefs"
on public.ai_daily_briefs
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Admins can create AI daily briefs" on public.ai_daily_briefs;
create policy "Admins can create AI daily briefs"
on public.ai_daily_briefs
for insert
to authenticated
with check (public.is_admin_user());

drop policy if exists "Admins can update AI daily briefs" on public.ai_daily_briefs;
create policy "Admins can update AI daily briefs"
on public.ai_daily_briefs
for update
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

drop policy if exists "Admins can delete AI daily briefs" on public.ai_daily_briefs;
create policy "Admins can delete AI daily briefs"
on public.ai_daily_briefs
for delete
to authenticated
using (public.is_admin_user());

grant select, insert, update, delete on public.ai_daily_briefs to authenticated;

comment on table public.ai_daily_briefs is 'Read-only AI/deterministic operational daily briefs. Briefs may recommend manual actions but must not update operational records.';

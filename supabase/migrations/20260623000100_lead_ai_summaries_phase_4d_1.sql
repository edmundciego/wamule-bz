-- Phase 4D-1 Lead Smart Summary: advisory AI/deterministic lead summaries.

create table if not exists public.lead_ai_summaries (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  summary text not null,
  readiness_status text,
  key_risks jsonb not null default '[]'::jsonb,
  missing_information jsonb not null default '[]'::jsonb,
  recommended_actions jsonb not null default '[]'::jsonb,
  next_best_action text,
  confidence_notes text,
  source_snapshot jsonb,
  model text,
  provider text,
  generated_by uuid references auth.users(id) on delete set null,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_ai_summaries_readiness_status_valid check (
    readiness_status is null
    or readiness_status in (
      'new',
      'needs_follow_up',
      'gathering_information',
      'site_visit_ready',
      'deposit_readiness',
      'application_ready',
      'contract_ready',
      'blocked',
      'closed',
      'inactive',
      'unknown'
    )
  ),
  constraint lead_ai_summaries_key_risks_array check (jsonb_typeof(key_risks) = 'array'),
  constraint lead_ai_summaries_missing_information_array check (jsonb_typeof(missing_information) = 'array'),
  constraint lead_ai_summaries_recommended_actions_array check (jsonb_typeof(recommended_actions) = 'array'),
  constraint lead_ai_summaries_source_snapshot_object check (
    source_snapshot is null or jsonb_typeof(source_snapshot) = 'object'
  )
);

create index if not exists idx_lead_ai_summaries_lead_id
  on public.lead_ai_summaries(lead_id);
create index if not exists idx_lead_ai_summaries_generated_at
  on public.lead_ai_summaries(generated_at desc);
create index if not exists idx_lead_ai_summaries_readiness_status
  on public.lead_ai_summaries(readiness_status);

drop trigger if exists trg_lead_ai_summaries_updated_at on public.lead_ai_summaries;
create trigger trg_lead_ai_summaries_updated_at
before update on public.lead_ai_summaries
for each row execute function public.set_updated_at();

alter table public.lead_ai_summaries enable row level security;

drop policy if exists "Internal can read lead AI summaries" on public.lead_ai_summaries;
create policy "Internal can read lead AI summaries"
on public.lead_ai_summaries
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Admin staff can create lead AI summaries" on public.lead_ai_summaries;
create policy "Admin staff can create lead AI summaries"
on public.lead_ai_summaries
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Admins can delete lead AI summaries" on public.lead_ai_summaries;
create policy "Admins can delete lead AI summaries"
on public.lead_ai_summaries
for delete
to authenticated
using (public.is_admin_user());

grant select, insert, delete on public.lead_ai_summaries to authenticated;

comment on table public.lead_ai_summaries is 'Read-only AI/deterministic lead guidance for staff review. It must not mutate lead, reservation, application, customer, payment, contract, document, collection, or post-sales records.';

begin;

create extension if not exists pgcrypto;

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text,
  phone text,
  whatsapp text,
  parcel_id bigint references public.parcels(id) on delete set null,
  application_id bigint references public.applications(id) on delete set null,
  customer_id bigint references public.customers(id) on delete set null,
  source text,
  pipeline_stage text not null default 'new_lead',
  buyer_journey_stage text,
  decision_blocker text,
  budget_min numeric(12,2),
  budget_max numeric(12,2),
  preferred_contact_method text,
  assigned_to uuid references auth.users(id) on delete set null,
  next_action text,
  next_action_due_at timestamptz,
  notes text,
  lost_reason text,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leads_email_valid check (email is null or email ~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$'),
  constraint leads_pipeline_stage_valid check (
    pipeline_stage in (
      'new_lead',
      'contacted',
      'interested',
      'family_decision',
      'payment_plan_review',
      'site_visit_scheduled',
      'deposit_pending',
      'deposit_paid',
      'application_started',
      'contract_started',
      'closed_won',
      'lost_inactive'
    )
  ),
  constraint leads_budget_min_nonnegative check (budget_min is null or budget_min >= 0),
  constraint leads_budget_max_nonnegative check (budget_max is null or budget_max >= 0),
  constraint leads_budget_range_valid check (
    budget_min is null
    or budget_max is null
    or budget_max >= budget_min
  )
);

create table if not exists public.lead_activities (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  activity_type text not null,
  title text not null,
  description text,
  metadata jsonb,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint lead_activities_type_valid check (
    activity_type in (
      'note',
      'call',
      'whatsapp',
      'email',
      'status_change',
      'site_visit',
      'follow_up',
      'application_linked',
      'customer_linked'
    )
  ),
  constraint lead_activities_metadata_object check (
    metadata is null or jsonb_typeof(metadata) = 'object'
  )
);

create table if not exists public.follow_up_tasks (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.leads(id) on delete cascade,
  application_id bigint references public.applications(id) on delete set null,
  customer_id bigint references public.customers(id) on delete set null,
  title text not null,
  description text,
  due_at timestamptz,
  status text not null default 'open',
  priority text not null default 'normal',
  assigned_to uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint follow_up_tasks_status_valid check (status in ('open', 'in_progress', 'completed', 'cancelled')),
  constraint follow_up_tasks_priority_valid check (priority in ('low', 'normal', 'high', 'urgent')),
  constraint follow_up_tasks_has_context check (
    lead_id is not null
    or application_id is not null
    or customer_id is not null
  )
);

create table if not exists public.site_visits (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.leads(id) on delete cascade,
  application_id bigint references public.applications(id) on delete set null,
  customer_id bigint references public.customers(id) on delete set null,
  parcel_id bigint references public.parcels(id) on delete set null,
  scheduled_at timestamptz not null,
  status text not null default 'scheduled',
  visit_type text,
  location text,
  notes text,
  assigned_to uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint site_visits_status_valid check (status in ('scheduled', 'completed', 'no_show', 'cancelled', 'rescheduled')),
  constraint site_visits_has_context check (
    lead_id is not null
    or application_id is not null
    or customer_id is not null
  )
);

create index if not exists idx_leads_pipeline_stage on public.leads(pipeline_stage);
create index if not exists idx_leads_assigned_to on public.leads(assigned_to);
create index if not exists idx_leads_next_action_due_at on public.leads(next_action_due_at);
create index if not exists idx_leads_application_id on public.leads(application_id);
create index if not exists idx_leads_customer_id on public.leads(customer_id);
create index if not exists idx_leads_parcel_id on public.leads(parcel_id);
create unique index if not exists uniq_leads_application_id
  on public.leads(application_id)
  where application_id is not null;
create index if not exists idx_lead_activities_lead_id_created_at on public.lead_activities(lead_id, created_at desc);
create index if not exists idx_follow_up_tasks_lead_id on public.follow_up_tasks(lead_id);
create index if not exists idx_follow_up_tasks_status_due_at on public.follow_up_tasks(status, due_at);
create index if not exists idx_follow_up_tasks_assigned_to on public.follow_up_tasks(assigned_to);
create index if not exists idx_site_visits_lead_id on public.site_visits(lead_id);
create index if not exists idx_site_visits_status_scheduled_at on public.site_visits(status, scheduled_at);
create index if not exists idx_site_visits_assigned_to on public.site_visits(assigned_to);

drop trigger if exists trg_leads_updated_at on public.leads;
create trigger trg_leads_updated_at
before update on public.leads
for each row execute function public.set_updated_at();

drop trigger if exists trg_follow_up_tasks_updated_at on public.follow_up_tasks;
create trigger trg_follow_up_tasks_updated_at
before update on public.follow_up_tasks
for each row execute function public.set_updated_at();

drop trigger if exists trg_site_visits_updated_at on public.site_visits;
create trigger trg_site_visits_updated_at
before update on public.site_visits
for each row execute function public.set_updated_at();

alter table public.leads enable row level security;
alter table public.lead_activities enable row level security;
alter table public.follow_up_tasks enable row level security;
alter table public.site_visits enable row level security;

drop policy if exists "Internal can read leads" on public.leads;
create policy "Internal can read leads"
on public.leads
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can create leads" on public.leads;
create policy "Staff can create leads"
on public.leads
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Staff can update leads" on public.leads;
create policy "Staff can update leads"
on public.leads
for update
to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

drop policy if exists "Admins can delete leads" on public.leads;
create policy "Admins can delete leads"
on public.leads
for delete
to authenticated
using (public.is_admin_user());

drop policy if exists "Internal can read lead activities" on public.lead_activities;
create policy "Internal can read lead activities"
on public.lead_activities
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can create lead activities" on public.lead_activities;
create policy "Staff can create lead activities"
on public.lead_activities
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Admins can delete lead activities" on public.lead_activities;
create policy "Admins can delete lead activities"
on public.lead_activities
for delete
to authenticated
using (public.is_admin_user());

drop policy if exists "Internal can read follow-up tasks" on public.follow_up_tasks;
create policy "Internal can read follow-up tasks"
on public.follow_up_tasks
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can create follow-up tasks" on public.follow_up_tasks;
create policy "Staff can create follow-up tasks"
on public.follow_up_tasks
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Staff can update follow-up tasks" on public.follow_up_tasks;
create policy "Staff can update follow-up tasks"
on public.follow_up_tasks
for update
to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

drop policy if exists "Admins can delete follow-up tasks" on public.follow_up_tasks;
create policy "Admins can delete follow-up tasks"
on public.follow_up_tasks
for delete
to authenticated
using (public.is_admin_user());

drop policy if exists "Internal can read site visits" on public.site_visits;
create policy "Internal can read site visits"
on public.site_visits
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can create site visits" on public.site_visits;
create policy "Staff can create site visits"
on public.site_visits
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Staff can update site visits" on public.site_visits;
create policy "Staff can update site visits"
on public.site_visits
for update
to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

drop policy if exists "Admins can delete site visits" on public.site_visits;
create policy "Admins can delete site visits"
on public.site_visits
for delete
to authenticated
using (public.is_admin_user());

grant select, insert, update, delete on public.leads to authenticated;
grant select, insert, delete on public.lead_activities to authenticated;
grant select, insert, update, delete on public.follow_up_tasks to authenticated;
grant select, insert, update, delete on public.site_visits to authenticated;

comment on table public.leads is 'Phase 1 sales pipeline records for buyer interest before and during application/customer conversion.';
comment on table public.lead_activities is 'Manual activity timeline for lead notes, calls, WhatsApp, email, follow-ups, and link events.';
comment on table public.follow_up_tasks is 'Sales and buyer follow-up tasks. Does not replace payment requests or collections records.';
comment on table public.site_visits is 'Scheduled buyer site visits for sales workflow visibility.';

commit;

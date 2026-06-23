begin;

create extension if not exists pgcrypto;

create table if not exists public.post_sales_checklists (
  id uuid primary key default gen_random_uuid(),
  customer_id bigint references public.customers(id) on delete set null,
  application_id bigint references public.applications(id) on delete set null,
  contract_id bigint references public.contracts(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  reservation_id uuid references public.lot_reservations(id) on delete set null,
  status text not null default 'not_started',
  agreement_status text not null default 'not_started',
  document_status text not null default 'not_started',
  collections_handoff_status text not null default 'not_started',
  payment_setup_status text not null default 'not_started',
  assigned_to uuid references auth.users(id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  notes text,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint post_sales_checklists_status_valid check (status in ('not_started', 'in_progress', 'blocked', 'completed', 'cancelled')),
  constraint post_sales_checklists_agreement_status_valid check (agreement_status in ('not_started', 'drafting', 'ready_for_review', 'sent_for_signature', 'signed', 'blocked')),
  constraint post_sales_checklists_document_status_valid check (document_status in ('not_started', 'missing_documents', 'pending_review', 'complete', 'blocked')),
  constraint post_sales_checklists_handoff_status_valid check (collections_handoff_status in ('not_started', 'ready', 'handed_off', 'blocked')),
  constraint post_sales_checklists_payment_setup_status_valid check (payment_setup_status in ('not_started', 'pending', 'ready', 'active', 'blocked')),
  constraint post_sales_checklists_has_context check (
    customer_id is not null
    or application_id is not null
    or contract_id is not null
    or lead_id is not null
    or reservation_id is not null
  )
);

create table if not exists public.post_sales_tasks (
  id uuid primary key default gen_random_uuid(),
  customer_id bigint references public.customers(id) on delete cascade,
  application_id bigint references public.applications(id) on delete set null,
  contract_id bigint references public.contracts(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  reservation_id uuid references public.lot_reservations(id) on delete set null,
  title text not null,
  description text,
  task_type text not null default 'general',
  status text not null default 'open',
  priority text not null default 'normal',
  due_at timestamptz,
  assigned_to uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint post_sales_tasks_type_valid check (task_type in ('document', 'agreement', 'payment_setup', 'customer_contact', 'collections_handoff', 'internal_review', 'general')),
  constraint post_sales_tasks_status_valid check (status in ('open', 'in_progress', 'completed', 'cancelled', 'blocked')),
  constraint post_sales_tasks_priority_valid check (priority in ('low', 'normal', 'high', 'urgent')),
  constraint post_sales_tasks_has_context check (
    customer_id is not null
    or application_id is not null
    or contract_id is not null
    or lead_id is not null
    or reservation_id is not null
  )
);

create table if not exists public.post_sales_activities (
  id uuid primary key default gen_random_uuid(),
  checklist_id uuid references public.post_sales_checklists(id) on delete cascade,
  task_id uuid references public.post_sales_tasks(id) on delete cascade,
  customer_id bigint references public.customers(id) on delete set null,
  application_id bigint references public.applications(id) on delete set null,
  contract_id bigint references public.contracts(id) on delete set null,
  activity_type text not null,
  title text not null,
  description text,
  metadata jsonb,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint post_sales_activities_type_valid check (
    activity_type in (
      'note',
      'task_created',
      'task_completed',
      'status_change',
      'document_status_change',
      'agreement_status_change',
      'collections_handoff',
      'payment_setup_status_change',
      'blocked',
      'unblocked'
    )
  ),
  constraint post_sales_activities_metadata_object check (
    metadata is null or jsonb_typeof(metadata) = 'object'
  ),
  constraint post_sales_activities_has_context check (
    checklist_id is not null
    or task_id is not null
    or customer_id is not null
    or application_id is not null
    or contract_id is not null
  )
);

create unique index if not exists uniq_active_post_sales_checklist_customer
  on public.post_sales_checklists(customer_id)
  where customer_id is not null
    and status <> 'cancelled';

create index if not exists idx_post_sales_checklists_customer_id on public.post_sales_checklists(customer_id);
create index if not exists idx_post_sales_checklists_application_id on public.post_sales_checklists(application_id);
create index if not exists idx_post_sales_checklists_contract_id on public.post_sales_checklists(contract_id);
create index if not exists idx_post_sales_checklists_lead_id on public.post_sales_checklists(lead_id);
create index if not exists idx_post_sales_checklists_reservation_id on public.post_sales_checklists(reservation_id);
create index if not exists idx_post_sales_checklists_statuses on public.post_sales_checklists(status, agreement_status, document_status, collections_handoff_status, payment_setup_status);
create index if not exists idx_post_sales_checklists_assigned_to on public.post_sales_checklists(assigned_to);

create index if not exists idx_post_sales_tasks_customer_id on public.post_sales_tasks(customer_id);
create index if not exists idx_post_sales_tasks_application_id on public.post_sales_tasks(application_id);
create index if not exists idx_post_sales_tasks_contract_id on public.post_sales_tasks(contract_id);
create index if not exists idx_post_sales_tasks_lead_id on public.post_sales_tasks(lead_id);
create index if not exists idx_post_sales_tasks_reservation_id on public.post_sales_tasks(reservation_id);
create index if not exists idx_post_sales_tasks_status_due_at on public.post_sales_tasks(status, due_at);
create index if not exists idx_post_sales_tasks_assigned_to on public.post_sales_tasks(assigned_to);

create index if not exists idx_post_sales_activities_checklist_id_created_at
  on public.post_sales_activities(checklist_id, created_at desc);
create index if not exists idx_post_sales_activities_task_id_created_at
  on public.post_sales_activities(task_id, created_at desc);
create index if not exists idx_post_sales_activities_customer_id_created_at
  on public.post_sales_activities(customer_id, created_at desc);

drop trigger if exists trg_post_sales_checklists_updated_at on public.post_sales_checklists;
create trigger trg_post_sales_checklists_updated_at
before update on public.post_sales_checklists
for each row execute function public.set_updated_at();

drop trigger if exists trg_post_sales_tasks_updated_at on public.post_sales_tasks;
create trigger trg_post_sales_tasks_updated_at
before update on public.post_sales_tasks
for each row execute function public.set_updated_at();

alter table public.post_sales_checklists enable row level security;
alter table public.post_sales_tasks enable row level security;
alter table public.post_sales_activities enable row level security;

drop policy if exists "Internal can read post-sales checklists" on public.post_sales_checklists;
create policy "Internal can read post-sales checklists"
on public.post_sales_checklists
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can create post-sales checklists" on public.post_sales_checklists;
create policy "Staff can create post-sales checklists"
on public.post_sales_checklists
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Staff can update post-sales checklists" on public.post_sales_checklists;
create policy "Staff can update post-sales checklists"
on public.post_sales_checklists
for update
to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

drop policy if exists "Admins can delete post-sales checklists" on public.post_sales_checklists;
create policy "Admins can delete post-sales checklists"
on public.post_sales_checklists
for delete
to authenticated
using (public.is_admin_user());

drop policy if exists "Internal can read post-sales tasks" on public.post_sales_tasks;
create policy "Internal can read post-sales tasks"
on public.post_sales_tasks
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can create post-sales tasks" on public.post_sales_tasks;
create policy "Staff can create post-sales tasks"
on public.post_sales_tasks
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Staff can update post-sales tasks" on public.post_sales_tasks;
create policy "Staff can update post-sales tasks"
on public.post_sales_tasks
for update
to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

drop policy if exists "Admins can delete post-sales tasks" on public.post_sales_tasks;
create policy "Admins can delete post-sales tasks"
on public.post_sales_tasks
for delete
to authenticated
using (public.is_admin_user());

drop policy if exists "Internal can read post-sales activities" on public.post_sales_activities;
create policy "Internal can read post-sales activities"
on public.post_sales_activities
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can create post-sales activities" on public.post_sales_activities;
create policy "Staff can create post-sales activities"
on public.post_sales_activities
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Admins can delete post-sales activities" on public.post_sales_activities;
create policy "Admins can delete post-sales activities"
on public.post_sales_activities
for delete
to authenticated
using (public.is_admin_user());

grant select, insert, update, delete on public.post_sales_checklists to authenticated;
grant select, insert, update, delete on public.post_sales_tasks to authenticated;
grant select, insert, delete on public.post_sales_activities to authenticated;

commit;

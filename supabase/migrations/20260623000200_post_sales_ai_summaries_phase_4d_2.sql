-- Phase 4D-2 Post-Sales Smart Summary: advisory AI/deterministic post-sales checklist summaries.

create table if not exists public.post_sales_ai_summaries (
  id uuid primary key default gen_random_uuid(),
  checklist_id uuid not null references public.post_sales_checklists(id) on delete cascade,
  customer_id bigint references public.customers(id) on delete set null,
  application_id bigint references public.applications(id) on delete set null,
  contract_id bigint references public.contracts(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  reservation_id uuid references public.lot_reservations(id) on delete set null,
  summary text not null,
  readiness_status text,
  key_blockers jsonb not null default '[]'::jsonb,
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
  constraint post_sales_ai_summaries_readiness_status_valid check (
    readiness_status is null
    or readiness_status in (
      'not_started',
      'in_progress',
      'missing_documents',
      'agreement_review',
      'signature_pending',
      'payment_setup_pending',
      'collections_ready',
      'blocked',
      'ready',
      'completed',
      'unknown'
    )
  ),
  constraint post_sales_ai_summaries_key_blockers_array check (jsonb_typeof(key_blockers) = 'array'),
  constraint post_sales_ai_summaries_missing_information_array check (jsonb_typeof(missing_information) = 'array'),
  constraint post_sales_ai_summaries_recommended_actions_array check (jsonb_typeof(recommended_actions) = 'array'),
  constraint post_sales_ai_summaries_source_snapshot_object check (
    source_snapshot is null or jsonb_typeof(source_snapshot) = 'object'
  )
);

create index if not exists idx_post_sales_ai_summaries_checklist_id
  on public.post_sales_ai_summaries(checklist_id);
create index if not exists idx_post_sales_ai_summaries_customer_id
  on public.post_sales_ai_summaries(customer_id);
create index if not exists idx_post_sales_ai_summaries_generated_at
  on public.post_sales_ai_summaries(generated_at desc);
create index if not exists idx_post_sales_ai_summaries_readiness_status
  on public.post_sales_ai_summaries(readiness_status);

drop trigger if exists trg_post_sales_ai_summaries_updated_at on public.post_sales_ai_summaries;
create trigger trg_post_sales_ai_summaries_updated_at
before update on public.post_sales_ai_summaries
for each row execute function public.set_updated_at();

alter table public.post_sales_ai_summaries enable row level security;

drop policy if exists "Internal can read post-sales AI summaries" on public.post_sales_ai_summaries;
create policy "Internal can read post-sales AI summaries"
on public.post_sales_ai_summaries
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Admin staff can create post-sales AI summaries" on public.post_sales_ai_summaries;
create policy "Admin staff can create post-sales AI summaries"
on public.post_sales_ai_summaries
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Admins can delete post-sales AI summaries" on public.post_sales_ai_summaries;
create policy "Admins can delete post-sales AI summaries"
on public.post_sales_ai_summaries
for delete
to authenticated
using (public.is_admin_user());

grant select, insert, delete on public.post_sales_ai_summaries to authenticated;

comment on table public.post_sales_ai_summaries is 'Read-only AI/deterministic post-sales checklist guidance for staff review. It must not mutate checklist, task, customer, application, contract, payment, collection, document, lead, or reservation records.';

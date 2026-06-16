-- AI customer account summaries for read-only collections guidance.

create table if not exists public.customer_ai_summaries (
  id bigint generated always as identity primary key,
  customer_id bigint not null references public.customers(id) on delete cascade,
  summary text not null,
  account_status text not null,
  balance_summary text not null default '',
  payment_summary text not null default '',
  collections_flags jsonb not null default '[]'::jsonb,
  missing_items jsonb not null default '[]'::jsonb,
  recommended_actions jsonb not null default '[]'::jsonb,
  draft_follow_up_message text not null default '',
  model text not null,
  generated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_ai_summaries_status_valid check (
    account_status in ('Good Standing', 'Due Soon', 'Overdue', 'Needs Review', 'Missing Documents', 'No Active Contract')
  ),
  constraint customer_ai_summaries_flags_array check (jsonb_typeof(collections_flags) = 'array'),
  constraint customer_ai_summaries_missing_array check (jsonb_typeof(missing_items) = 'array'),
  constraint customer_ai_summaries_actions_array check (jsonb_typeof(recommended_actions) = 'array')
);

create unique index if not exists uniq_customer_ai_summaries_customer_id
  on public.customer_ai_summaries(customer_id);
create index if not exists idx_customer_ai_summaries_customer_id
  on public.customer_ai_summaries(customer_id);
create index if not exists idx_customer_ai_summaries_created_at
  on public.customer_ai_summaries(created_at desc);

drop trigger if exists trg_customer_ai_summaries_updated_at on public.customer_ai_summaries;
create trigger trg_customer_ai_summaries_updated_at
before update on public.customer_ai_summaries
for each row execute function public.set_updated_at();

alter table public.customer_ai_summaries enable row level security;

drop policy if exists "Internal can read customer AI summaries" on public.customer_ai_summaries;
create policy "Internal can read customer AI summaries"
on public.customer_ai_summaries
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Admin staff can create customer AI summaries" on public.customer_ai_summaries;
create policy "Admin staff can create customer AI summaries"
on public.customer_ai_summaries
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Admin staff can update customer AI summaries" on public.customer_ai_summaries;
create policy "Admin staff can update customer AI summaries"
on public.customer_ai_summaries
for update
to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

drop policy if exists "Admins can delete customer AI summaries" on public.customer_ai_summaries;
create policy "Admins can delete customer AI summaries"
on public.customer_ai_summaries
for delete
to authenticated
using (public.is_admin_user());

grant select, insert, update, delete on public.customer_ai_summaries to authenticated;

comment on table public.customer_ai_summaries is 'Read-only AI/deterministic customer account guidance for collections preparation. It must not mutate operational records or send customer communications.';

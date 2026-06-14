begin;

create table if not exists public.payment_requests (
  id bigint generated always as identity primary key,
  customer_id bigint not null references public.customers(id) on delete restrict,
  contract_id bigint references public.contracts(id) on delete set null,
  amount_due numeric(12,2) not null,
  due_date date not null,
  reason text not null,
  notes text,
  status text not null default 'Draft',
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payment_requests_amount_due_positive check (amount_due > 0),
  constraint payment_requests_status_valid check (status in ('Draft', 'Sent', 'Paid', 'Cancelled'))
);

create index if not exists idx_payment_requests_customer_id on public.payment_requests(customer_id);
create index if not exists idx_payment_requests_contract_id on public.payment_requests(contract_id);
create index if not exists idx_payment_requests_due_date on public.payment_requests(due_date);
create index if not exists idx_payment_requests_status on public.payment_requests(status);

drop trigger if exists trg_payment_requests_updated_at on public.payment_requests;
create trigger trg_payment_requests_updated_at
before update on public.payment_requests
for each row execute function public.set_updated_at();

alter table public.payment_requests enable row level security;

drop policy if exists "Payment requests readable by internal users" on public.payment_requests;
create policy "Payment requests readable by internal users"
on public.payment_requests
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Payment requests writable by admin staff" on public.payment_requests;
create policy "Payment requests writable by admin staff"
on public.payment_requests
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Payment requests updateable by admin staff" on public.payment_requests;
create policy "Payment requests updateable by admin staff"
on public.payment_requests
for update
to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

drop policy if exists "Payment requests deletable by admins" on public.payment_requests;
create policy "Payment requests deletable by admins"
on public.payment_requests
for delete
to authenticated
using (public.is_admin_user());

grant select, insert, update, delete on public.payment_requests to authenticated;

commit;

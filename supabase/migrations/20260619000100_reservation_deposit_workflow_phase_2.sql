begin;

create extension if not exists pgcrypto;

create table if not exists public.lot_reservations (
  id uuid primary key default gen_random_uuid(),
  reservation_code text,
  lead_id uuid references public.leads(id) on delete set null,
  application_id bigint references public.applications(id) on delete set null,
  customer_id bigint references public.customers(id) on delete set null,
  parcel_id bigint references public.parcels(id) on delete set null,
  status text not null default 'draft',
  deposit_status text not null default 'not_requested',
  expected_deposit_amount numeric(12,2),
  deposit_due_at timestamptz,
  deposit_paid_at timestamptz,
  payment_id bigint references public.transactions(id) on delete set null,
  reserved_at timestamptz,
  expires_at timestamptz,
  released_at timestamptz,
  converted_application_id bigint references public.applications(id) on delete set null,
  converted_contract_id bigint references public.contracts(id) on delete set null,
  assigned_to uuid references auth.users(id) on delete set null,
  notes text,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lot_reservations_status_valid check (
    status in (
      'draft',
      'reserved',
      'deposit_pending',
      'deposit_submitted',
      'deposit_confirmed',
      'converted_to_application',
      'converted_to_contract',
      'expired',
      'cancelled',
      'released'
    )
  ),
  constraint lot_reservations_deposit_status_valid check (
    deposit_status in (
      'not_requested',
      'pending',
      'proof_submitted',
      'confirmed',
      'overdue',
      'waived',
      'cancelled'
    )
  ),
  constraint lot_reservations_deposit_amount_nonnegative check (
    expected_deposit_amount is null or expected_deposit_amount >= 0
  ),
  constraint lot_reservations_has_context check (
    lead_id is not null
    or application_id is not null
    or customer_id is not null
    or parcel_id is not null
  )
);

create table if not exists public.reservation_activities (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.lot_reservations(id) on delete cascade,
  activity_type text not null,
  title text not null,
  description text,
  metadata jsonb,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint reservation_activities_type_valid check (
    activity_type in (
      'note',
      'status_change',
      'deposit_status_change',
      'reservation_created',
      'reservation_released',
      'expiration_updated',
      'application_linked',
      'contract_linked',
      'payment_linked'
    )
  ),
  constraint reservation_activities_metadata_object check (
    metadata is null or jsonb_typeof(metadata) = 'object'
  )
);

create unique index if not exists uniq_lot_reservations_code
  on public.lot_reservations(lower(reservation_code))
  where reservation_code is not null;

create unique index if not exists uniq_active_lot_reservation_per_parcel
  on public.lot_reservations(parcel_id)
  where parcel_id is not null
    and status in ('draft', 'reserved', 'deposit_pending', 'deposit_submitted', 'deposit_confirmed');

create index if not exists idx_lot_reservations_lead_id on public.lot_reservations(lead_id);
create index if not exists idx_lot_reservations_application_id on public.lot_reservations(application_id);
create index if not exists idx_lot_reservations_customer_id on public.lot_reservations(customer_id);
create index if not exists idx_lot_reservations_parcel_id on public.lot_reservations(parcel_id);
create index if not exists idx_lot_reservations_status on public.lot_reservations(status);
create index if not exists idx_lot_reservations_deposit_status on public.lot_reservations(deposit_status);
create index if not exists idx_lot_reservations_expires_at on public.lot_reservations(expires_at);
create index if not exists idx_lot_reservations_deposit_due_at on public.lot_reservations(deposit_due_at);
create index if not exists idx_lot_reservations_assigned_to on public.lot_reservations(assigned_to);
create index if not exists idx_reservation_activities_reservation_id_created_at
  on public.reservation_activities(reservation_id, created_at desc);

drop trigger if exists trg_lot_reservations_updated_at on public.lot_reservations;
create trigger trg_lot_reservations_updated_at
before update on public.lot_reservations
for each row execute function public.set_updated_at();

alter table public.lot_reservations enable row level security;
alter table public.reservation_activities enable row level security;

drop policy if exists "Internal can read lot reservations" on public.lot_reservations;
create policy "Internal can read lot reservations"
on public.lot_reservations
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can create lot reservations" on public.lot_reservations;
create policy "Staff can create lot reservations"
on public.lot_reservations
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Staff can update lot reservations" on public.lot_reservations;
create policy "Staff can update lot reservations"
on public.lot_reservations
for update
to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

drop policy if exists "Admins can delete lot reservations" on public.lot_reservations;
create policy "Admins can delete lot reservations"
on public.lot_reservations
for delete
to authenticated
using (public.is_admin_user());

drop policy if exists "Internal can read reservation activities" on public.reservation_activities;
create policy "Internal can read reservation activities"
on public.reservation_activities
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Staff can create reservation activities" on public.reservation_activities;
create policy "Staff can create reservation activities"
on public.reservation_activities
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Admins can delete reservation activities" on public.reservation_activities;
create policy "Admins can delete reservation activities"
on public.reservation_activities
for delete
to authenticated
using (public.is_admin_user());

grant select, insert, update, delete on public.lot_reservations to authenticated;
grant select, insert, delete on public.reservation_activities to authenticated;

commit;

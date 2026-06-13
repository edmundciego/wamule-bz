-- Wamuale Development Platform foundation

begin;

create extension if not exists pgcrypto;

do $$ begin create type public.app_role as enum ('Admin', 'Staff', 'Read Only'); exception when duplicate_object then null; end $$;
do $$ begin create type public.parcel_zoning as enum ('Residential', 'Commercial', 'Green Space'); exception when duplicate_object then null; end $$;
do $$ begin create type public.parcel_status as enum ('Available', 'Reserved', 'Sold'); exception when duplicate_object then null; end $$;
do $$ begin create type public.application_status as enum ('Pending Review', 'Approved', 'Declined'); exception when duplicate_object then null; end $$;
do $$ begin create type public.transaction_type as enum ('Down Payment', 'Land Installment', 'Garbage Fee', 'Road Maintenance'); exception when duplicate_object then null; end $$;
do $$ begin create type public.collection_method as enum ('Cash', 'Online Transfer'); exception when duplicate_object then null; end $$;
do $$ begin create type public.receipt_job_status as enum ('Pending', 'Processing', 'Completed', 'Failed'); exception when duplicate_object then null; end $$;

create table if not exists public.admin_profiles (
  id bigint generated always as identity primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  full_name text not null,
  role public.app_role not null default 'Staff',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.parcels (
  id bigint generated always as identity primary key,
  lot_number text not null unique,
  dimensions text not null default '75x100 ft',
  zoning public.parcel_zoning not null default 'Residential',
  status public.parcel_status not null default 'Available',
  base_price numeric(12,2) not null default 0 check (base_price >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.applications (
  id bigint generated always as identity primary key,
  first_name text not null,
  last_name text not null,
  phone text not null,
  email text check (email is null or email ~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$'),
  parcel_id bigint references public.parcels(id) on delete restrict,
  cultural_preservation_review text,
  sustainability_terms_verified boolean not null default false,
  status public.application_status not null default 'Pending Review',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customers (
  id bigint generated always as identity primary key,
  application_id bigint not null unique references public.applications(id) on delete restrict,
  first_name text not null,
  last_name text not null,
  phone text not null,
  email text check (email is null or email ~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$'),
  address text,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.contracts (
  id bigint generated always as identity primary key,
  customer_id bigint not null references public.customers(id) on delete restrict,
  parcel_id bigint not null references public.parcels(id) on delete restrict,
  final_purchase_price numeric(12,2) not null check (final_purchase_price > 0),
  initial_deposit numeric(12,2) not null default 0 check (initial_deposit >= 0),
  term_months integer not null check (term_months between 1 and 60),
  monthly_payment numeric(12,2) generated always as (round(((final_purchase_price - initial_deposit) / term_months)::numeric, 2)) stored,
  start_date date not null default current_date,
  payment_due_day integer not null default 1 check (payment_due_day between 1 and 31),
  signed_contract_file_path text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contracts_initial_deposit_not_over_price check (initial_deposit <= final_purchase_price)
);

create table if not exists public.transactions (
  id bigint generated always as identity primary key,
  receipt_number text generated always as ('WD-' || lpad(id::text, 8, '0')) stored,
  customer_id bigint not null references public.customers(id) on delete restrict,
  contract_id bigint references public.contracts(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  transaction_type public.transaction_type not null,
  collection_method public.collection_method not null,
  bank_reference text,
  authorized_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  receipt_file_path text,
  notes text,
  created_at timestamptz not null default now(),
  constraint transactions_online_reference_required check (
    collection_method = 'Cash' or (bank_reference is not null and length(trim(bank_reference)) > 0)
  ),
  constraint transactions_land_types_require_contract check (
    (transaction_type in ('Down Payment', 'Land Installment') and contract_id is not null)
    or transaction_type in ('Garbage Fee', 'Road Maintenance')
  )
);

create table if not exists public.community_fee_settings (
  id bigint generated always as identity primary key,
  garbage_fee_amount numeric(12,2) not null default 0 check (garbage_fee_amount >= 0),
  road_maintenance_fee_amount numeric(12,2) not null default 0 check (road_maintenance_fee_amount >= 0),
  effective_date date not null default current_date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'community_fee_settings'
      and column_name = 'road_maintenance_amount'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'community_fee_settings'
      and column_name = 'road_maintenance_fee_amount'
  ) then
    alter table public.community_fee_settings
      rename column road_maintenance_amount to road_maintenance_fee_amount;
  end if;
end $$;

alter table public.community_fee_settings
  add column if not exists garbage_fee_amount numeric(12,2) not null default 0,
  add column if not exists road_maintenance_fee_amount numeric(12,2) not null default 0,
  add column if not exists effective_date date not null default current_date,
  add column if not exists is_active boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.receipt_jobs (
  id bigint generated always as identity primary key,
  transaction_id bigint not null unique references public.transactions(id) on delete cascade,
  status public.receipt_job_status not null default 'Pending',
  attempts integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_parcels_lot_number on public.parcels(lot_number);
create index if not exists idx_parcels_status on public.parcels(status);
create index if not exists idx_applications_status on public.applications(status);
create index if not exists idx_applications_parcel_id on public.applications(parcel_id);
create index if not exists idx_customers_name on public.customers(last_name, first_name);
create unique index if not exists uniq_active_contract_per_parcel on public.contracts(parcel_id) where is_active = true;
create unique index if not exists uniq_transactions_bank_reference on public.transactions(upper(trim(bank_reference))) where bank_reference is not null;
create unique index if not exists uniq_one_active_community_fee_setting on public.community_fee_settings(is_active) where is_active = true;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

create or replace function public.is_admin_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admin_profiles where user_id = auth.uid() and role = 'Admin');
$$;

create or replace function public.is_internal_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admin_profiles where user_id = auth.uid() and role in ('Admin', 'Staff', 'Read Only'));
$$;

create or replace function public.can_write_admin_data()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admin_profiles where user_id = auth.uid() and role in ('Admin', 'Staff'));
$$;

create or replace function public.approve_application(p_application_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_application public.applications%rowtype;
  v_parcel_status public.parcel_status;
begin
  if not public.can_write_admin_data() then raise exception 'Missing permission to approve applications.'; end if;
  select * into v_application from public.applications where id = p_application_id for update;
  if not found then raise exception 'Application not found.'; end if;
  if v_application.parcel_id is null then raise exception 'Select a lot before approving this application.'; end if;
  select status into v_parcel_status from public.parcels where id = v_application.parcel_id for update;
  if v_parcel_status <> 'Available' then raise exception 'Selected lot is not available.'; end if;

  update public.applications set status = 'Approved', updated_at = now() where id = p_application_id;
  insert into public.customers (application_id, first_name, last_name, phone, email)
  values (v_application.id, v_application.first_name, v_application.last_name, v_application.phone, v_application.email)
  on conflict (application_id) do nothing;
  update public.parcels set status = 'Reserved', updated_at = now() where id = v_application.parcel_id;
end;
$$;

create or replace function public.validate_contract_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_status public.parcel_status;
begin
  select status into v_status from public.parcels where id = new.parcel_id for update;
  if v_status = 'Sold' then raise exception 'Cannot create contract for a sold lot.'; end if;
  return new;
end;
$$;

create or replace function public.mark_parcel_sold_after_contract()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.is_active then update public.parcels set status = 'Sold', updated_at = now() where id = new.parcel_id; end if;
  return new;
end;
$$;

create or replace function public.validate_transaction_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_customer_id bigint;
begin
  new.bank_reference = nullif(upper(trim(new.bank_reference)), '');
  if new.collection_method = 'Cash' then new.bank_reference = null; end if;
  if new.collection_method = 'Online Transfer' and new.bank_reference is null then raise exception 'Bank reference is required for online transfers.'; end if;
  if new.contract_id is not null then
    select customer_id into v_customer_id from public.contracts where id = new.contract_id;
    if v_customer_id <> new.customer_id then raise exception 'Transaction customer does not match selected contract.'; end if;
  end if;
  return new;
end;
$$;

create or replace function public.queue_receipt_generation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.receipt_jobs (transaction_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists trg_parcels_updated_at on public.parcels;
create trigger trg_parcels_updated_at before update on public.parcels for each row execute function public.set_updated_at();
drop trigger if exists trg_applications_updated_at on public.applications;
create trigger trg_applications_updated_at before update on public.applications for each row execute function public.set_updated_at();
drop trigger if exists trg_customers_updated_at on public.customers;
create trigger trg_customers_updated_at before update on public.customers for each row execute function public.set_updated_at();
drop trigger if exists trg_contracts_updated_at on public.contracts;
create trigger trg_contracts_updated_at before update on public.contracts for each row execute function public.set_updated_at();
drop trigger if exists trg_community_fee_settings_updated_at on public.community_fee_settings;
create trigger trg_community_fee_settings_updated_at before update on public.community_fee_settings for each row execute function public.set_updated_at();
drop trigger if exists trg_receipt_jobs_updated_at on public.receipt_jobs;
create trigger trg_receipt_jobs_updated_at before update on public.receipt_jobs for each row execute function public.set_updated_at();
drop trigger if exists trg_validate_contract_write on public.contracts;
create trigger trg_validate_contract_write before insert or update on public.contracts for each row execute function public.validate_contract_write();
drop trigger if exists trg_mark_parcel_sold_after_contract on public.contracts;
create trigger trg_mark_parcel_sold_after_contract after insert on public.contracts for each row execute function public.mark_parcel_sold_after_contract();
drop trigger if exists trg_validate_transaction_write on public.transactions;
create trigger trg_validate_transaction_write before insert or update on public.transactions for each row execute function public.validate_transaction_write();
drop trigger if exists trg_queue_receipt_generation on public.transactions;
create trigger trg_queue_receipt_generation after insert on public.transactions for each row execute function public.queue_receipt_generation();

drop view if exists public.parcel_board_view cascade;
drop view if exists public.customer_balance_view cascade;

create view public.parcel_board_view as
select p.*, c.id as contract_id, cu.id as customer_id, trim(cu.first_name || ' ' || cu.last_name) as customer_name
from public.parcels p
left join public.contracts c on c.parcel_id = p.id and c.is_active
left join public.customers cu on cu.id = c.customer_id
order by p.lot_number;

create view public.customer_balance_view as
select
  cu.id as customer_id,
  trim(cu.first_name || ' ' || cu.last_name) as customer_name,
  coalesce(sum(t.amount) filter (where t.transaction_type in ('Down Payment', 'Land Installment')), 0) as land_paid,
  coalesce(sum(t.amount) filter (where t.transaction_type in ('Garbage Fee', 'Road Maintenance')), 0) as community_paid,
  greatest(coalesce(max(c.final_purchase_price), 0) - coalesce(sum(t.amount) filter (where t.transaction_type in ('Down Payment', 'Land Installment')), 0), 0) as land_balance
from public.customers cu
left join public.contracts c on c.customer_id = cu.id and c.is_active
left join public.transactions t on t.customer_id = cu.id
group by cu.id;

insert into public.parcels (lot_number, dimensions, zoning, status, base_price)
select lpad(i::text, 2, '0'), '75x100 ft', 'Residential', 'Available', 0
from generate_series(1, 24) as s(i)
on conflict (lot_number) do nothing;

insert into public.community_fee_settings (garbage_fee_amount, road_maintenance_fee_amount, effective_date, is_active)
select 0, 0, current_date, true
where not exists (select 1 from public.community_fee_settings);

alter table public.admin_profiles enable row level security;
alter table public.parcels enable row level security;
alter table public.applications enable row level security;
alter table public.customers enable row level security;
alter table public.contracts enable row level security;
alter table public.transactions enable row level security;
alter table public.community_fee_settings enable row level security;
alter table public.receipt_jobs enable row level security;

drop policy if exists "Public can submit applications" on public.applications;
drop policy if exists "Internal can read applications" on public.applications;
drop policy if exists "Staff can update applications" on public.applications;
drop policy if exists "Internal can read admin profiles" on public.admin_profiles;
drop policy if exists "Admins manage admin profiles" on public.admin_profiles;
drop policy if exists "Public can read available parcels" on public.parcels;
drop policy if exists "Staff can write parcels" on public.parcels;
drop policy if exists "Internal can read customers" on public.customers;
drop policy if exists "Staff can write customers" on public.customers;
drop policy if exists "Internal can read contracts" on public.contracts;
drop policy if exists "Staff can write contracts" on public.contracts;
drop policy if exists "Internal can read transactions" on public.transactions;
drop policy if exists "Staff can write transactions" on public.transactions;
drop policy if exists "Internal can read fees" on public.community_fee_settings;
drop policy if exists "Admins manage fees" on public.community_fee_settings;
drop policy if exists "Internal can read receipt jobs" on public.receipt_jobs;
drop policy if exists "Staff can manage receipt jobs" on public.receipt_jobs;

create policy "Public can submit applications" on public.applications for insert with check (status = 'Pending Review');
create policy "Internal can read applications" on public.applications for select using (public.is_internal_user());
create policy "Staff can update applications" on public.applications for update using (public.can_write_admin_data()) with check (public.can_write_admin_data());

create policy "Internal can read admin profiles" on public.admin_profiles for select using (public.is_internal_user());
create policy "Admins manage admin profiles" on public.admin_profiles for all using (public.is_admin_user()) with check (public.is_admin_user());

create policy "Public can read available parcels" on public.parcels for select using (status = 'Available' or public.is_internal_user());
create policy "Staff can write parcels" on public.parcels for all using (public.can_write_admin_data()) with check (public.can_write_admin_data());

create policy "Internal can read customers" on public.customers for select using (public.is_internal_user());
create policy "Staff can write customers" on public.customers for all using (public.can_write_admin_data()) with check (public.can_write_admin_data());

create policy "Internal can read contracts" on public.contracts for select using (public.is_internal_user());
create policy "Staff can write contracts" on public.contracts for all using (public.can_write_admin_data()) with check (public.can_write_admin_data());

create policy "Internal can read transactions" on public.transactions for select using (public.is_internal_user());
create policy "Staff can write transactions" on public.transactions for all using (public.can_write_admin_data()) with check (public.can_write_admin_data());

create policy "Internal can read fees" on public.community_fee_settings for select using (public.is_internal_user());
create policy "Admins manage fees" on public.community_fee_settings for all using (public.is_admin_user()) with check (public.is_admin_user());

create policy "Internal can read receipt jobs" on public.receipt_jobs for select using (public.is_internal_user());
create policy "Staff can manage receipt jobs" on public.receipt_jobs for all using (public.can_write_admin_data()) with check (public.can_write_admin_data());

insert into storage.buckets (id, name, public)
values ('contracts', 'contracts', false), ('receipts', 'receipts', false), ('application-documents', 'application-documents', false)
on conflict (id) do update set public = excluded.public;

drop policy if exists "Internal can read private files" on storage.objects;
drop policy if exists "Staff can upload private files" on storage.objects;

create policy "Internal can read private files" on storage.objects for select using (
  bucket_id in ('contracts', 'receipts', 'application-documents') and public.is_internal_user()
);
create policy "Staff can upload private files" on storage.objects for insert with check (
  bucket_id in ('contracts', 'receipts', 'application-documents') and public.can_write_admin_data()
);

commit;

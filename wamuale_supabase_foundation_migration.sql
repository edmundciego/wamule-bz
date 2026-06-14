-- Wamuale Development - Supabase Foundation Migration
-- Recommended path: supabase/migrations/20260610_wamuale_foundation.sql
-- Stack target: React/Vite frontend + Supabase PostgreSQL backend

begin;

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
do $$ begin
  create type public.app_role as enum ('Admin', 'Staff', 'Read Only');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.parcel_zoning as enum ('Residential', 'Commercial', 'Green Space');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.parcel_status as enum ('Available', 'Reserved', 'Sold');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.application_status as enum ('Pending Review', 'Approved', 'Declined');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.transaction_type as enum ('Down Payment', 'Land Installment', 'Garbage Fee', 'Road Maintenance');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.collection_method as enum ('Cash', 'Online Transfer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.receipt_job_status as enum ('Queued', 'Processing', 'Completed', 'Failed');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- Support table for internal users / roles
-- This is not one of the five core business entities; it supports RLS.
-- -----------------------------------------------------------------------------
create table if not exists public.admin_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role public.app_role not null default 'Staff',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uniq_admin_profiles_email
  on public.admin_profiles(lower(email))
  where email is not null;

-- -----------------------------------------------------------------------------
-- Core Entity 1: Parcels
-- -----------------------------------------------------------------------------
create table if not exists public.parcels (
  id bigint generated always as identity primary key,
  lot_number text not null,
  dimensions text not null default '75x100 ft',
  zoning public.parcel_zoning not null default 'Residential',
  status public.parcel_status not null default 'Available',
  base_price numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint parcels_lot_number_unique unique (lot_number),
  constraint parcels_base_price_nonnegative check (base_price >= 0)
);

create index if not exists idx_parcels_lot_number on public.parcels(lot_number);
create index if not exists idx_parcels_status on public.parcels(status);

-- -----------------------------------------------------------------------------
-- Core Entity 2: Applications
-- -----------------------------------------------------------------------------
create table if not exists public.applications (
  id bigint generated always as identity primary key,
  first_name text not null,
  last_name text not null,
  phone text not null,
  email text,
  parcel_id bigint references public.parcels(id) on delete restrict,
  cultural_preservation_review text,
  sustainability_terms_verified boolean not null default false,
  status public.application_status not null default 'Pending Review',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint applications_email_basic_format check (
    email is null or email ~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$'
  )
);

create index if not exists idx_applications_status on public.applications(status);
create index if not exists idx_applications_parcel_id on public.applications(parcel_id);
create index if not exists idx_applications_created_at on public.applications(created_at desc);

-- -----------------------------------------------------------------------------
-- Core Entity 3: Customers
-- -----------------------------------------------------------------------------
create table if not exists public.customers (
  id bigint generated always as identity primary key,
  application_id bigint not null references public.applications(id) on delete restrict,
  first_name text not null,
  last_name text not null,
  phone text not null,
  email text,
  address text,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customers_application_unique unique (application_id),
  constraint customers_email_basic_format check (
    email is null or email ~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$'
  )
);

create index if not exists idx_customers_name on public.customers(last_name, first_name);
create index if not exists idx_customers_phone on public.customers(phone);

-- -----------------------------------------------------------------------------
-- Core Entity 4: Contracts
-- -----------------------------------------------------------------------------
create table if not exists public.contracts (
  id bigint generated always as identity primary key,
  customer_id bigint not null references public.customers(id) on delete restrict,
  parcel_id bigint not null references public.parcels(id) on delete restrict,
  final_purchase_price numeric(12,2) not null,
  initial_deposit numeric(12,2) not null default 0,
  term_months integer not null,
  monthly_payment numeric(12,2) generated always as (
    round(((final_purchase_price - initial_deposit) / term_months)::numeric, 2)
  ) stored,
  start_date date not null default current_date,
  payment_due_day integer not null default 1,
  signed_contract_file_path text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint contracts_final_price_positive check (final_purchase_price > 0),
  constraint contracts_initial_deposit_nonnegative check (initial_deposit >= 0),
  constraint contracts_initial_deposit_not_over_price check (initial_deposit <= final_purchase_price),
  constraint contracts_term_months_valid check (term_months between 1 and 60),
  constraint contracts_due_day_valid check (payment_due_day between 1 and 28)
);

create index if not exists idx_contracts_customer_id on public.contracts(customer_id);
create index if not exists idx_contracts_parcel_id on public.contracts(parcel_id);
create index if not exists idx_contracts_is_active on public.contracts(is_active);
create unique index if not exists uniq_active_contract_per_parcel
  on public.contracts(parcel_id)
  where is_active = true;

-- -----------------------------------------------------------------------------
-- Core Entity 5: Transactions
-- -----------------------------------------------------------------------------
create table if not exists public.transactions (
  id bigint generated always as identity primary key,
  receipt_number text generated always as ('WD-' || lpad(id::text, 8, '0')) stored,
  customer_id bigint not null references public.customers(id) on delete restrict,
  contract_id bigint references public.contracts(id) on delete restrict,
  amount numeric(12,2) not null,
  transaction_type public.transaction_type not null,
  collection_method public.collection_method not null,
  bank_reference text,
  authorized_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  receipt_file_path text,
  manual_receipt_number text,
  receipt_date date,
  receipt_issued_by text,
  receipt_notes text,
  notes text,
  created_at timestamptz not null default now(),

  constraint transactions_amount_positive check (amount > 0),
  constraint transactions_online_reference_required check (
    (collection_method = 'Online Transfer' and bank_reference is not null and length(trim(bank_reference)) > 0)
    or
    (collection_method = 'Cash')
  ),
  constraint transactions_land_types_require_contract check (
    (transaction_type in ('Down Payment', 'Land Installment') and contract_id is not null)
    or
    (transaction_type in ('Garbage Fee', 'Road Maintenance'))
  )
);

create index if not exists idx_transactions_customer_id on public.transactions(customer_id);
create index if not exists idx_transactions_contract_id on public.transactions(contract_id);
create index if not exists idx_transactions_created_at on public.transactions(created_at desc);
create index if not exists idx_transactions_transaction_type on public.transactions(transaction_type);
create index if not exists idx_transactions_manual_receipt_number on public.transactions(manual_receipt_number);
create unique index if not exists uniq_transactions_bank_reference
  on public.transactions(bank_reference)
  where bank_reference is not null;

-- -----------------------------------------------------------------------------
-- Support table: Payment documents
-- Stores private supporting files for bank proofs, receipt photos, and notes.
-- -----------------------------------------------------------------------------
create table if not exists public.payment_documents (
  id bigint generated always as identity primary key,
  transaction_id bigint references public.transactions(id) on delete set null,
  customer_id bigint not null references public.customers(id) on delete restrict,
  document_type text not null,
  file_path text not null,
  original_file_name text not null,
  uploaded_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),

  constraint payment_documents_document_type_valid check (
    document_type in ('Bank Transfer Proof', 'Manual Receipt Photo', 'Signed Payment Note', 'Other')
  )
);

create index if not exists idx_payment_documents_transaction_id on public.payment_documents(transaction_id);
create index if not exists idx_payment_documents_customer_id on public.payment_documents(customer_id);

-- -----------------------------------------------------------------------------
-- Support table: Payment requests
-- Collections-facing requests for account follow-up. No emails are sent here.
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- Support tables: Business configuration and installment plans
-- Sectioned settings keep Wamuale Phase 1 configurable without full multi-project support.
-- -----------------------------------------------------------------------------
create table if not exists public.business_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.installment_plans (
  id bigint generated always as identity primary key,
  name text not null unique,
  description text,
  reservation_fee numeric(12,2) not null default 0,
  final_purchase_price numeric(12,2) not null default 0,
  term_months integer not null default 1,
  monthly_payment numeric(12,2) not null default 0,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint installment_plans_reservation_fee_nonnegative check (reservation_fee >= 0),
  constraint installment_plans_final_price_nonnegative check (final_purchase_price >= 0),
  constraint installment_plans_term_positive check (term_months > 0),
  constraint installment_plans_monthly_nonnegative check (monthly_payment >= 0)
);

create index if not exists idx_installment_plans_active_sort on public.installment_plans(is_active, sort_order);

insert into public.business_settings (key, value)
values
  ('company_profile', '{"company_name":"Wamuale Development","logo_url":"/favicon/android-chrome-192x192.png","contact_email":"","phone_number":"","website":"","location_address":"Mile 3, Hummingbird Highway, Dangriga Town, Belize","short_description":"Private subdivision land development in Dangriga Town, Belize."}'::jsonb),
  ('public_application', '{"applications_open":true,"public_notice_text":"Submission of this application is solely a request to be considered for the purchase of a lot within Wamuale Development.","application_acknowledgment_text":"By signing this application, I acknowledge and understand that submission does not guarantee approval or allocation of a lot.","show_lot_prices_publicly":true,"show_available_lot_count_publicly":true,"default_confirmation_message":"Application submitted. A Wamuale Development representative will contact you after review."}'::jsonb),
  ('payment_settings', '{"accepted_payment_methods":"Cash, Online Transfer","bank_name":"","account_name":"","account_number":"","payment_instructions":"","manual_receipt_book_required":true,"receipt_number_instructions":"Record the physical receipt book number after payment is received."}'::jsonb),
  ('lot_phase', '{"phase_name":"Phase 1","default_lot_size":"65 x 101 or 75 x 101 ft","default_lot_price":25000,"public_availability_display":true}'::jsonb)
on conflict (key) do nothing;

insert into public.installment_plans (name, description, reservation_fee, final_purchase_price, term_months, monthly_payment, is_active, sort_order)
values
  ('Installment Plan - 36 months', '$2,500 reservation fee, $625.00 monthly', 2500, 25000, 36, 625, true, 10),
  ('Installment Plan - 48 months', '$2,500 reservation fee, $470.00 monthly', 2500, 25000, 48, 470, true, 20),
  ('Installment Plan - 60 months', '$2,500 reservation fee, $375.00 monthly', 2500, 25000, 60, 375, true, 30),
  ('Paid in Full', '$2,500 reservation fee, remaining balance due at purchase agreement', 2500, 25000, 1, 0, true, 40),
  ('Other Agreement / Custom Terms', 'Use custom deposit, price, and term', 0, 0, 1, 0, true, 50)
on conflict (name) do nothing;

-- -----------------------------------------------------------------------------
-- Support table: Community fee settings
-- Keeps the five core entities clean while allowing delinquency calculations.
-- Update amounts when Wamuale decides monthly garbage/road fees.
-- -----------------------------------------------------------------------------
create table if not exists public.community_fee_settings (
  id boolean primary key default true,
  garbage_fee_amount numeric(12,2) not null default 0,
  road_maintenance_amount numeric(12,2) not null default 0,
  due_day integer not null default 1,
  updated_at timestamptz not null default now(),

  constraint community_fee_settings_singleton check (id = true),
  constraint community_fee_settings_garbage_nonnegative check (garbage_fee_amount >= 0),
  constraint community_fee_settings_road_nonnegative check (road_maintenance_amount >= 0),
  constraint community_fee_settings_due_day_valid check (due_day between 1 and 28)
);

insert into public.community_fee_settings (id, garbage_fee_amount, road_maintenance_amount, due_day)
values (true, 0, 0, 1)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- Support table: Receipt jobs
-- The DB queues receipt generation. A Supabase Edge Function should process rows,
-- generate the PDF, upload it to the receipts bucket, then update transactions.receipt_file_path.
-- -----------------------------------------------------------------------------
create table if not exists public.receipt_jobs (
  id bigint generated always as identity primary key,
  transaction_id bigint not null unique references public.transactions(id) on delete cascade,
  status public.receipt_job_status not null default 'Queued',
  attempts integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_receipt_jobs_status on public.receipt_jobs(status);
create index if not exists idx_receipt_jobs_created_at on public.receipt_jobs(created_at asc);

-- -----------------------------------------------------------------------------
-- Generic updated_at trigger
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_admin_profiles_updated_at on public.admin_profiles;
create trigger trg_admin_profiles_updated_at
before update on public.admin_profiles
for each row execute function public.set_updated_at();

drop trigger if exists trg_parcels_updated_at on public.parcels;
create trigger trg_parcels_updated_at
before update on public.parcels
for each row execute function public.set_updated_at();

drop trigger if exists trg_applications_updated_at on public.applications;
create trigger trg_applications_updated_at
before update on public.applications
for each row execute function public.set_updated_at();

drop trigger if exists trg_customers_updated_at on public.customers;
create trigger trg_customers_updated_at
before update on public.customers
for each row execute function public.set_updated_at();

drop trigger if exists trg_contracts_updated_at on public.contracts;
create trigger trg_contracts_updated_at
before update on public.contracts
for each row execute function public.set_updated_at();

drop trigger if exists trg_receipt_jobs_updated_at on public.receipt_jobs;
create trigger trg_receipt_jobs_updated_at
before update on public.receipt_jobs
for each row execute function public.set_updated_at();

drop trigger if exists trg_payment_requests_updated_at on public.payment_requests;
create trigger trg_payment_requests_updated_at
before update on public.payment_requests
for each row execute function public.set_updated_at();

drop trigger if exists trg_business_settings_updated_at on public.business_settings;
create trigger trg_business_settings_updated_at
before update on public.business_settings
for each row execute function public.set_updated_at();

drop trigger if exists trg_installment_plans_updated_at on public.installment_plans;
create trigger trg_installment_plans_updated_at
before update on public.installment_plans
for each row execute function public.set_updated_at();

drop trigger if exists trg_community_fee_settings_updated_at on public.community_fee_settings;
create trigger trg_community_fee_settings_updated_at
before update on public.community_fee_settings
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Role helper functions for RLS
-- -----------------------------------------------------------------------------
create or replace function public.is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_profiles ap
    where ap.user_id = auth.uid()
      and ap.role = 'Admin'
  );
$$;

create or replace function public.is_internal_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_profiles ap
    where ap.user_id = auth.uid()
      and ap.role in ('Admin', 'Staff', 'Read Only')
  );
$$;

create or replace function public.can_write_admin_data()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_profiles ap
    where ap.user_id = auth.uid()
      and ap.role in ('Admin', 'Staff')
  );
$$;

-- -----------------------------------------------------------------------------
-- Application approval automation
-- When an application is approved:
-- 1. creates a customer
-- 2. reserves the parcel
-- -----------------------------------------------------------------------------
create or replace function public.handle_application_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parcel_status public.parcel_status;
begin
  if new.status = 'Approved'::public.application_status
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then

    select p.status
      into v_parcel_status
    from public.parcels p
    where p.id = new.parcel_id
    for update;

    if not found then
      raise exception 'Cannot approve application %. Parcel % does not exist.', new.id, new.parcel_id;
    end if;

    if v_parcel_status <> 'Available'::public.parcel_status then
      raise exception 'Cannot approve application %. Parcel % is currently %.', new.id, new.parcel_id, v_parcel_status;
    end if;

    insert into public.customers (
      application_id,
      first_name,
      last_name,
      phone,
      email
    ) values (
      new.id,
      new.first_name,
      new.last_name,
      new.phone,
      new.email
    )
    on conflict (application_id) do update set
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      phone = excluded.phone,
      email = excluded.email,
      updated_at = now();

    update public.parcels
      set status = 'Reserved'::public.parcel_status,
          updated_at = now()
    where id = new.parcel_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_application_approval on public.applications;
create trigger trg_application_approval
before insert or update of status on public.applications
for each row
execute function public.handle_application_approval();

-- -----------------------------------------------------------------------------
-- Contract validation + parcel status update
-- -----------------------------------------------------------------------------
create or replace function public.validate_contract_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parcel_status public.parcel_status;
  v_application_parcel_id bigint;
begin
  if new.term_months > 60 then
    raise exception 'Contract term cannot exceed 60 months.';
  end if;

  select p.status
    into v_parcel_status
  from public.parcels p
  where p.id = new.parcel_id
  for update;

  if not found then
    raise exception 'Parcel % does not exist.', new.parcel_id;
  end if;

  if tg_op = 'INSERT' and v_parcel_status = 'Sold'::public.parcel_status then
    raise exception 'Cannot create contract. Parcel % is already Sold.', new.parcel_id;
  end if;

  select a.parcel_id
    into v_application_parcel_id
  from public.customers c
  join public.applications a on a.id = c.application_id
  where c.id = new.customer_id;

  if not found then
    raise exception 'Customer % does not exist or is not linked to an application.', new.customer_id;
  end if;

  if v_application_parcel_id <> new.parcel_id then
    raise exception 'Contract parcel does not match customer approved application parcel.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_contract_write on public.contracts;
create trigger trg_validate_contract_write
before insert or update on public.contracts
for each row
execute function public.validate_contract_write();

create or replace function public.mark_parcel_sold_after_contract()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_active = true then
    update public.parcels
      set status = 'Sold'::public.parcel_status,
          updated_at = now()
    where id = new.parcel_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_mark_parcel_sold_after_contract on public.contracts;
create trigger trg_mark_parcel_sold_after_contract
after insert or update of is_active on public.contracts
for each row
execute function public.mark_parcel_sold_after_contract();

-- -----------------------------------------------------------------------------
-- Transaction validation
-- -----------------------------------------------------------------------------
create or replace function public.validate_transaction_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract_customer_id bigint;
begin
  if new.bank_reference is not null then
    new.bank_reference = nullif(upper(trim(new.bank_reference)), '');
  end if;

  if new.collection_method = 'Online Transfer'::public.collection_method
     and new.bank_reference is null then
    raise exception 'Bank reference is required for online transfer payments.';
  end if;

  if new.collection_method = 'Cash'::public.collection_method then
    new.bank_reference = null;
  end if;

  if new.transaction_type in ('Down Payment'::public.transaction_type, 'Land Installment'::public.transaction_type)
     and new.contract_id is null then
    raise exception 'Land payment transactions require a contract.';
  end if;

  if new.contract_id is not null then
    select c.customer_id
      into v_contract_customer_id
    from public.contracts c
    where c.id = new.contract_id;

    if not found then
      raise exception 'Contract % does not exist.', new.contract_id;
    end if;

    if v_contract_customer_id <> new.customer_id then
      raise exception 'Transaction customer does not match the selected contract customer.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_transaction_write on public.transactions;
create trigger trg_validate_transaction_write
before insert or update on public.transactions
for each row
execute function public.validate_transaction_write();

-- -----------------------------------------------------------------------------
-- Queue receipt generation after every transaction insert
-- -----------------------------------------------------------------------------
create or replace function public.queue_receipt_generation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.receipt_jobs (transaction_id)
  values (new.id)
  on conflict (transaction_id) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_queue_receipt_generation on public.transactions;
create trigger trg_queue_receipt_generation
after insert on public.transactions
for each row
execute function public.queue_receipt_generation();

-- -----------------------------------------------------------------------------
-- Helper function for reports
-- Counts how many monthly due dates have passed since a start date.
-- -----------------------------------------------------------------------------
create or replace function public.months_due_since(
  p_start_date date,
  p_due_day integer,
  p_as_of date default current_date
)
returns integer
language plpgsql
stable
as $$
declare
  v_months integer;
begin
  if p_as_of < p_start_date then
    return 0;
  end if;

  v_months :=
    ((extract(year from p_as_of)::integer - extract(year from p_start_date)::integer) * 12)
    + (extract(month from p_as_of)::integer - extract(month from p_start_date)::integer);

  if extract(day from p_as_of)::integer >= p_due_day then
    v_months := v_months + 1;
  end if;

  return greatest(v_months, 0);
end;
$$;

-- -----------------------------------------------------------------------------
-- Views: public parcel options, board data, balances, reports
-- -----------------------------------------------------------------------------
create or replace view public.public_parcel_options as
select
  id,
  lot_number,
  dimensions,
  zoning,
  status,
  base_price
from public.parcels
where status in ('Available'::public.parcel_status, 'Reserved'::public.parcel_status)
order by lot_number;

create or replace view public.parcel_board_view as
select
  p.id,
  p.lot_number,
  p.dimensions,
  p.zoning,
  p.status,
  p.base_price,
  c.id as contract_id,
  cu.id as customer_id,
  trim(cu.first_name || ' ' || cu.last_name) as customer_name,
  c.is_active as contract_is_active
from public.parcels p
left join public.contracts c
  on c.parcel_id = p.id
 and c.is_active = true
left join public.customers cu
  on cu.id = c.customer_id
order by p.lot_number;

create or replace view public.contract_balances as
select
  c.id as contract_id,
  c.customer_id,
  c.parcel_id,
  c.final_purchase_price,
  c.initial_deposit,
  c.term_months,
  c.monthly_payment,
  c.start_date,
  c.payment_due_day,
  c.is_active,
  coalesce(sum(t.amount) filter (
    where t.transaction_type in ('Down Payment'::public.transaction_type, 'Land Installment'::public.transaction_type)
  ), 0)::numeric(12,2) as total_land_paid,
  greatest(
    c.final_purchase_price - coalesce(sum(t.amount) filter (
      where t.transaction_type in ('Down Payment'::public.transaction_type, 'Land Installment'::public.transaction_type)
    ), 0),
    0
  )::numeric(12,2) as remaining_balance,
  public.months_due_since(c.start_date, c.payment_due_day, current_date) as installment_months_due,
  least(
    c.initial_deposit + (public.months_due_since(c.start_date, c.payment_due_day, current_date) * c.monthly_payment),
    c.final_purchase_price
  )::numeric(12,2) as expected_paid_to_date,
  greatest(
    least(
      c.initial_deposit + (public.months_due_since(c.start_date, c.payment_due_day, current_date) * c.monthly_payment),
      c.final_purchase_price
    ) - coalesce(sum(t.amount) filter (
      where t.transaction_type in ('Down Payment'::public.transaction_type, 'Land Installment'::public.transaction_type)
    ), 0),
    0
  )::numeric(12,2) as overdue_balance
from public.contracts c
left join public.transactions t on t.contract_id = c.id
group by c.id;

create or replace view public.community_fee_account_status as
select
  c.id as contract_id,
  c.customer_id,
  c.parcel_id,
  cfg.garbage_fee_amount,
  cfg.road_maintenance_amount,
  cfg.due_day,
  public.months_due_since(c.start_date, cfg.due_day, current_date) as community_months_due,
  (public.months_due_since(c.start_date, cfg.due_day, current_date) * cfg.garbage_fee_amount)::numeric(12,2) as expected_garbage_fees,
  (public.months_due_since(c.start_date, cfg.due_day, current_date) * cfg.road_maintenance_amount)::numeric(12,2) as expected_road_fees,
  coalesce(sum(t.amount) filter (where t.transaction_type = 'Garbage Fee'::public.transaction_type), 0)::numeric(12,2) as total_garbage_paid,
  coalesce(sum(t.amount) filter (where t.transaction_type = 'Road Maintenance'::public.transaction_type), 0)::numeric(12,2) as total_road_paid,
  greatest(
    (public.months_due_since(c.start_date, cfg.due_day, current_date) * cfg.garbage_fee_amount)
    - coalesce(sum(t.amount) filter (where t.transaction_type = 'Garbage Fee'::public.transaction_type), 0),
    0
  )::numeric(12,2) as garbage_fee_balance,
  greatest(
    (public.months_due_since(c.start_date, cfg.due_day, current_date) * cfg.road_maintenance_amount)
    - coalesce(sum(t.amount) filter (where t.transaction_type = 'Road Maintenance'::public.transaction_type), 0),
    0
  )::numeric(12,2) as road_fee_balance,
  greatest(
    ((public.months_due_since(c.start_date, cfg.due_day, current_date) * cfg.garbage_fee_amount)
    - coalesce(sum(t.amount) filter (where t.transaction_type = 'Garbage Fee'::public.transaction_type), 0))
    +
    ((public.months_due_since(c.start_date, cfg.due_day, current_date) * cfg.road_maintenance_amount)
    - coalesce(sum(t.amount) filter (where t.transaction_type = 'Road Maintenance'::public.transaction_type), 0)),
    0
  )::numeric(12,2) as community_fee_balance
from public.contracts c
cross join public.community_fee_settings cfg
left join public.transactions t
  on t.customer_id = c.customer_id
 and t.created_at::date >= c.start_date
 and t.transaction_type in ('Garbage Fee'::public.transaction_type, 'Road Maintenance'::public.transaction_type)
group by c.id, cfg.id, cfg.garbage_fee_amount, cfg.road_maintenance_amount, cfg.due_day;

create or replace view public.analytics_snapshot as
select
  (select coalesce(sum(amount), 0)::numeric(12,2) from public.transactions) as total_aggregated_revenue,
  (select coalesce(sum(overdue_balance), 0)::numeric(12,2) from public.contract_balances where is_active = true) as overdue_installment_balances,
  (select count(*)::integer from public.community_fee_account_status where community_fee_balance > 0) as active_community_delinquency_accounts;

-- -----------------------------------------------------------------------------
-- Storage buckets
-- Supabase Storage objects still need Edge Function/UI upload code.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('contracts', 'contracts', false, 10485760, array['application/pdf']),
  ('receipts', 'receipts', false, 10485760, array['application/pdf']),
  ('application-documents', 'application-documents', false, 10485760, array['application/pdf','image/jpeg','image/png']),
  ('payment-documents', 'payment-documents', false, 10485760, array['application/pdf','image/jpeg','image/png','image/webp']),
  ('business-assets', 'business-assets', true, 5242880, array['image/png','image/jpeg','image/webp','image/svg+xml'])
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.admin_profiles enable row level security;
alter table public.parcels enable row level security;
alter table public.applications enable row level security;
alter table public.customers enable row level security;
alter table public.contracts enable row level security;
alter table public.transactions enable row level security;
alter table public.payment_documents enable row level security;
alter table public.payment_requests enable row level security;
alter table public.business_settings enable row level security;
alter table public.installment_plans enable row level security;
alter table public.community_fee_settings enable row level security;
alter table public.receipt_jobs enable row level security;

-- Admin profiles policies
drop policy if exists "Admin profiles readable by internal users" on public.admin_profiles;
create policy "Admin profiles readable by internal users"
on public.admin_profiles
for select
to authenticated
using (public.is_internal_user() or user_id = auth.uid());

drop policy if exists "Admin profiles manageable by admins" on public.admin_profiles;
create policy "Admin profiles manageable by admins"
on public.admin_profiles
for all
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

-- Parcels
drop policy if exists "Parcels readable by internal users" on public.parcels;
create policy "Parcels readable by internal users"
on public.parcels
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Parcels writable by admin staff" on public.parcels;
create policy "Parcels writable by admin staff"
on public.parcels
for all
to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

-- Applications
drop policy if exists "Public can submit pending applications" on public.applications;
create policy "Public can submit pending applications"
on public.applications
for insert
to anon, authenticated
with check (status = 'Pending Review'::public.application_status);

drop policy if exists "Applications readable by internal users" on public.applications;
create policy "Applications readable by internal users"
on public.applications
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Applications writable by admin staff" on public.applications;
create policy "Applications writable by admin staff"
on public.applications
for update
to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

drop policy if exists "Applications deletable by admins" on public.applications;
create policy "Applications deletable by admins"
on public.applications
for delete
to authenticated
using (public.is_admin_user());

-- Customers
drop policy if exists "Customers readable by internal users" on public.customers;
create policy "Customers readable by internal users"
on public.customers
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Customers writable by admin staff" on public.customers;
create policy "Customers writable by admin staff"
on public.customers
for all
to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

-- Contracts
drop policy if exists "Contracts readable by internal users" on public.contracts;
create policy "Contracts readable by internal users"
on public.contracts
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Contracts writable by admin staff" on public.contracts;
create policy "Contracts writable by admin staff"
on public.contracts
for all
to authenticated
using (public.can_write_admin_data())
with check (public.can_write_admin_data());

-- Transactions
drop policy if exists "Transactions readable by internal users" on public.transactions;
create policy "Transactions readable by internal users"
on public.transactions
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Transactions writable by admin staff" on public.transactions;
create policy "Transactions writable by admin staff"
on public.transactions
for insert
to authenticated
with check (public.can_write_admin_data());

-- For accounting integrity, updates/deletes are admin-only.
drop policy if exists "Transactions adjustable by admins" on public.transactions;
create policy "Transactions adjustable by admins"
on public.transactions
for update
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

drop policy if exists "Transactions deletable by admins" on public.transactions;
create policy "Transactions deletable by admins"
on public.transactions
for delete
to authenticated
using (public.is_admin_user());

-- Payment documents
drop policy if exists "Payment documents readable by internal users" on public.payment_documents;
create policy "Payment documents readable by internal users"
on public.payment_documents
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Payment documents writable by admin staff" on public.payment_documents;
create policy "Payment documents writable by admin staff"
on public.payment_documents
for insert
to authenticated
with check (public.can_write_admin_data());

drop policy if exists "Payment documents updateable by admins" on public.payment_documents;
create policy "Payment documents updateable by admins"
on public.payment_documents
for update
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

drop policy if exists "Payment documents deletable by admins" on public.payment_documents;
create policy "Payment documents deletable by admins"
on public.payment_documents
for delete
to authenticated
using (public.is_admin_user());

-- Payment requests
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

-- Business settings
drop policy if exists "Business settings readable by internal users" on public.business_settings;
create policy "Business settings readable by internal users"
on public.business_settings
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Public business settings readable by anon" on public.business_settings;
create policy "Public business settings readable by anon"
on public.business_settings
for select
to anon
using (key in ('company_profile', 'public_application', 'lot_phase'));

drop policy if exists "Business settings insertable by admins" on public.business_settings;
create policy "Business settings insertable by admins"
on public.business_settings
for insert
to authenticated
with check (public.is_admin_user());

drop policy if exists "Business settings updateable by admins" on public.business_settings;
create policy "Business settings updateable by admins"
on public.business_settings
for update
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

-- Installment plans
drop policy if exists "Installment plans readable by internal users" on public.installment_plans;
create policy "Installment plans readable by internal users"
on public.installment_plans
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Active installment plans readable by anon" on public.installment_plans;
create policy "Active installment plans readable by anon"
on public.installment_plans
for select
to anon
using (is_active = true);

drop policy if exists "Installment plans writable by admins" on public.installment_plans;
create policy "Installment plans writable by admins"
on public.installment_plans
for all
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

-- Community fee settings
drop policy if exists "Community fee settings readable by internal users" on public.community_fee_settings;
create policy "Community fee settings readable by internal users"
on public.community_fee_settings
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Community fee settings manageable by admins" on public.community_fee_settings;
create policy "Community fee settings manageable by admins"
on public.community_fee_settings
for update
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

-- Receipt jobs
drop policy if exists "Receipt jobs readable by internal users" on public.receipt_jobs;
create policy "Receipt jobs readable by internal users"
on public.receipt_jobs
for select
to authenticated
using (public.is_internal_user());

drop policy if exists "Receipt jobs manageable by admins" on public.receipt_jobs;
create policy "Receipt jobs manageable by admins"
on public.receipt_jobs
for all
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

-- Storage policies
drop policy if exists "Internal users can read Wamuale files" on storage.objects;
create policy "Internal users can read Wamuale files"
on storage.objects
for select
to authenticated
using (
  bucket_id in ('contracts', 'receipts', 'application-documents', 'payment-documents')
  and public.is_internal_user()
);

drop policy if exists "Admin staff can upload Wamuale files" on storage.objects;
create policy "Admin staff can upload Wamuale files"
on storage.objects
for insert
to authenticated
with check (
  bucket_id in ('contracts', 'receipts', 'application-documents', 'payment-documents')
  and public.can_write_admin_data()
);

drop policy if exists "Admins can update Wamuale files" on storage.objects;
create policy "Admins can update Wamuale files"
on storage.objects
for update
to authenticated
using (
  bucket_id in ('contracts', 'receipts', 'application-documents', 'payment-documents')
  and public.is_admin_user()
)
with check (
  bucket_id in ('contracts', 'receipts', 'application-documents', 'payment-documents')
  and public.is_admin_user()
);

drop policy if exists "Admins can delete Wamuale files" on storage.objects;
create policy "Admins can delete Wamuale files"
on storage.objects
for delete
to authenticated
using (
  bucket_id in ('contracts', 'receipts', 'application-documents', 'payment-documents')
  and public.is_admin_user()
);

drop policy if exists "Business assets readable publicly" on storage.objects;
create policy "Business assets readable publicly"
on storage.objects
for select
to public
using (bucket_id = 'business-assets');

drop policy if exists "Business assets managed by admins" on storage.objects;
create policy "Business assets managed by admins"
on storage.objects
for all
to authenticated
using (bucket_id = 'business-assets' and public.is_admin_user())
with check (bucket_id = 'business-assets' and public.is_admin_user());

-- -----------------------------------------------------------------------------
-- Grants for Supabase API roles
-- RLS policies still decide what rows can be accessed.
-- -----------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

grant select on public.public_parcel_options to anon, authenticated;
grant insert on public.applications to anon;

grant select on public.parcel_board_view to authenticated;
grant select on public.contract_balances to authenticated;
grant select on public.community_fee_account_status to authenticated;
grant select on public.analytics_snapshot to authenticated;

grant select, insert, update, delete on public.admin_profiles to authenticated;
grant select, insert, update, delete on public.parcels to authenticated;
grant select, insert, update, delete on public.applications to authenticated;
grant select, insert, update, delete on public.customers to authenticated;
grant select, insert, update, delete on public.contracts to authenticated;
grant select, insert, update, delete on public.transactions to authenticated;
grant select, insert, update, delete on public.payment_documents to authenticated;
grant select, insert, update, delete on public.payment_requests to authenticated;
grant select, insert, update on public.business_settings to authenticated;
grant select on public.business_settings to anon;
grant select, insert, update, delete on public.installment_plans to authenticated;
grant select on public.installment_plans to anon;
grant select, insert, update, delete on public.community_fee_settings to authenticated;
grant select, insert, update, delete on public.receipt_jobs to authenticated;

grant usage, select on all sequences in schema public to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Seed Phase 1 parcels: exactly 24 lots, 75x100 ft by default.
-- Set base_price later through the admin UI or SQL updates.
-- -----------------------------------------------------------------------------
insert into public.parcels (lot_number, zoning, status, base_price)
select
  'LOT-' || lpad(gs::text, 2, '0') as lot_number,
  'Residential'::public.parcel_zoning as zoning,
  'Available'::public.parcel_status as status,
  0::numeric(12,2) as base_price
from generate_series(1, 24) as gs
on conflict (lot_number) do nothing;

commit;

-- -----------------------------------------------------------------------------
-- FIRST ADMIN SETUP - run after the first admin signs up in Supabase Auth:
-- Replace the UUID with the user's auth.users.id value.
-- -----------------------------------------------------------------------------
-- insert into public.admin_profiles (user_id, full_name, role)
-- values ('00000000-0000-0000-0000-000000000000', 'Edmund Ciego', 'Admin')
-- on conflict (user_id) do update set role = 'Admin', full_name = excluded.full_name;
